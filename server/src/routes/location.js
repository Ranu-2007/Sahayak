import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import EmergencyRequest from '../models/EmergencyRequest.js';
import Incident from '../models/Incident.js';
import Provider from '../models/Provider.js';
import LiveLocationSession from '../models/LiveLocationSession.js';
import AuditLog from '../models/AuditLog.js';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { publishPrivateEvent } from '../services/liveEvents.js';

const router = Router();
const coordinates = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const pointInput = z.object({ coordinates, accuracyMeters: z.number().min(0).max(100000), source: z.enum(['gps', 'manual']).default('gps') }).strict();

async function accessFor(req, report) {
  if (String(report.reportedBy) === String(req.user._id)) return { owner: true, viewers: [String(req.user._id)] };
  if (['coordinator', 'admin'].includes(req.user.role)) return { owner: false, viewers: [String(req.user._id)] };
  if (req.user.role !== 'provider' || !report.incidentId) return null;
  const provider = await Provider.findOne({ owner: req.user._id, verificationStatus: 'verified' }).select('_id');
  if (!provider) return null;
  const incident = await Incident.findById(report.incidentId).select('responders status');
  const responder = incident?.responders?.find(row => String(row.provider) === String(provider._id) && ['claimed', 'preparing_assistance', 'on_the_way', 'reached_location', 'assistance_in_progress', 'partially_resolved'].includes(row.status));
  if (!responder || incident.status !== 'active') return null;
  const activeStatuses = ['claimed', 'preparing_assistance', 'on_the_way', 'reached_location', 'assistance_in_progress', 'partially_resolved'];
  const userIds = await Provider.distinct('owner', { _id: { $in: incident.responders.filter(row => activeStatuses.includes(row.status)).map(row => row.provider) }, verificationStatus: 'verified' });
  return { owner: false, viewers: userIds.map(String), incident };
}

async function activeSession(report) {
  const session = await LiveLocationSession.findOne({ report: report._id, status: 'active' }).sort({ startedAt: -1 });
  if (session && ['fulfilled', 'cancelled', 'duplicate'].includes(report.status)) {
    session.status = 'stopped'; session.stoppedAt = new Date(); await session.save();
    publishPrivateEvent([report.reportedBy], 'live-location-stopped', { reportId: String(report._id), sessionId: String(session._id), stoppedAt: session.stoppedAt });
    return null;
  }
  if (session && session.expiresAt <= new Date()) {
    session.status = 'expired'; session.stoppedAt = new Date(); await session.save();
    const access = await accessFor({ user: { _id: report.reportedBy, role: 'requester' } }, report);
    publishPrivateEvent(access?.viewers || [], 'live-location-expired', { reportId: String(report._id), sessionId: String(session._id) });
    return null;
  }
  return session;
}

function publicSession(session) {
  if (!session) return null;
  const isStale = session.status === 'active' && (!session.lastUpdatedAt || Date.now() - new Date(session.lastUpdatedAt).getTime() > 90000);
  return { sessionId: String(session._id), reportId: String(session.report), incidentId: session.incident ? String(session.incident) : null, status: isStale ? 'stale' : session.status, startedAt: session.startedAt, expiresAt: session.expiresAt, lastUpdatedAt: session.lastUpdatedAt, location: session.lastLocation ? { coordinates: session.lastLocation.coordinates, accuracyMeters: session.accuracyMeters, source: session.source } : null };
}

async function auditLocationView(req, report, session, access) {
  if (!session || access.owner || ['coordinator', 'admin'].includes(req.user.role)) return;
  const recentlyLogged = await AuditLog.exists({ actorId: req.user._id, targetType: 'EmergencyRequest', targetId: report._id, action: 'location.live_viewed', createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) } });
  if (!recentlyLogged) await AuditLog.create({ actor: req.user._id, action: 'location.live_viewed', targetType: 'EmergencyRequest', targetId: report._id, details: { sessionId: String(session._id) } });
}

router.post('/live/start', authenticate, allowRoles('requester'), async (req, res, next) => {
  try {
    const input = z.object({ reportId: z.string().refine(mongoose.isValidObjectId), durationMinutes: z.union([z.literal(15), z.literal(30), z.literal(60), z.literal(0)]), location: pointInput }).strict().parse(req.body);
    const report = await EmergencyRequest.findOne({ _id: input.reportId, reportedBy: req.user._id }).select('_id reportedBy incidentId status');
    if (!report) return res.status(404).json({ message: 'Report not found.' });
    if (['fulfilled', 'cancelled', 'duplicate'].includes(report.status)) return res.status(409).json({ message: 'Live location cannot be started for a closed report.' });
    if (report.incidentId) { const incident = await Incident.findById(report.incidentId).select('status'); if (!incident || incident.status !== 'active') return res.status(409).json({ message: 'Live location is only available while the linked incident is active.' }); }
    const otherActiveSession = await LiveLocationSession.findOne({ requester: req.user._id, status: 'active', report: { $ne: report._id } }).select('_id report');
    if (otherActiveSession) return res.status(409).json({ message: 'Stop the live location session for your other emergency report before starting a new one.' });
    const previous = await LiveLocationSession.findOne({ report: report._id, status: 'active' });
    if (previous) { previous.status = 'stopped'; previous.stoppedAt = new Date(); await previous.save(); }
    const now = new Date();
    const session = await LiveLocationSession.create({ requester: req.user._id, report: report._id, incident: report.incidentId, status: 'active', startedAt: now, expiresAt: input.durationMinutes ? new Date(now.getTime() + input.durationMinutes * 60000) : new Date(now.getTime() + 12 * 60 * 60 * 1000), lastUpdatedAt: now, lastLocation: { type: 'Point', coordinates: input.location.coordinates }, accuracyMeters: input.location.accuracyMeters, source: input.location.source });
    const access = await accessFor(req, report);
    await AuditLog.create({ actor: req.user._id, action: 'location.live_started', targetType: 'EmergencyRequest', targetId: report._id, details: { sessionId: String(session._id), expiresAt: session.expiresAt } });
    publishPrivateEvent(access?.viewers || [], 'live-location-started', { reportId: String(report._id), session: publicSession(session) });
    res.status(201).json({ session: publicSession(session) });
  } catch (error) { next(error); }
});

router.post('/live/update', authenticate, allowRoles('requester'), async (req, res, next) => {
  try {
    const input = z.object({ sessionId: z.string().refine(mongoose.isValidObjectId), location: pointInput }).strict().parse(req.body);
    const session = await LiveLocationSession.findOne({ _id: input.sessionId, requester: req.user._id, status: 'active' });
    if (!session) return res.status(404).json({ message: 'Active location-sharing session not found.' });
    if (session.expiresAt <= new Date()) { session.status = 'expired'; session.stoppedAt = new Date(); await session.save(); return res.status(410).json({ message: 'Location-sharing session has expired.' }); }
    const report = await EmergencyRequest.findOne({ _id: session.report, reportedBy: req.user._id }).select('_id incidentId');
    if (!report) return res.status(404).json({ message: 'Report not found.' });
    const access = await accessFor(req, report);
    if (!access) return res.status(403).json({ message: 'Location-sharing access is no longer authorized.' });
    session.lastLocation = { type: 'Point', coordinates: input.location.coordinates }; session.accuracyMeters = input.location.accuracyMeters; session.source = input.location.source; session.lastUpdatedAt = new Date(); await session.save();
    const payload = { reportId: String(report._id), session: publicSession(session) };
    publishPrivateEvent(access.viewers, 'live-location-updated', payload);
    res.json({ session: publicSession(session), transmittedAt: session.lastUpdatedAt });
  } catch (error) { next(error); }
});

router.post('/live/stop', authenticate, allowRoles('requester'), async (req, res, next) => {
  try {
    const input = z.object({ sessionId: z.string().refine(mongoose.isValidObjectId) }).strict().parse(req.body);
    const session = await LiveLocationSession.findOne({ _id: input.sessionId, requester: req.user._id, status: 'active' });
    if (!session) return res.status(404).json({ message: 'Active location-sharing session not found.' });
    session.status = 'stopped'; session.stoppedAt = new Date(); await session.save();
    const report = await EmergencyRequest.findById(session.report).select('_id reportedBy incidentId');
    const access = report ? await accessFor(req, report) : null;
    await AuditLog.create({ actor: req.user._id, action: 'location.live_stopped', targetType: 'EmergencyRequest', targetId: session.report, details: { sessionId: String(session._id) } });
    publishPrivateEvent(access?.viewers || [], 'live-location-stopped', { reportId: String(session.report), sessionId: String(session._id), stoppedAt: session.stoppedAt });
    res.json({ status: 'stopped', stoppedAt: session.stoppedAt });
  } catch (error) { next(error); }
});

router.get('/live/:reportId/status', authenticate, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.reportId)) return res.status(400).json({ message: 'Invalid report identifier.' });
    const report = await EmergencyRequest.findById(req.params.reportId).select('_id reportedBy incidentId status');
    if (!report) return res.status(404).json({ message: 'Report not found.' });
    const access = await accessFor(req, report);
    if (!access) return res.status(404).json({ message: 'Report not found.' });
    const session = await activeSession(report);
    await auditLocationView(req, report, session, access);
    const latest = session || await LiveLocationSession.findOne({ report: report._id }).sort({ startedAt: -1 }).select('status').lean();
    res.json({ session: publicSession(session), status: publicSession(session)?.status || latest?.status || 'inactive' });
  } catch (error) { next(error); }
});

router.get('/live/:reportId', authenticate, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.reportId)) return res.status(400).json({ message: 'Invalid report identifier.' });
    const report = await EmergencyRequest.findById(req.params.reportId).select('_id reportedBy incidentId status location');
    if (!report) return res.status(404).json({ message: 'Report not found.' });
    const access = await accessFor(req, report);
    if (!access) return res.status(404).json({ message: 'Report not found.' });
    const session = await activeSession(report);
    await auditLocationView(req, report, session, access);
    res.json({ originalLocation: access.owner || ['coordinator', 'admin'].includes(req.user.role) ? report.location : undefined, session: publicSession(session), status: session?.status || 'inactive' });
  } catch (error) { next(error); }
});

export default router;
