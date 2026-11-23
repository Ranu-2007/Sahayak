import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import Provider from '../models/Provider.js';
import EmergencyRequest from '../models/EmergencyRequest.js';
import Feedback from '../models/Feedback.js';
import Incident from '../models/Incident.js';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { audit, notify } from '../services/record.js';

const router = Router();
const inventoryItem = z.object({ resource: z.string().trim().min(1).max(100), quantity: z.number().min(0), unit: z.string().trim().min(1).max(30) });
const secureUrl = z.string().url().max(500).refine(value => new URL(value).protocol === 'https:', 'Evidence links must use HTTPS.');
const providerType = z.enum(['individual', 'organization', 'hospital', 'ambulance', 'ngo', 'volunteer_group', 'supplier', 'rescue_team', 'other']);
const contactMethod = z.object({ email: z.string().trim().email().max(254).optional().or(z.literal('')), phone: z.string().trim().min(7).max(30).optional().or(z.literal('')), website: secureUrl.optional(), preferred: z.enum(['email', 'phone', 'website', 'platform']).default('platform') }).optional();
const providerInput = z.object({ name: z.string().trim().min(2).max(120), registrationNumber: z.string().trim().max(120).optional(), description: z.string().trim().max(1500).optional(), representative: z.object({ name: z.string().trim().max(100).optional(), designation: z.string().trim().max(100).optional(), phone: z.string().trim().max(30).optional(), email: z.string().trim().email().max(254).optional().or(z.literal('')) }).optional(), teamComposition: z.object({ teamSize: z.number().int().min(0).max(100000).optional(), volunteers: z.number().int().min(0).max(100000).optional(), medicalStaff: z.number().int().min(0).max(100000).optional(), vehicles: z.number().int().min(0).max(100000).optional(), equipment: z.array(z.string().trim().max(100)).max(100).optional() }).optional(), providerType: providerType.default('other'), category: z.string().trim().min(2).max(80), serviceCategories: z.array(z.string().trim().max(80)).max(30).default([]), skills: z.array(z.string().trim().max(80)).max(30).default([]), qualifications: z.array(z.string().trim().max(120)).max(30).default([]), contactMethod, credentials: z.array(z.object({ name: z.string().trim().min(2).max(100), issuer: z.string().trim().max(120).optional(), reference: z.string().trim().max(200).optional(), evidenceUrl: secureUrl.optional() })).max(30).default([]), inventory: z.array(inventoryItem).max(100).default([]), capacity: z.number().int().min(1).max(1000).default(1), location: z.object({ label: z.string().trim().max(200).optional(), coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional() }).default({}), serviceRadiusKm: z.number().min(0).max(500).default(25), operationalHours: z.object({ timezone: z.string().max(80).default('UTC'), schedule: z.array(z.object({ day: z.number().int().min(0).max(6), open: z.string().max(10).optional(), close: z.string().max(10).optional(), closed: z.boolean().default(false) })).max(7).default([]) }).optional(), availability: z.enum(['available', 'limited', 'unavailable']).default('available') });

router.get('/mine', authenticate, allowRoles('provider'), async (req, res, next) => {
  try {
    const provider = await Provider.findOne({ owner: req.user.id }).lean();
    if (!provider) return res.json({ provider: null });
    const [currentWorkload, completionStats, feedbackStats] = await Promise.all([
      EmergencyRequest.countDocuments({ assignments: { $elemMatch: { provider: provider._id, status: { $in: ['offered', 'accepted', 'in_progress', 'partially_fulfilled'] } } } }),
      verifiedCompletionStats([provider._id]),
      Feedback.aggregate([{ $match: { provider: new mongoose.Types.ObjectId(provider._id), verifiedFulfillment: true } }, { $group: { _id: '$provider', count: { $sum: 1 }, averageRating: { $avg: '$rating' } } }]),
    ]);
    const completed = completionStats.get(String(provider._id)) || { count: 0, onTime: 0 };
    const verifiedCompletedAssignments = completed.count;
    const stats = feedbackStats[0] || { count: 0, averageRating: null };
    res.json({ provider: { ...provider, inventory: normalizeInventory(provider.inventory, provider.updatedAt), lastAvailabilityUpdated: provider.lastAvailabilityUpdated || null, providerId: String(provider._id), currentWorkload, verifiedCompletedAssignments, reliabilityStats: { reliabilityScore: provider.reliability, verifiedCompletedAssignments, onTimeCompletedAssignments: completed.onTime, onTimeCompletionRate: completed.count ? Math.round(completed.onTime / completed.count * 100) : null, verifiedFeedbackCount: stats.count, averageVerifiedRating: stats.averageRating === null ? null : Number(stats.averageRating.toFixed(2)) } } });
  }
  catch (error) { next(error); }
});
const teamMemberInput = z.object({ name: z.string().trim().min(2).max(100), role: z.enum(['Organization Admin', 'Coordinator', 'Responder', 'Medical Staff', 'Volunteer', 'Resource Manager']), skills: z.array(z.string().trim().min(1).max(80)).max(30).default([]), availability: z.enum(['available', 'busy', 'unavailable']).default('available'), activeAssignment: z.string().regex(/^[a-f\d]{24}$/i).optional(), notes: z.string().trim().max(500).optional() }).strict();
router.get('/mine/team', authenticate, allowRoles('provider'), async (req, res, next) => {
  try { const provider = await Provider.findOne({ owner: req.user.id }).select('teamMembers'); if (!provider) return res.status(404).json({ message: 'Provider profile not found.' }); res.json({ members: provider.teamMembers || [] }); }
  catch (error) { next(error); }
});
router.post('/mine/team', authenticate, allowRoles('provider'), async (req, res, next) => {
  try { const input = teamMemberInput.parse(req.body); const provider = await Provider.findOne({ owner: req.user.id }); if (!provider) return res.status(404).json({ message: 'Provider profile not found.' }); provider.teamMembers.push(input); await provider.save(); const member = provider.teamMembers.at(-1); await audit(req, 'provider.team_member_added', 'Provider', provider.id, { memberId: member.id, role: member.role }); res.status(201).json({ member }); }
  catch (error) { next(error); }
});
router.patch('/mine/team/:memberId', authenticate, allowRoles('provider'), async (req, res, next) => {
  try { const input = teamMemberInput.partial().refine(value => Object.keys(value).length > 0, 'Provide at least one team member field.').parse(req.body); const provider = await Provider.findOne({ owner: req.user.id }); const member = provider?.teamMembers.id(req.params.memberId); if (!member) return res.status(404).json({ message: 'Team member not found.' }); Object.assign(member, input); await provider.save(); await audit(req, 'provider.team_member_updated', 'Provider', provider.id, { memberId: member.id, fields: Object.keys(input) }); res.json({ member }); }
  catch (error) { next(error); }
});
router.delete('/mine/team/:memberId', authenticate, allowRoles('provider'), async (req, res, next) => {
  try { const provider = await Provider.findOne({ owner: req.user.id }); const member = provider?.teamMembers.id(req.params.memberId); if (!member) return res.status(404).json({ message: 'Team member not found.' }); if (member.activeAssignment) return res.status(409).json({ message: 'Remove the member from their active assignment before removing them from the team.' }); const memberId = member.id; member.deleteOne(); await provider.save(); await audit(req, 'provider.team_member_removed', 'Provider', provider.id, { memberId }); res.status(204).end(); }
  catch (error) { next(error); }
});
router.get('/mine/assignments', authenticate, allowRoles('provider'), async (req, res, next) => {
  try {
    const provider = await Provider.findOne({ owner: req.user.id }).select('_id');
    if (!provider) return res.json({ assignments: [] });
    const requests = await EmergencyRequest.find({ 'assignments.provider': provider._id }).sort({ updatedAt: -1 }).limit(200).lean();
    res.json({ assignments: requests.flatMap(request => request.assignments.filter(a => String(a.provider) === String(provider._id)).map(assignment => {
      const accepted = ['accepted', 'in_progress', 'partially_fulfilled', 'fulfilled'].includes(assignment.status);
      const requestSummary = { id: request.requestId, title: request.title, category: request.category, urgency: request.urgency, location: { label: accepted ? request.location?.label : 'Location withheld until provider acceptance.' }, status: request.status };
      if (accepted && request.location?.coordinatesAuthorized) requestSummary.location.coordinates = request.location.coordinates;
      return { request: requestSummary, ...assignment };
    })) });
  } catch (error) { next(error); }
});
router.get('/mine/incidents', authenticate, allowRoles('provider'), async (req, res, next) => {
  try {
    const provider = await Provider.findOne({ owner: req.user.id }).select('_id');
    if (!provider) return res.json({ incidents: [] });
    const incidents = await Incident.find({ 'responders.provider': provider._id }).sort({ updatedAt: -1 }).limit(200).populate('responders.provider', 'name providerType verificationStatus').lean();
    res.json({ incidents: incidents.map(incident => {
      const ownResponse = incident.responders.find(responder => String(responder.provider?._id || responder.provider) === String(provider._id));
      return { _id: incident._id, incidentId: incident.incidentId, title: incident.title, emergencyType: incident.emergencyType, category: incident.category, location: incident.location?.label || 'Location not provided', status: incident.status, responseStatus: incident.responseStatus || 'reported', priorityScore: incident.priorityScore, priorityLevel: incident.priorityLevel, reportCount: incident.reportCount, totalAffectedPeople: incident.totalAffectedPeople ?? incident.estimatedAffectedPeople, maximumSeverity: incident.maximumSeverity, verificationStatus: incident.verifiedReportCount === incident.reportCount ? 'officially verified' : incident.verifiedReportCount ? 'partially verified' : 'unverified', ownResponse, responderCount: incident.responders.filter(responder => responder.status !== 'withdrawn').length, updatedAt: incident.updatedAt };
    }) });
  } catch (error) { next(error); }
});
router.get('/mine/feedback', authenticate, allowRoles('provider'), async (req, res, next) => {
  try {
    const provider = await Provider.findOne({ owner: req.user.id }).select('_id');
    if (!provider) return res.json({ feedback: [] });
    res.json({ feedback: await Feedback.find({ provider: provider._id }).populate('request', 'title').populate('author', 'name').sort({ createdAt: -1 }).limit(200).lean() });
  } catch (error) { next(error); }
});
router.get('/', authenticate, async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.category) filter.category = String(req.query.category);
    if (req.query.availability) filter.availability = String(req.query.availability);
    if (req.query.verified === 'true') filter.verificationStatus = 'verified';
    if (!['coordinator', 'admin'].includes(req.user.role)) filter.verificationStatus = 'verified';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const total = await Provider.countDocuments(filter);
    const query = Provider.find(filter);
    if (!['coordinator', 'admin'].includes(req.user.role)) query.select('-credentials -suspensionReason -contactMethod');
    const rows = await query.sort({ verified: -1, reliability: -1 }).skip((page - 1) * limit).limit(limit).lean();
    const stats = await providerStatsById(rows.map(provider => provider._id));
    const providers = rows.map(provider => {
      const operational = stats.get(String(provider._id)) || {};
      const completedCount = operational.verifiedCompletedAssignments || 0;
      const result = { ...provider, inventory: normalizeInventory(provider.inventory, provider.updatedAt), lastAvailabilityUpdated: provider.lastAvailabilityUpdated || null, providerId: String(provider._id), currentWorkload: operational.currentWorkload || 0, verifiedCompletedAssignments: completedCount, reliabilityStats: { reliabilityScore: provider.reliability, verifiedCompletedAssignments: completedCount, onTimeCompletedAssignments: operational.onTimeCompletedAssignments || 0, onTimeCompletionRate: completedCount ? Math.round((operational.onTimeCompletedAssignments || 0) / completedCount * 100) : null, verifiedFeedbackCount: operational.feedbackCount || 0, averageVerifiedRating: operational.averageRating ?? null } };
      if (!['coordinator', 'admin'].includes(req.user.role)) {
        result.inventory = normalizeInventory(provider.inventory, provider.updatedAt, false);
        delete result.owner;
        if (result.location) delete result.location.coordinates;
      }
      return result;
    });
    res.json({ providers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});
router.get('/offline-directory', authenticate, async (_req, res, next) => {
  try {
    const providers = await Provider.find({ verificationStatus: 'verified', availability: { $ne: 'unavailable' } }).select('name providerType category serviceCategories skills location.label availability serviceRadiusKm verifiedAt updatedAt').sort({ name: 1 }).limit(500).lean();
    res.json({ updatedAt: new Date().toISOString(), entries: providers.map(provider => ({ id: String(provider._id), name: provider.name, type: provider.providerType, services: provider.serviceCategories?.length ? provider.serviceCategories : [provider.category], skills: provider.skills || [], area: provider.location?.label || 'Area not listed', availability: provider.availability, serviceRadiusKm: provider.serviceRadiusKm, verifiedAt: provider.verifiedAt || null })) });
  } catch (error) { next(error); }
});
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const provider = await Provider.findById(req.params.id).lean();
    if (!provider) return res.status(404).json({ message: 'Provider not found.' });
    const privileged = ['coordinator', 'admin'].includes(req.user.role);
    if (!privileged && (provider.verificationStatus !== 'verified' || req.user.role === 'provider' && String(provider.owner) !== req.user.id)) return res.status(404).json({ message: 'Provider not found.' });
    const result = { ...provider, inventory: normalizeInventory(provider.inventory, provider.updatedAt, privileged), lastAvailabilityUpdated: provider.lastAvailabilityUpdated || null };
    if (!privileged) { delete result.credentials; delete result.suspensionReason; delete result.contactMethod; delete result.owner; if (result.location) delete result.location.coordinates; }
    res.json({ provider: result });
  } catch (error) { next(error); }
});
router.get('/:id/feedback', authenticate, async (req, res, next) => {
  try {
    const provider = await Provider.findById(req.params.id).select('verificationStatus owner');
    if (!provider || provider.verificationStatus !== 'verified' && !['coordinator', 'admin'].includes(req.user.role)) return res.status(404).json({ message: 'Provider not found.' });
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const filter = { provider: provider._id, verifiedFulfillment: true };
    const [feedback, total] = await Promise.all([Feedback.find(filter).populate('request', 'title category').populate('author', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Feedback.countDocuments(filter)]);
    res.json({ feedback, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});
const createProviderHandler = async (req, res, next) => {
  try {
    const input = providerInput.parse(req.body);
    const provider = await Provider.create({ ...input, inventory: inventoryRows(input.inventory), owner: req.user.id, lastAvailabilityUpdated: new Date(), location: { ...input.location, type: 'Point', coordinates: input.location?.coordinates || [0, 0] }, verificationStatus: 'pending', verified: false, credentials: input.credentials.map(item => ({ ...item, status: 'pending' })) });
    await audit(req, 'provider.profile_submitted', 'Provider', provider.id);
    await notify([req.user.id], 'provider_verification', 'Provider profile submitted', 'Your profile is awaiting coordinator verification.');
    res.status(201).json({ provider });
  } catch (error) { next(error); }
};
router.post('/', authenticate, allowRoles('provider'), createProviderHandler);
router.post('/profile', authenticate, allowRoles('provider'), createProviderHandler);
router.patch('/mine', authenticate, allowRoles('provider'), async (req, res, next) => {
  try {
    const input = providerInput.omit({ inventory: true }).partial().parse(req.body);
    const existing = await Provider.findOne({ owner: req.user.id });
    if (!existing) return res.status(404).json({ message: 'Create your provider profile before updating it.' });
    const update = { ...input };
    if (input.location) update.location = { ...existing.location?.toObject?.(), ...input.location, type: 'Point', coordinates: input.location.coordinates || existing.location?.coordinates || [0, 0] };
    if (input.credentials) update.credentials = input.credentials.map(item => ({ ...item, status: 'pending' }));
    if (input.availability !== undefined || input.operationalHours !== undefined) update.lastAvailabilityUpdated = new Date();
    if (input.availability !== undefined) update.availabilitySource = 'provider_reported';
    const needsReview = ['name', 'category', 'serviceCategories', 'skills', 'location', 'serviceRadiusKm', 'credentials'].some(key => input[key] !== undefined);
    if (needsReview) { update.verificationStatus = 'pending'; update.verified = false; update.verifiedAt = null; }
    const provider = await Provider.findOneAndUpdate({ owner: req.user.id }, { $set: update }, { new: true, runValidators: true });
    if (input.credentials) { provider.verificationStatus = 'pending'; provider.verified = false; await provider.save(); }
    await audit(req, 'provider.profile_updated', 'Provider', provider.id);
    res.json({ provider });
  } catch (error) { next(error); }
});
router.patch('/:id', authenticate, allowRoles('provider', 'coordinator', 'admin'), async (req, res, next) => {
  try {
    const input = providerInput.omit({ inventory: true }).partial().parse(req.body);
    const filter = { _id: req.params.id };
    if (req.user.role === 'provider') filter.owner = req.user.id;
    const provider = await Provider.findOne(filter);
    if (!provider) return res.status(404).json({ message: 'Provider not found.' });
    Object.assign(provider, input);
    if (input.location) provider.location = { ...input.location, type: 'Point', coordinates: input.location.coordinates || [0, 0] };
    if (input.credentials) provider.credentials = input.credentials.map(item => ({ ...item, status: 'pending' }));
    const needsReview = ['name', 'category', 'serviceCategories', 'skills', 'location', 'serviceRadiusKm', 'credentials'].some(key => input[key] !== undefined);
    if (needsReview) { provider.verificationStatus = 'pending'; provider.verified = false; provider.verifiedAt = undefined; }
    if (input.availability !== undefined || input.operationalHours !== undefined) provider.lastAvailabilityUpdated = new Date();
    if (input.availability !== undefined) provider.availabilitySource = req.user.role === 'provider' ? 'provider_reported' : 'coordinator_confirmed';
    await provider.save();
    await audit(req, 'provider.profile_updated', 'Provider', provider.id, Object.keys(input));
    res.json({ provider });
  } catch (error) { next(error); }
});
router.patch('/:id/verification', authenticate, allowRoles('coordinator', 'admin'), async (req, res, next) => {
  try {
    const input = z.object({ status: z.enum(['verified', 'rejected']), notes: z.string().trim().max(1000).optional(), credentials: z.array(z.object({ credentialId: z.string().regex(/^[a-f\d]{24}$/i), status: z.enum(['verified', 'rejected']), notes: z.string().trim().max(500).optional() })).max(30).default([]) }).parse(req.body);
    const provider = await Provider.findById(req.params.id);
    if (!provider) return res.status(404).json({ message: 'Provider not found.' });
    for (const review of input.credentials) {
      const credential = provider.credentials.id(review.credentialId);
      if (!credential) return res.status(400).json({ message: 'Credential not found.' });
      credential.status = review.status; credential.reviewedBy = req.user.id; credential.reviewedAt = new Date(); credential.notes = review.notes;
    }
    if (input.status === 'verified' && provider.credentials.some(c => c.status !== 'verified')) return res.status(409).json({ message: 'Review every submitted credential before verifying this provider.' });
    provider.verificationStatus = input.status; provider.verified = input.status === 'verified'; provider.verifiedAt = provider.verified ? new Date() : undefined; provider.verificationNotes = input.notes;
    await provider.save();
    await audit(req, `provider.${input.status}`, 'Provider', provider.id, { notes: input.notes });
    await notify([provider.owner], 'provider_verification', `Provider profile ${input.status}`, input.notes || `Your provider profile has been ${input.status}.`);
    res.json({ provider });
  } catch (error) { next(error); }
});
router.patch('/:id/suspend', authenticate, allowRoles('admin'), async (req, res, next) => {
  try {
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    const provider = await Provider.findByIdAndUpdate(req.params.id, { availability: 'unavailable', verificationStatus: 'suspended', verified: false, suspendedAt: new Date(), suspensionReason: reason }, { new: true });
    if (!provider) return res.status(404).json({ message: 'Provider not found.' });
    await audit(req, 'provider.suspended', 'Provider', provider.id, { reason });
    await notify([provider.owner], 'provider_suspended', 'Provider account suspended', reason);
    res.json({ provider });
  } catch (error) { next(error); }
});
router.patch('/:id/availability', authenticate, allowRoles('coordinator', 'admin', 'provider'), async (req, res, next) => {
  try {
    const update = z.object({ availability: z.enum(['available', 'limited', 'unavailable']), operationalHours: providerInput.shape.operationalHours.optional() }).parse(req.body);
    const filter = { _id: req.params.id };
    if (req.user.role === 'provider') filter.owner = req.user.id;
    const provider = await Provider.findOneAndUpdate(filter, { $set: { ...update, availabilitySource: req.user.role === 'provider' ? 'provider_reported' : 'coordinator_confirmed', lastAvailabilityUpdated: new Date() } }, { new: true, runValidators: true });
    if (!provider) return res.status(404).json({ message: 'Provider not found.' });
    await audit(req, 'provider.availability_updated', 'Provider', provider.id, update);
    res.json({ provider });
  } catch (error) { next(error); }
});
router.patch('/:id/inventory', authenticate, allowRoles('coordinator', 'admin', 'provider'), async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const { inventory } = z.object({ inventory: z.array(inventoryItem).max(100) }).parse(req.body);
    const filter = { _id: req.params.id };
    if (req.user.role === 'provider') filter.owner = req.user.id;
    let provider;
    await session.withTransaction(async () => {
      provider = await Provider.findOne(filter).session(session);
      if (!provider) throw Object.assign(new Error('Provider not found.'), { status: 404 });
      const current = provider.inventory;
      const nextKeys = new Set(inventory.map(item => inventoryKey(item.resource, item.unit)));
      for (const stock of current) {
        const key = inventoryKey(stock.resource, stock.unit);
        if (!nextKeys.has(key) && (stock.reservedQuantity || 0) + (stock.allocatedQuantity || 0) + (stock.consumedQuantity || 0) > 0) throw Object.assign(new Error(`Cannot remove ${stock.resource}; it has reserved, allocated, or consumed quantity history.`), { status: 409 });
      }
      provider.inventory = inventory.map(item => {
        const old = current.find(stock => inventoryKey(stock.resource, stock.unit) === inventoryKey(item.resource, item.unit));
        return { resource: item.resource, unit: item.unit, availableQuantity: item.quantity, reservedQuantity: old?.reservedQuantity || 0, allocatedQuantity: old?.allocatedQuantity || 0, consumedQuantity: old?.consumedQuantity || 0, updatedAt: new Date() };
      });
      await provider.save({ session });
    });
    await audit(req, 'provider.inventory_updated', 'Provider', provider.id, { count: inventory.length });
    res.json({ provider: provider.toObject() });
  } catch (error) { next(error); }
  finally { await session.endSession(); }
});
function inventoryRows(items = []) { return items.map(item => ({ resource: item.resource, unit: item.unit, availableQuantity: item.quantity, reservedQuantity: 0, allocatedQuantity: 0, consumedQuantity: 0, updatedAt: new Date() })); }
function inventoryKey(resource, unit) { return `${String(resource).trim().toLowerCase()}|${String(unit).trim().toLowerCase()}`; }
function normalizeInventory(items = [], fallbackUpdatedAt, detailed = true) {
  return items.map(item => {
    const availableQuantity = item.availableQuantity ?? item.quantity ?? 0;
    return { resource: item.resource, unit: item.unit, quantity: availableQuantity, availableQuantity, source: 'provider_reported', independentlyVerified: false, updatedAt: item.updatedAt || fallbackUpdatedAt || null, ...(detailed ? { reservedQuantity: item.reservedQuantity || 0, allocatedQuantity: item.allocatedQuantity || 0, consumedQuantity: item.consumedQuantity || 0 } : {}) };
  });
}
async function providerStatsById(ids) {
  if (!ids.length) return new Map();
    const [workload, completed, feedback] = await Promise.all([
    EmergencyRequest.aggregate([{ $unwind: '$assignments' }, { $match: { 'assignments.provider': { $in: ids }, 'assignments.status': { $in: ['offered', 'accepted', 'in_progress', 'partially_fulfilled'] } } }, { $group: { _id: '$assignments.provider', count: { $sum: 1 } } }]),
      verifiedCompletionStats(ids),
    Feedback.aggregate([{ $match: { provider: { $in: ids }, verifiedFulfillment: true } }, { $group: { _id: '$provider', count: { $sum: 1 }, average: { $avg: '$rating' } } }]),
  ]);
  const result = new Map(ids.map(id => [String(id), {}]));
  for (const row of workload) result.get(String(row._id)).currentWorkload = row.count;
  for (const [id, row] of completed) Object.assign(result.get(id), { verifiedCompletedAssignments: row.count, onTimeCompletedAssignments: row.onTime });
  for (const row of feedback) { const target = result.get(String(row._id)); target.feedbackCount = row.count; target.averageRating = Number(row.average.toFixed(2)); }
  return result;
}
async function verifiedCompletionStats(ids) {
  if (!ids.length) return new Map();
  const rows = await EmergencyRequest.aggregate([
    { $match: { 'fulfillmentConfirmation.confirmed': true } },
    { $unwind: '$assignments' },
    { $match: { 'assignments.provider': { $in: ids }, 'assignments.status': 'fulfilled' } },
    { $group: { _id: '$assignments.provider', count: { $sum: 1 }, onTime: { $sum: { $cond: [{ $and: [{ $ne: ['$assignments.eta', null] }, { $lte: ['$assignments.completedAt', '$assignments.eta'] }] }, 1, 0] } } } },
  ]);
  return new Map(rows.map(row => [String(row._id), { count: row.count, onTime: row.onTime }]));
}
export default router;
