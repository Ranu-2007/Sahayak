import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { z } from 'zod';
import EmergencyRequest from '../models/EmergencyRequest.js';
import Provider from '../models/Provider.js';
import Incident from '../models/Incident.js';
import { authenticate } from '../middleware/auth.js';
import { audit } from '../services/record.js';
import { refreshIncidentStats } from '../services/incidents.js';

const router = Router();
const defaultStorage = fileURLToPath(new URL('../../private-evidence/', import.meta.url));
const storageDir = path.resolve(process.env.EVIDENCE_STORAGE_DIR || defaultStorage);
const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter(_req, file, callback) {
    callback(allowedTypes.has(file.mimetype) ? null : new Error('Only JPEG, PNG, or WebP photos are accepted.'), allowedTypes.has(file.mimetype));
  },
});
const parsePhotos = (req, res, next) => upload.array('photos', 5)(req, res, error => {
  if (!error) return next();
  const message = error.code === 'LIMIT_FILE_SIZE' ? 'Each video must be 10 MB or smaller; photos must be 5 MB or smaller.' : error.code === 'LIMIT_FILE_COUNT' ? 'Upload at most 5 evidence files.' : error.message;
  return res.status(400).json({ message });
});

router.post('/:id/evidence', authenticate, parsePhotos, async (req, res, next) => {
  const storedPaths = [];
  let metadataSaved = false;
  try {
    if (!req.files?.length) return res.status(400).json({ message: 'Choose at least one photo.' });
    const request = await EmergencyRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Complaint not found.' });
    if (!canManageComplaint(request, req.user)) return res.status(403).json({ message: 'Only the reporter or an authorized coordinator can add evidence.' });
    let clientFileIds = [];
    if (req.body.clientFileIds) {
      try { clientFileIds = z.array(z.string().uuid()).max(5).parse(JSON.parse(req.body.clientFileIds)); }
      catch { return res.status(400).json({ message: 'Evidence upload identifiers are invalid.' }); }
      if (clientFileIds.length !== req.files.length || new Set(clientFileIds).size !== clientFileIds.length) return res.status(400).json({ message: 'Each evidence file must have a unique upload identifier.' });
    }
    const alreadyUploaded = new Set(request.evidence.map(file => file.clientFileId).filter(Boolean));
    const pendingFiles = req.files.map((file, index) => ({ file, clientFileId: clientFileIds[index] })).filter(item => !item.clientFileId || !alreadyUploaded.has(item.clientFileId));
    if (!pendingFiles.length) return res.status(200).json({ message: 'Evidence was already synchronized.', evidenceCount: request.evidence.length, duplicate: true });
    if (request.evidence.length + pendingFiles.length > 5) return res.status(400).json({ message: 'A complaint can have at most 5 evidence files.' });
    if (pendingFiles.some(({ file }) => (file.mimetype.startsWith('image/') && file.size > 5 * 1024 * 1024) || !hasValidMediaSignature(file.buffer, file.mimetype))) return res.status(400).json({ message: 'Evidence must be a valid JPEG/PNG/WebP photo (5 MB max) or MP4/WebM video (10 MB max).' });
    if (pendingFiles.reduce((total, item) => total + item.file.size, 0) + request.evidence.reduce((total, file) => total + file.size, 0) > 25 * 1024 * 1024) return res.status(400).json({ message: 'Evidence for one complaint must total 25 MB or less.' });

    const metadata = [];
    await fs.promises.mkdir(storageDir, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(storageDir, 0o700).catch(() => {});
    for (const { file, clientFileId } of pendingFiles) {
      const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm' }[file.mimetype];
      const storageKey = `${randomUUID()}${extension}`;
      const fullPath = path.join(storageDir, storageKey);
      await fs.promises.writeFile(fullPath, file.buffer, { flag: 'wx', mode: 0o600 });
      storedPaths.push(fullPath);
      metadata.push({ clientFileId, storageKey, mediaType: file.mimetype, size: file.size, originalName: safeFilename(file.originalname), uploadedBy: req.user._id, uploadedAt: new Date() });
    }
    request.evidence.push(...metadata);
    await request.save();
    if (request.incidentId) await refreshIncidentStats(request.incidentId);
    metadataSaved = true;
    await audit(req, 'request.evidence_added', 'EmergencyRequest', request.id, { count: metadata.length });
    res.status(201).json({ message: 'Evidence added. Files are private to the reporter and authorized coordinators.', evidence: request.evidence.slice(-metadata.length).map(publicEvidence), evidenceCount: request.evidence.length });
  } catch (error) {
    if (!metadataSaved) await Promise.all(storedPaths.map(file => fs.promises.rm(file, { force: true }).catch(() => {})));
    next(error);
  }
});

router.get('/:id/evidence/:evidenceId', authenticate, async (req, res, next) => {
  try {
    const request = await EmergencyRequest.findById(req.params.id).select('reportedBy evidence');
    if (!request) return res.status(404).json({ message: 'Complaint not found.' });
    if (!canManageComplaint(request, req.user) && !await canViewAsVerifiedResponder(request, req.user)) return res.status(403).json({ message: 'Evidence is private to the reporter, verified incident responders, and authorized coordinators.' });
    const file = request.evidence.id(req.params.evidenceId);
    if (!file) return res.status(404).json({ message: 'Photo evidence not found.' });
    const fullPath = path.join(storageDir, path.basename(file.storageKey));
    if (!fs.existsSync(fullPath)) return res.status(404).json({ message: 'Photo evidence file is unavailable.' });
    res.set({ 'Content-Type': file.mediaType, 'Content-Length': file.size, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    fs.createReadStream(fullPath).on('error', next).pipe(res);
  } catch (error) { next(error); }
});

router.post('/:id/confirmations', authenticate, async (req, res, next) => {
  try {
    const { latitude, longitude, action } = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), action: z.enum(['confirm_issue', 'also_affected', 'issue_not_found', 'problem_resolved']).default('confirm_issue') }).strict().parse(req.body);
    const request = await EmergencyRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Complaint not found.' });
    if (!request.location?.coordinatesAuthorized || !validCoordinates(request.location.coordinates)) return res.status(409).json({ message: 'Nearby confirmation is unavailable because this report has no shared coordinates.' });
    const distanceMeters = distanceBetween([longitude, latitude], request.location.coordinates);
    if (distanceMeters > 2000) return res.status(403).json({ message: 'Confirmation is limited to users reporting within 2 km of this complaint.' });
    const updated = await EmergencyRequest.updateOne(
      { _id: request._id, 'communityConfirmations.user': { $ne: req.user._id } },
      { $push: { communityConfirmations: { user: req.user._id, action, coordinates: [longitude, latitude], createdAt: new Date() } } },
    );
    if (!updated.modifiedCount) return res.status(409).json({ message: 'You have already submitted community feedback for this complaint.' });
    const saved = await EmergencyRequest.findById(request._id).select('verification communityConfirmations');
    if (request.incidentId) await refreshIncidentStats(request.incidentId);
    await audit(req, 'request.community_confirmed', 'EmergencyRequest', request.id, { distanceMeters: Math.round(distanceMeters) });
    const communityFeedback = feedbackCounts(saved.communityConfirmations);
    const confirmationCount = saved.communityConfirmations.length;
    res.status(201).json({ message: 'Your nearby feedback was recorded.', complaintId: request.id, action, confirmationCount, communityFeedback, verificationStatus: verificationStatus(saved), notice: 'Community feedback is a supporting signal, not proof or official verification. It does not change complaint status.' });
  } catch (error) { next(error); }
});

router.get('/groups', authenticate, async (req, res, next) => {
  try {
    const coordinates = z.object({ latitude: z.coerce.number().min(-90).max(90), longitude: z.coerce.number().min(-180).max(180) }).partial().strict().safeParse(req.query);
    if (!coordinates.success) return res.status(400).json({ message: 'Latitude and longitude must be valid decimal coordinates.' });
    const hasCenter = coordinates.data.latitude !== undefined && coordinates.data.longitude !== undefined;
    if ((coordinates.data.latitude === undefined) !== (coordinates.data.longitude === undefined)) return res.status(400).json({ message: 'Provide both latitude and longitude, or neither.' });
    const radiusMeters = Math.max(100, Math.min(50000, Number.parseInt(req.query.radiusMeters, 10) || 10000));
    const candidates = hasCenter
      ? await EmergencyRequest.find({ 'location.coordinatesAuthorized': true, 'location.coordinates': { $near: { $geometry: { type: 'Point', coordinates: [coordinates.data.longitude, coordinates.data.latitude] }, $maxDistance: radiusMeters } }, status: { $nin: ['duplicate', 'cancelled'] } }).sort({ createdAt: -1 }).limit(500).lean()
      : await EmergencyRequest.find({ status: { $nin: ['duplicate', 'cancelled'] } }).sort({ createdAt: -1 }).limit(500).lean();
    const groups = groupComplaints(candidates, req.user);
    res.json({ message: 'Complaints grouped by matching category and reports within 500 m.', groupingRadiusMeters: 500, searchRadiusMeters: hasCenter ? radiusMeters : null, groupCount: groups.length, groups });
  } catch (error) { next(error); }
});

export function verificationStatus(request) {
  if (request.verification?.state === 'verified') return 'officially verified';
  const feedback = feedbackCounts(request.communityConfirmations);
  if (feedback.confirm_issue + feedback.also_affected >= 3) return 'community supported';
  return 'unverified';
}
export function feedbackCounts(responses = []) {
  return responses.reduce((counts, response) => {
    const action = response.action || 'confirm_issue';
    if (Object.hasOwn(counts, action)) counts[action] += 1;
    return counts;
  }, { confirm_issue: 0, also_affected: 0, issue_not_found: 0, problem_resolved: 0 });
}
export function publicEvidence(file) {
  return { _id: file._id, mediaType: file.mediaType, size: file.size, originalName: file.originalName, uploadedAt: file.uploadedAt };
}
function canManageComplaint(request, user) { return ['coordinator', 'admin'].includes(user.role) || String(request.reportedBy) === String(user._id); }
async function canViewAsVerifiedResponder(request, user) {
  if (user.role !== 'provider' || !request.incidentId) return false;
  const provider = await Provider.findOne({ owner: user._id, verificationStatus: 'verified' }).select('_id');
  return Boolean(provider && await Incident.exists({ _id: request.incidentId, $or: [{ status: 'active' }, { responders: { $elemMatch: { provider: provider._id, status: { $ne: 'withdrawn' } } } }] }));
}
function safeFilename(name) { return path.basename(String(name || 'photo')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'photo'; }
function validCoordinates(coordinates) { return Array.isArray(coordinates) && coordinates.length === 2 && coordinates.every(Number.isFinite); }
function hasValidMediaSignature(buffer, type) {
  if (type === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (type === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (type === 'video/mp4') return buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
  if (type === 'video/webm') return buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}
function distanceBetween([lon1, lat1], [lon2, lat2]) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(lat2 - lat1), dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function groupComplaints(complaints, viewer) {
  const groups = [];
  for (const complaint of complaints) {
    const point = complaint.location?.coordinates;
    const located = complaint.location?.coordinatesAuthorized && validCoordinates(point);
    let group = located && groups.find(candidate => candidate.category.toLowerCase() === complaint.category.toLowerCase() && candidate.center && distanceBetween(candidate.center, point) <= 500);
    if (!group) {
      group = { category: complaint.category, center: located ? point : null, complaints: [] };
      groups.push(group);
    }
    const canViewEvidence = canManageComplaint(complaint, viewer);
    group.complaints.push({ _id: complaint._id, requestId: complaint.requestId, category: complaint.category, urgency: complaint.urgency, createdAt: complaint.createdAt, confirmationCount: complaint.communityConfirmations?.length || 0, communityFeedback: feedbackCounts(complaint.communityConfirmations), viewerCommunityAction: (() => { const response = complaint.communityConfirmations?.find(item => String(item.user) === String(viewer._id)); return response ? response.action || 'confirm_issue' : null; })(), verificationStatus: verificationStatus(complaint), location: { coordinatesAuthorized: Boolean(complaint.location?.coordinatesAuthorized) }, evidence: canViewEvidence ? (complaint.evidence || []).map(file => ({ _id: file._id, mediaType: file.mediaType, size: file.size, uploadedAt: file.uploadedAt })) : [] });
  }
  return groups.map(({ category, complaints: members }) => ({ category, count: members.length, duplicateCandidate: members.length > 1, complaints: members }));
}
export default router;
