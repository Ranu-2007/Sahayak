import { Router } from 'express';
import Notification from '../models/Notification.js';
import Incident from '../models/Incident.js';
import EmergencyRequest from '../models/EmergencyRequest.js';
import { authenticate } from '../middleware/auth.js';
const router = Router();
router.get('/', authenticate, async (req, res, next) => {
  try {
    const notifications = await Notification.find({ user: req.user.id }).sort({ createdAt: -1 }).limit(100).lean();
    const targets = notifications.map(item => item.request).filter(Boolean);
    const [incidents, reports] = await Promise.all([
      Incident.find({ _id: { $in: targets } }).select('_id').lean(),
      EmergencyRequest.find({ _id: { $in: targets } }).select('_id incidentId').lean(),
    ]);
    const incidentIds = new Set(incidents.map(item => String(item._id)));
    const reportIncident = new Map(reports.map(item => [String(item._id), item.incidentId ? String(item.incidentId) : null]));
    const enriched = notifications.map(item => ({ ...item, incidentId: item.request ? (incidentIds.has(String(item.request)) ? String(item.request) : reportIncident.get(String(item.request)) || null) : null }));
    res.json({ notifications: enriched, unread: enriched.filter(n => !n.readAt).length });
  } catch (error) { next(error); }
});
router.patch('/:id/read', authenticate, async (req, res, next) => {
  try {
    const notification = await Notification.findOneAndUpdate({ _id: req.params.id, user: req.user.id }, { readAt: new Date() }, { new: true });
    if (!notification) return res.status(404).json({ message: 'Notification not found.' });
    res.json({ notification });
  } catch (error) { next(error); }
});
router.post('/read-all', authenticate, async (req, res, next) => {
  try { const { modifiedCount } = await Notification.updateMany({ user: req.user.id, readAt: null }, { readAt: new Date() }); res.json({ updated: modifiedCount }); }
  catch (error) { next(error); }
});
export default router;
