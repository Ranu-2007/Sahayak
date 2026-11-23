import { Router } from 'express';
import { z } from 'zod';
import EmergencyRequest from '../models/EmergencyRequest.js';
import Feedback from '../models/Feedback.js';
import Provider from '../models/Provider.js';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { audit, notify } from '../services/record.js';
import { updateAssignmentStatus } from './requests.js';

const router = Router();
router.use(authenticate);

async function updateEmbeddedAssignment(req, res, next, requestedStatus) {
  try {
    const request = await EmergencyRequest.findOne({ 'assignments._id': req.params.id }).select('_id');
    if (!request) return res.status(404).json({ message: 'Assignment not found.' });
    req.params.assignmentId = req.params.id;
    req.params.id = String(request._id);
    req.body = { ...(req.body || {}), ...(requestedStatus ? { status: requestedStatus } : {}) };
    return updateAssignmentStatus(req, res, next);
  } catch (error) { return next(error); }
}

router.patch('/:id/accept', allowRoles('provider', 'coordinator', 'admin'), (req, res, next) => updateEmbeddedAssignment(req, res, next, 'accepted'));
router.patch('/:id/decline', allowRoles('provider', 'coordinator', 'admin'), (req, res, next) => updateEmbeddedAssignment(req, res, next, 'declined'));
router.patch('/:id/status', allowRoles('provider', 'coordinator', 'admin'), (req, res, next) => updateEmbeddedAssignment(req, res, next));

router.post('/:id/feedback', allowRoles('requester', 'coordinator', 'admin'), async (req, res, next) => {
  try {
    const { rating, comments } = z.object({ rating: z.number().int().min(1).max(5), comments: z.string().trim().max(1000).optional() }).strict().parse(req.body);
    const request = await EmergencyRequest.findOne({ 'assignments._id': req.params.id }).populate('assignments.provider');
    if (!request) return res.status(404).json({ message: 'Assignment not found.' });
    const assignment = request.assignments.id(req.params.id);
    const requester = String(request.reportedBy) === req.user.id;
    if (!requester && !['coordinator', 'admin'].includes(req.user.role)) return res.status(403).json({ message: 'Only the requesting user or a coordinator can leave feedback.' });
    if (assignment.status !== 'fulfilled' || !request.fulfillmentConfirmation?.confirmed) return res.status(409).json({ message: 'Feedback is available after assistance is verified as received.' });
    const feedback = await Feedback.create({ requestId: request._id, request: request._id, assignmentId: assignment._id, requesterId: req.user._id, author: req.user._id, providerId: assignment.provider._id, provider: assignment.provider._id, rating, comments, comment: comments, verificationStatus: 'verified', verifiedFulfillment: true });
    await audit(req, 'assignment.feedback_submitted', 'Assignment', assignment._id, { rating });
    await notify([assignment.provider.owner], 'feedback_received', 'Verified feedback received', `${rating}/5 feedback was submitted for ${request.title}.`, request.id);
    res.status(201).json({ feedback });
  } catch (error) { next(error); }
});

export default router;
