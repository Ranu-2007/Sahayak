import { Router } from 'express';
import { z } from 'zod';
import EmergencyRequest from '../models/EmergencyRequest.js';
import Provider from '../models/Provider.js';
import Incident from '../models/Incident.js';
import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { audit, notify } from '../services/record.js';
import { disconnectUser } from '../services/liveEvents.js';
import { refreshIncidentStats } from '../services/incidents.js';

const router = Router();
router.use(authenticate, allowRoles('coordinator', 'admin'));
function indiaStartOfToday(now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return new Date(`${date}T00:00:00+05:30`);
}
router.get('/summary', async (_req, res, next) => {
  try {
    const todayStart = indiaStartOfToday();
    const activeResponderStatuses = ['claimed', 'preparing_assistance', 'on_the_way', 'reached_location', 'assistance_in_progress'];
    const [statuses, allStatuses, urgencies, providers, providerAvailability, availableResources, activeIncidentCounts, activeResponderIds, affectedPopulation, resolvedToday] = await Promise.all([
      EmergencyRequest.aggregate([{ $match: { status: { $nin: ['fulfilled', 'cancelled', 'duplicate'] } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      EmergencyRequest.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      EmergencyRequest.aggregate([{ $match: { status: { $nin: ['fulfilled', 'cancelled', 'duplicate'] } } }, { $group: { _id: '$urgency', count: { $sum: 1 } } }]),
      Provider.aggregate([{ $group: { _id: '$verificationStatus', count: { $sum: 1 } } }]),
      Provider.aggregate([{ $match: { verificationStatus: 'verified' } }, { $group: { _id: '$availability', count: { $sum: 1 } } }]),
      Provider.aggregate([{ $match: { verificationStatus: 'verified', availability: 'available' } }, { $unwind: '$inventory' }, { $group: { _id: { resource: '$inventory.resource', unit: '$inventory.unit' }, quantity: { $sum: { $ifNull: ['$inventory.availableQuantity', { $ifNull: ['$inventory.quantity', 0] }] } }, lastUpdatedAt: { $max: '$inventory.updatedAt' } } }, { $sort: { '_id.resource': 1, '_id.unit': 1 } }]),
      Incident.aggregate([{ $match: { status: 'active' } }, { $project: { priorityLevel: 1, activeResponders: { $filter: { input: { $ifNull: ['$responders', []] }, as: 'responder', cond: { $in: ['$$responder.status', activeResponderStatuses] } } } } }, { $group: { _id: null, active: { $sum: 1 }, critical: { $sum: { $cond: [{ $eq: ['$priorityLevel', 'P1'] }, 1, 0] } }, unassigned: { $sum: { $cond: [{ $eq: [{ $size: '$activeResponders' }, 0] }, 1, 0] } } } }]),
      Incident.aggregate([{ $match: { status: 'active' } }, { $unwind: '$responders' }, { $match: { 'responders.provider': { $ne: null }, 'responders.status': { $in: activeResponderStatuses } } }, { $group: { _id: '$responders.provider' } }]),
      Incident.aggregate([{ $match: { status: 'active' } }, { $group: { _id: null, total: { $sum: { $ifNull: ['$totalAffectedPeople', '$estimatedAffectedPeople'] } } } }]),
      Incident.countDocuments({ status: 'resolved', resolvedAt: { $gte: todayStart } }),
    ]);
    const count = (rows, key) => rows.find(row => row._id === key)?.count || 0;
    const incidentCounts = activeIncidentCounts[0] || { active: 0, critical: 0, unassigned: 0 };
    res.json({ requests: { open: statuses.reduce((n, r) => n + r.count, 0), byStatus: Object.fromEntries(allStatuses.map(r => [r._id, r.count])), byUrgency: Object.fromEntries(urgencies.map(r => [r._id, r.count])), criticalUnfulfilled: count(urgencies, 'critical'), inProgress: count(allStatuses, 'in_progress'), fulfilled: count(allStatuses, 'fulfilled') }, providers: { ...Object.fromEntries(providers.map(r => [r._id, r.count])), available: count(providerAvailability, 'available'), byAvailability: Object.fromEntries(providerAvailability.map(r => [r._id, r.count])) }, incidents: { active: incidentCounts.active, critical: incidentCounts.critical, unassigned: incidentCounts.unassigned, activeResponders: activeResponderIds.length, peopleAffected: affectedPopulation[0]?.total || 0, resolvedToday }, availableResources: availableResources.map(row => ({ resource: row._id.resource, unit: row._id.unit, quantity: row.quantity, lastUpdatedAt: row.lastUpdatedAt || null })) });
  } catch (error) { next(error); }
});
router.get('/overview', async (_req, res, next) => {
  try {
    const [openRequests, criticalRequests, availableProviders, inProgress, fulfilled] = await Promise.all([
      EmergencyRequest.countDocuments({ status: { $nin: ['fulfilled', 'cancelled', 'duplicate', 'expired'] } }),
      EmergencyRequest.countDocuments({ urgency: 'critical', status: { $nin: ['fulfilled', 'cancelled', 'duplicate', 'expired'] } }),
      Provider.countDocuments({ availability: 'available', verificationStatus: 'verified' }),
      EmergencyRequest.countDocuments({ status: 'in_progress' }),
      EmergencyRequest.countDocuments({ status: 'fulfilled' }),
    ]);
    res.json({ overview: { openRequests, criticalRequests, availableProviders, inProgress, fulfilled } });
  } catch (error) { next(error); }
});
router.get('/shortages', async (_req, res, next) => {
  try {
    const [requests, providers] = await Promise.all([
      EmergencyRequest.find({ status: { $nin: ['fulfilled', 'cancelled', 'duplicate'] } }).select('title urgency items assignments').lean(),
      Provider.find({ verificationStatus: 'verified', availability: { $in: ['available', 'limited'] } }).select('inventory').lean(),
    ]);
    const resources = new Map();
    for (const request of requests) for (const item of request.items) {
      const key = `${item.resource.toLowerCase()}|${item.unit.toLowerCase()}`;
      if (!resources.has(key)) resources.set(key, { resource: item.resource, unit: item.unit, demand: 0, criticalDemand: 0, sources: [] });
      const entry = resources.get(key);
      const allocated = request.assignments.filter(a => ['offered', 'accepted', 'in_progress', 'partially_fulfilled', 'fulfilled'].includes(a.status)).flatMap(a => a.allocatedItems).filter(a => a.resource.toLowerCase() === key.split('|')[0] && a.unit.toLowerCase() === key.split('|')[1]).reduce((sum, a) => sum + a.quantity, 0);
      const unmet = Math.max(0, item.quantity - allocated);
      entry.demand += unmet;
      if (request.urgency === 'critical') entry.criticalDemand += unmet;
      if (unmet) entry.sources.push({ request: request.title, urgency: request.urgency, unmet });
    }
    for (const provider of providers) for (const item of provider.inventory) {
      const key = `${item.resource.toLowerCase()}|${item.unit.toLowerCase()}`;
      if (!resources.has(key)) resources.set(key, { resource: item.resource, unit: item.unit, demand: 0, criticalDemand: 0, sources: [] });
      resources.get(key).stock = (resources.get(key).stock || 0) + (item.availableQuantity ?? item.quantity ?? 0);
    }
    const shortages = [...resources.values()].map(row => ({ ...row, stock: row.stock || 0, shortage: Math.max(0, row.demand - (row.stock || 0)) })).filter(row => row.shortage > 0).sort((a, b) => b.criticalDemand - a.criticalDemand || b.shortage - a.shortage);
    res.json({ shortages });
  } catch (error) { next(error); }
});
router.get('/reports/resource-utilization', async (_req, res, next) => {
  try {
    const [requestStats, assignmentStats, providerStats] = await Promise.all([
      EmergencyRequest.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      EmergencyRequest.aggregate([{ $unwind: '$assignments' }, { $addFields: { allocatedQuantity: { $sum: '$assignments.allocatedItems.quantity' } } }, { $group: { _id: '$assignments.status', count: { $sum: 1 }, allocatedQuantity: { $sum: '$allocatedQuantity' } } }]),
      Provider.aggregate([
        { $addFields: { inventoryUnits: { $sum: { $map: { input: { $ifNull: ['$inventory', []] }, as: 'item', in: { $ifNull: ['$$item.availableQuantity', { $ifNull: ['$$item.quantity', 0] }] } } } } } },
        { $group: { _id: '$availability', count: { $sum: 1 }, inventoryUnits: { $sum: '$inventoryUnits' } } },
      ]),
    ]);
    res.json({ generatedAt: new Date(), requests: requestStats, assignments: assignmentStats, providers: providerStats });
  } catch (error) { next(error); }
});
router.get('/audit-logs', async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
    const [logs, total] = await Promise.all([AuditLog.find().populate('actor', 'name email role').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), AuditLog.countDocuments()]);
    res.json({ logs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});
router.patch('/users/:id/role', allowRoles('admin'), async (req, res, next) => {
  try {
    const { role } = z.object({ role: z.enum(['requester', 'provider', 'coordinator', 'admin']) }).parse(req.body);
    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true, runValidators: true }).select('-passwordHash');
    if (!user) return res.status(404).json({ message: 'User not found.' });
    disconnectUser(user.id);
    await audit(req, 'user.role_updated', 'User', user.id, { role });
    await notify([user.id], 'account_role', 'Account role updated', `Your Sahayak role is now ${role}.`);
    res.json({ user });
  } catch (error) { next(error); }
});
router.post('/requests/:id/resolve-duplicate', async (req, res, next) => {
  try {
    const { duplicateOf, notes } = z.object({ duplicateOf: z.string().regex(/^[a-f\d]{24}$/i), notes: z.string().trim().max(1000).optional() }).parse(req.body);
    if (duplicateOf === req.params.id) return res.status(400).json({ message: 'A request cannot be marked as a duplicate of itself.' });
    const [request, canonical] = await Promise.all([EmergencyRequest.findById(req.params.id), EmergencyRequest.findById(duplicateOf)]);
    if (!request || !canonical) return res.status(404).json({ message: 'Request not found.' });
    if (request.status === 'fulfilled' || request.assignments.some(a => ['accepted', 'in_progress', 'fulfilled'].includes(a.status))) return res.status(409).json({ message: 'An assigned or fulfilled request cannot be marked duplicate.' });
    request.status = 'duplicate'; request.duplicateOf = canonical.id;
    if (notes) request.coordinationNotes.push({ author: req.user.id, body: notes });
    await request.save();
    await audit(req, 'request.marked_duplicate', 'EmergencyRequest', request.id, { duplicateOf: canonical.id, notes });
    if (request.incidentId) await refreshIncidentStats(request.incidentId);
    await notify([request.reportedBy], 'request_duplicate', 'Duplicate request resolved', `Your request was linked to ${canonical.title}.`, request.id);
    res.json({ request });
  } catch (error) { next(error); }
});
export default router;
