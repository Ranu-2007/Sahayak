import { Router } from 'express';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import EmergencyRequest from '../models/EmergencyRequest.js';
import Provider from '../models/Provider.js';
import Feedback from '../models/Feedback.js';
import { authenticate, allowRoles } from '../middleware/auth.js';
import { audit, notify } from '../services/record.js';
import { evaluateMatch, loadProviderMatchHistory, matchingModel } from '../services/matching.js';
import { verificationStatus, publicEvidence, feedbackCounts } from './community.js';
import { withPriority, rankRequests } from '../services/priority.js';
import Incident from '../models/Incident.js';
import { attachReportToIncident, listIncidentSummaries, refreshIncidentStats, liveIncidentPayload, deriveIncidentResponseStatus } from '../services/incidents.js';
import { publishLiveEvent, publishUserEvent } from '../services/liveEvents.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import LiveLocationSession from '../models/LiveLocationSession.js';
import { publishPrivateEvent } from '../services/liveEvents.js';

const router = Router();
const categories = ['Medical assistance', 'Rescue and evacuation', 'Food and drinking water', 'Temporary shelter', 'Transportation', 'Communication equipment', 'Electricity and generators', 'Medical equipment', 'Clothing and blankets', 'Other emergency supplies'];
const emergencyTypes = ['Flood', 'Earthquake', 'Cyclone', 'Tsunami', 'Landslide', 'Storm', 'House fire', 'Explosion', 'Road accident', 'Train accident', 'Industrial accident', 'Water contamination', 'Hospital issue', 'Disease outbreak', 'Sanitation problem', 'Infrastructure failure', 'Other'];
const item = z.object({ resource: z.string().trim().min(1).max(100), quantity: z.number().positive(), unit: z.string().trim().min(1).max(30) });
const requestInput = z.object({ title: z.string().trim().min(4).max(180), emergencyType: z.enum(emergencyTypes).default('Other'), affectedAreaType: z.enum(['village', 'neighborhood', 'road', 'facility', 'watershed', 'other']).default('other'), category: z.enum(categories), description: z.string().trim().min(5).max(2000), requiredService: z.string().trim().min(2).max(120), items: z.array(item).min(1).max(50), requiredSkills: z.array(z.string().trim().min(1).max(80)).max(30).default([]), affectedPeople: z.number().int().min(0).max(10000000), responseDeadline: z.string().datetime(), clientReportId: z.string().uuid().optional(), clientCreatedAt: z.string().datetime().optional(), offlineSync: z.boolean().default(false), contact: z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().email().max(254).optional().or(z.literal('')), phone: z.string().trim().min(7).max(30).optional().or(z.literal('')) }).refine(value => value.email || value.phone, 'Provide a requester contact email or phone number.'), location: z.object({ label: z.string().trim().min(2).max(200), coordinatesAuthorized: z.boolean(), coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(), accuracyMeters: z.number().min(0).max(100000).optional(), capturedAt: z.string().datetime().optional(), source: z.enum(['gps', 'manual']).optional() }).refine(value => !value.coordinates || value.coordinatesAuthorized, 'Coordinates require explicit authorization.').refine(value => !value.coordinatesAuthorized || Boolean(value.coordinates), 'Coordinates are required when precise sharing is authorized.'), urgency: z.enum(['low', 'medium', 'high', 'critical']).default('medium') }).strict();
router.get('/', authenticate, async (req, res, next) => {
  try {
    const filter = {};
    let providerId;
    if (!['coordinator', 'admin'].includes(req.user.role)) {
      const owner = req.user.role === 'provider' ? await Provider.findOne({ owner: req.user.id }).select('_id') : null;
      providerId = owner?._id;
      filter.$or = [{ reportedBy: req.user.id }, ...(owner ? [{ 'assignments.provider': owner._id }] : [])];
    }
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.urgency) filter.urgency = String(req.query.urgency);
    if (req.query.category) filter.category = String(req.query.category);
    const { page, limit } = pagination(req.query);
    const total = await EmergencyRequest.countDocuments(filter);
    const requests = await EmergencyRequest.find(filter).populate('reportedBy', 'name organization').populate('assignments.provider', 'name category verified availability').populate('reporterUpdates.author', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    const incidentIds = [...new Set(requests.map(request => request.incidentId).filter(Boolean).map(String))];
    const incidentProgress = incidentIds.length ? await Incident.find({ _id: { $in: incidentIds } }).select('_id title responseStatus status responders resolutionFeedback responseHistory').populate([{ path: 'responders.provider', select: 'name providerType verificationStatus' }, { path: 'responseHistory.provider', select: 'name verificationStatus' }]).lean() : [];
    const progressByIncident = new Map(incidentProgress.map(incident => [String(incident._id), incident]));
    for (const request of requests) if (request.responseDeadline <= new Date() && ['reported', 'submitted', 'under_review', 'verified', 'awaiting_match', 'matching'].includes(request.status)) request.status = 'expired';
    for (const request of requests) {
      request.reportedAt = request.reportedAt || request.createdAt;
      const incidentProgress = progressByIncident.get(String(request.incidentId));
      request.incidentResponseStatus = incidentProgress?.responseStatus || (incidentProgress?.status === 'resolved' ? 'resolved' : 'reported');
      request.incidentProgress = incidentProgress ? {
        incidentId: incidentProgress._id,
        title: incidentProgress.title,
        responseStatus: incidentProgress.responseStatus || 'reported',
        responders: (incidentProgress.responders || []).filter(responder => responder.status !== 'withdrawn').map(responder => ({ name: responder.provider?.verificationStatus === 'verified' ? responder.provider.name : 'Verified responder', providerType: responder.provider?.verificationStatus === 'verified' ? responder.provider.providerType : null, verificationStatus: responder.provider?.verificationStatus === 'verified' ? 'verified' : 'verification unavailable', status: responder.status, claimedAt: responder.claimedAt, updatedAt: responder.updatedAt, estimatedArrival: responder.estimatedArrival, task: responder.task, resources: responder.resources || [], resolutionUpdate: responder.resolutionUpdate, statusHistory: responder.statusHistory || [] })),
        responseTimeline: (incidentProgress.responseHistory || []).map(entry => ({ status: entry.status, update: entry.update, at: entry.at, responder: entry.provider?.verificationStatus === 'verified' ? entry.provider.name : null })),
        feedback: { confirmedResolved: (incidentProgress.resolutionFeedback || []).filter(item => item.action === 'confirmed_resolved').length, stillPresent: (incidentProgress.resolutionFeedback || []).filter(item => item.action === 'still_present').length, incomplete: (incidentProgress.resolutionFeedback || []).filter(item => item.action === 'incomplete').length, viewerAction: incidentProgress.resolutionFeedback?.find(item => String(item.user) === String(req.user._id))?.action || null },
      } : null;
      request.verificationStatus = verificationStatus(request);
      request.confirmationCount = request.communityConfirmations?.length || 0;
      request.communityFeedback = feedbackCounts(request.communityConfirmations);
      const viewerResponse = request.communityConfirmations?.find(item => String(item.user) === String(req.user._id));
      request.viewerCommunityAction = viewerResponse ? viewerResponse.action || 'confirm_issue' : null;
      delete request.communityConfirmations;
      request.evidence = (request.evidence || []).map(publicEvidence);
      Object.assign(request, withPriority(request));
    }
    if (['coordinator', 'admin'].includes(req.user.role)) requests.splice(0, requests.length, ...rankRequests(requests));
    if (req.user.role === 'provider') for (const request of requests) {
      delete request.evidence;
      delete request.confirmationCount;
      delete request.viewerHasConfirmed;
      delete request.communityFeedback;
      delete request.viewerCommunityAction;
      delete request.verificationStatus;
      const hasAcceptedAssignment = request.assignments.some(a => String(a.provider?._id || a.provider) === String(providerId) && ['accepted', 'in_progress', 'partially_fulfilled'].includes(a.status));
      if (!hasAcceptedAssignment) {
        delete request.contact;
        delete request.evidence;
        delete request.confirmationCount;
        delete request.verificationStatus;
        if (request.location) { delete request.location.coordinates; delete request.location.accuracyMeters; delete request.location.capturedAt; delete request.location.source; request.location.label = 'Location withheld until provider acceptance.'; }
      }
    }
    res.json({ requests, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});
router.get('/incidents', authenticate, async (req, res, next) => {
  try {
    const viewerProvider = req.user.role === 'provider' ? await Provider.findOne({ owner: req.user.id }).select('_id location serviceRadiusKm') : null;
    const query = {};
    const status = String(req.query.status || 'active');
    if (status !== 'all') {
      if (!['active', 'resolved'].includes(status)) return res.status(400).json({ message: 'Status must be active, resolved, or all.' });
      query.status = status;
    }
    if (req.query.category) query.category = String(req.query.category).slice(0, 100);
    if (req.query.location) query['location.label'] = new RegExp(String(req.query.location).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    let incidents = await Incident.find(query).sort({ priorityScore: -1, lastReportedAt: -1 }).limit(100).populate([{ path: 'reportIds', select: 'requestId title emergencyType category requiredService requiredSkills items affectedPeople urgency status verification reportedAt createdAt communityConfirmations', options: { sort: { reportedAt: 1 } } }, { path: 'responders.provider', select: 'name providerType verificationStatus' }]).lean();
    let summaries = await listIncidentSummaries(incidents);
    const reports = incidents.map(incident => (incident.reportIds || []).map(report => ({
      _id: report._id, requestId: report.requestId, title: report.title, emergencyType: report.emergencyType,
      category: report.category, requiredService: report.requiredService, requiredSkills: report.requiredSkills || [], items: report.items || [], affectedPeople: report.affectedPeople, urgency: report.urgency,
      status: report.status, verification: report.verification?.state || 'unverified', confirmationCount: report.communityConfirmations?.length || 0,
      reportedAt: report.reportedAt || report.createdAt,
    })));
    let response = summaries.map((summary, index) => {
      const sourceReports = incidents[index].reportIds || [];
      const states = sourceReports.map(report => verificationStatus(report));
      const verification = states.length && states.every(state => state === 'officially verified') ? 'officially verified' : states.some(state => state === 'officially verified') ? 'partially verified' : states.some(state => state === 'community supported') ? 'community supported' : 'unverified';
      const responders = (incidents[index].responders || []).map(responder => ({ _id: responder._id, name: responder.provider?.name || 'Verified responder', providerType: responder.provider?.providerType, verificationStatus: responder.provider?.verificationStatus, status: responder.status, isViewer: Boolean(viewerProvider && String(responder.provider?._id || responder.provider) === String(viewerProvider._id)) }));
      const providerCoordinates = viewerProvider?.location?.coordinates;
      const incidentCoordinates = incidents[index].location?.coordinates;
      const distanceKm = providerCoordinates?.some(value => value !== 0) && incidents[index].location?.coordinatesAuthorized && incidentCoordinates?.length === 2 ? distanceBetweenKm(providerCoordinates, incidentCoordinates) : null;
      return { ...summary, ...( ['coordinator', 'admin'].includes(req.user.role) && incidents[index].location?.coordinatesAuthorized ? { locationCoordinates: incidents[index].location.coordinates } : {}), ...(req.user.role === 'provider' ? { distanceKm, withinServiceArea: distanceKm !== null && distanceKm <= Number(viewerProvider.serviceRadiusKm || 0) } : {}), responseStatus: incidents[index].responseStatus || 'reported', responderCount: responders.filter(responder => responder.status !== 'withdrawn').length, responders, reports: reports[index], verificationStatus: verification };
    });
    const severity = String(req.query.severity || '').toLowerCase();
    const priority = String(req.query.priority || '').toUpperCase();
    if (severity && !['critical', 'high', 'medium', 'low'].includes(severity)) return res.status(400).json({ message: 'Severity must be critical, high, medium, or low.' });
    if (priority && !['P1', 'P2', 'P3', 'P4'].includes(priority)) return res.status(400).json({ message: 'Priority must be P1, P2, P3, or P4.' });
    if (severity) response = response.filter(incident => String(incident.priority?.severity).toLowerCase() === severity || incident.maximumSeverity === severity);
    if (priority) response = response.filter(incident => incident.priority?.level === priority);
    response.sort((a, b) => (b.priority?.score || 0) - (a.priority?.score || 0) || new Date(a.firstReportedAt) - new Date(b.firstReportedAt));
    res.json({ incidents: response });
  } catch (error) { next(error); }
});
router.patch('/incidents/:id/status', authenticate, allowRoles('coordinator', 'admin'), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid incident identifier.' });
    const { status } = z.object({ status: z.enum(['active', 'resolved']) }).strict().parse(req.body);
    const incident = await Incident.findById(req.params.id);
    if (!incident) return res.status(404).json({ message: 'Incident not found.' });
    const previousStatus = incident.status;
    incident.status = status;
    incident.resolvedAt = status === 'resolved' ? (previousStatus === 'resolved' ? incident.resolvedAt || new Date() : new Date()) : null;
    incident.responseStatus = status === 'resolved' ? 'resolved' : previousStatus === 'resolved' ? 'reopened' : incident.responseStatus;
    incident.responseHistory.push({ status: incident.responseStatus, update: status === 'resolved' ? 'Incident resolved by coordinator.' : previousStatus === 'resolved' ? 'Incident reopened by coordinator.' : undefined, at: new Date(), actor: req.user.id });
    await incident.save();
    await audit(req, 'incident.status_updated', 'Incident', incident.id, { previousStatus, status });
    const reporters = await EmergencyRequest.distinct('reportedBy', { incidentId: incident._id });
    if (status === 'resolved') {
      const sessions = await LiveLocationSession.find({ incident: incident._id, status: 'active' }).select('_id report requester').lean();
      await LiveLocationSession.updateMany({ incident: incident._id, status: 'active' }, { $set: { status: 'stopped', stoppedAt: new Date() } });
      const providerOwners = await Provider.distinct('owner', { _id: { $in: incident.responders.map(responder => responder.provider) } });
      for (const session of sessions) publishPrivateEvent([session.requester, ...providerOwners], 'live-location-stopped', { incidentId: String(incident._id), reportId: String(session.report), sessionId: String(session._id), stoppedAt: new Date(), reason: 'incident_resolved' });
    }
    await notify(reporters, status === 'resolved' ? 'incident_resolved' : 'incident_reopened', status === 'resolved' ? 'Incident marked resolved' : 'Incident reopened', `${incident.title} was ${status === 'resolved' ? 'marked resolved' : 'reopened'} by a coordinator.`, incident._id);
    publishUserEvent(reporters, 'incident.response.updated', { incidentId: String(incident._id), responseStatus: incident.responseStatus });
    const refreshed = await refreshIncidentStats(incident._id);
    res.json({ message: status === 'active' && previousStatus === 'resolved' ? 'Incident reopened.' : 'Incident status updated.', incident: refreshed });
  } catch (error) { next(error); }
});
router.post('/incidents/:id/claim', authenticate, allowRoles('provider'), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid incident identifier.' });
    const input = z.object({ services: z.array(z.string().trim().min(1).max(100)).max(10).default([]), task: z.string().trim().max(500).optional(), resources: z.array(z.object({ name: z.string().trim().min(1).max(100), quantity: z.number().min(0).max(10000000).optional(), unit: z.string().trim().max(30).optional(), status: z.enum(['planned', 'prepared', 'dispatched', 'delivered', 'unavailable']).default('planned') }).strict()).max(20).default([]) }).strict().parse(req.body || {});
    const provider = await Provider.findOne({ owner: req.user.id });
    if (!provider) return res.status(403).json({ message: 'Submit a responder profile before claiming an incident.' });
    if (provider.verificationStatus !== 'verified') return res.status(403).json({ message: 'Only verified responders can claim incidents.' });
    if (provider.availability === 'unavailable') return res.status(409).json({ message: 'Update your availability before claiming an incident.' });
    const result = await Incident.findOneAndUpdate(
      { _id: req.params.id, status: 'active', responders: { $not: { $elemMatch: { provider: provider._id } } } },
      { $push: { responders: { provider: provider._id, status: 'claimed', services: input.services, task: input.task, resources: input.resources, claimedAt: new Date(), updatedAt: new Date(), statusHistory: [{ status: 'claimed', update: input.task, at: new Date() }] }, responseHistory: { status: 'claimed', provider: provider._id, update: input.task, at: new Date(), actor: req.user.id } }, $set: { responseStatus: 'claimed' } },
      { new: true, runValidators: true },
    );
    if (!result) {
      const exists = await Incident.exists({ _id: req.params.id });
      return exists ? res.status(409).json({ message: 'The incident is resolved or your organization has already joined it.' }) : res.status(404).json({ message: 'Incident not found.' });
    }
    await audit(req, 'incident.responder_claimed', 'Incident', result.id, { providerId: provider.id, services: input.services });
    const reporters = await EmergencyRequest.distinct('reportedBy', { incidentId: result._id });
    await notify(reporters, 'incident_responder_claimed', 'A verified responder joined the incident', `${provider.name} joined ${result.title} to coordinate assistance.`, result._id);
    const otherProviderIds = result.responders.filter(responder => String(responder.provider) !== String(provider._id) && responder.status !== 'withdrawn').map(responder => responder.provider);
    const otherProviders = await Provider.find({ _id: { $in: otherProviderIds } }).select('owner').lean();
    await notify(otherProviders.map(item => item.owner), 'incident_responder_joined', 'Another responder joined your incident', `${provider.name} joined ${result.title}. Review the shared incident response.`, result._id);
    publishUserEvent(reporters, 'incident.response.updated', { incidentId: String(result._id), responseStatus: 'claimed' });
    const refreshed = await refreshIncidentStats(result._id);
    res.status(201).json({ message: 'Incident claimed. You can now update your response progress.', responder: refreshed.responders.id(result.responders.at(-1)._id), incidentId: refreshed._id });
  } catch (error) { next(error); }
});
router.patch('/incidents/:id/responders/:responderId/status', authenticate, async (req, res, next) => {
  try {
    if (![req.params.id, req.params.responderId].every(value => mongoose.isValidObjectId(value))) return res.status(400).json({ message: 'Invalid incident or responder assignment identifier.' });
    const input = z.object({ status: z.enum(['preparing_assistance', 'on_the_way', 'reached_location', 'assistance_in_progress', 'partially_resolved', 'resolved', 'withdrawn']), update: z.string().trim().min(5).max(1000), estimatedArrival: z.string().datetime().nullable().optional(), resources: z.array(z.object({ name: z.string().trim().min(1).max(100), quantity: z.number().min(0).max(10000000).optional(), unit: z.string().trim().max(30).optional(), status: z.enum(['planned', 'prepared', 'dispatched', 'delivered', 'unavailable']) }).strict()).max(20).optional() }).strict().parse(req.body);
    const incident = await Incident.findById(req.params.id);
    if (!incident) return res.status(404).json({ message: 'Incident not found.' });
    if (incident.status === 'resolved') return res.status(409).json({ message: 'Reopen the incident before updating responder progress.' });
    const responder = incident.responders.id(req.params.responderId);
    if (!responder) return res.status(404).json({ message: 'Responder participation was not found.' });
    let provider;
    if (req.user.role === 'provider') {
      provider = await Provider.findOne({ owner: req.user.id, verificationStatus: 'verified' }).select('_id name');
      if (!provider || String(responder.provider) !== String(provider._id)) return res.status(403).json({ message: 'Only your verified organization can update this response.' });
    } else if (!['coordinator', 'admin'].includes(req.user.role)) return res.status(403).json({ message: 'Only the assigned responder or a coordinator can update response progress.' });
    const transitions = { claimed: ['preparing_assistance', 'withdrawn'], preparing_assistance: ['on_the_way', 'withdrawn'], on_the_way: ['reached_location', 'withdrawn'], reached_location: ['assistance_in_progress', 'withdrawn'], assistance_in_progress: ['partially_resolved', 'resolved', 'withdrawn'], partially_resolved: ['assistance_in_progress', 'resolved', 'withdrawn'], resolved: [], withdrawn: [] };
    if (!transitions[responder.status]?.includes(input.status)) return res.status(409).json({ message: `Cannot change response from ${responder.status.replaceAll('_', ' ')} to ${input.status.replaceAll('_', ' ')}.` });
    if (input.status === 'resolved' && input.update.trim().length < 20) return res.status(400).json({ message: 'A resolution update of at least 20 characters is required before marking assistance resolved.' });
    if (input.status === 'withdrawn' && input.update.trim().length < 10) return res.status(400).json({ message: 'A withdrawal reason of at least 10 characters is required.' });
    responder.status = input.status;
    responder.updatedAt = new Date();
    if (input.status === 'preparing_assistance' && !responder.startedAt) responder.startedAt = new Date();
    if (input.status === 'resolved') responder.completedAt = new Date();
    if (input.status === 'withdrawn') responder.withdrawalReason = input.update;
    if (input.estimatedArrival !== undefined) responder.estimatedArrival = input.estimatedArrival ? new Date(input.estimatedArrival) : undefined;
    if (input.resources) responder.resources = input.resources.map(resource => ({ ...resource, updatedAt: new Date() }));
    responder.resolutionUpdate = ['resolved', 'partially_resolved'].includes(input.status) ? input.update : responder.resolutionUpdate;
    responder.statusHistory.push({ status: input.status, update: input.update, at: new Date() });
    incident.responseStatus = undefined;
    incident.responseStatus = deriveIncidentResponseStatus(incident, []);
    incident.responseHistory.push({ status: incident.responseStatus, provider: responder.provider, update: input.update, at: new Date(), actor: req.user.id });
    await incident.save();
    if (['resolved', 'withdrawn'].includes(input.status)) {
      const affectedProvider = provider || await Provider.findById(responder.provider).select('owner');
      if (affectedProvider?.owner) publishPrivateEvent([affectedProvider.owner], 'live-location-access-revoked', { incidentId: String(incident._id), providerId: String(responder.provider), reason: input.status });
    }
    await audit(req, 'incident.response_status_updated', 'Incident', incident.id, { responderId: responder.id, providerId: responder.provider, status: input.status, update: input.update });
    const reporters = await EmergencyRequest.distinct('reportedBy', { incidentId: incident._id });
    await notify(reporters, 'incident_response_update', `${incident.title}: response ${input.status.replaceAll('_', ' ')}`, `A verified responder updated the incident response to ${input.status.replaceAll('_', ' ')}.`, incident._id);
    publishUserEvent(reporters, 'incident.response.updated', { incidentId: String(incident._id), responseStatus: incident.responseStatus });
    const refreshed = await refreshIncidentStats(incident._id);
    res.json({ message: 'Response progress updated.', incident: refreshed });
  } catch (error) { next(error); }
});
router.post('/incidents/:id/resolution-feedback', authenticate, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid incident identifier.' });
    const input = z.object({ action: z.enum(['confirmed_resolved', 'still_present', 'incomplete']), note: z.string().trim().max(500).optional() }).strict().parse(req.body);
    const incident = await Incident.findOne({ _id: req.params.id, reportIds: { $in: await EmergencyRequest.find({ incidentId: req.params.id, reportedBy: req.user._id }).distinct('_id') } });
    if (!incident) return res.status(404).json({ message: 'Only people who reported this incident can submit resolution feedback.' });
    const existing = incident.resolutionFeedback.find(item => String(item.user) === String(req.user._id));
    if (existing) { existing.action = input.action; existing.note = input.note; existing.at = new Date(); }
    else incident.resolutionFeedback.push({ user: req.user._id, action: input.action, note: input.note, at: new Date() });
    const unresolvedCount = incident.resolutionFeedback.filter(item => ['still_present', 'incomplete'].includes(item.action)).length;
    if (unresolvedCount >= 3 && incident.responseStatus === 'resolved') {
      incident.status = 'active';
      incident.responseStatus = 'reopened';
      incident.responseHistory.push({ status: 'reopened', update: 'Community feedback indicates that the issue remains or assistance is incomplete. Coordinator review requested.', actor: req.user._id, at: new Date() });
    }
    await incident.save();
    await audit(req, 'incident.resolution_feedback', 'Incident', incident.id, { action: input.action, unresolvedCount });
    const reporters = await EmergencyRequest.distinct('reportedBy', { incidentId: incident._id });
    publishUserEvent(reporters, 'incident.response.updated', { incidentId: String(incident._id), responseStatus: incident.responseStatus, feedbackUpdated: true });
    if (unresolvedCount >= 3) await notify(reporters, 'incident_review_requested', 'Community reports that more help is needed', `${incident.title} has received multiple reports that the issue remains or is incomplete. A coordinator review is requested.`, incident._id);
    const refreshed = await refreshIncidentStats(incident._id);
    res.status(201).json({ message: 'Your resolution feedback was recorded.', incident: refreshed, reviewRequested: unresolvedCount >= 3 });
  } catch (error) { next(error); }
});
router.post('/incidents/:id/recalculate', authenticate, allowRoles('coordinator', 'admin'), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid incident identifier.' });
    const incident = await refreshIncidentStats(req.params.id);
    if (!incident) return res.status(404).json({ message: 'Incident not found.' });
    res.json({ message: 'Incident statistics recalculated.', incident });
  } catch (error) { next(error); }
});
router.patch('/incidents/:id/reports/:reportId/recluster', authenticate, allowRoles('admin'), async (req, res, next) => {
  try {
    if (![req.params.id, req.params.reportId].every(value => mongoose.isValidObjectId(value))) return res.status(400).json({ message: 'Invalid incident or report identifier.' });
    const { targetIncidentId = null, notes = '' } = z.object({ targetIncidentId: z.string().regex(/^[a-f\d]{24}$/i).nullable().optional(), notes: z.string().trim().min(5).max(500) }).strict().parse(req.body);
    if (targetIncidentId && targetIncidentId === req.params.id) return res.status(400).json({ message: 'Choose another incident or leave the destination empty to create a separate cluster.' });
    const [source, report, target] = await Promise.all([
      Incident.findById(req.params.id), EmergencyRequest.findById(req.params.reportId),
      targetIncidentId ? Incident.findOne({ _id: targetIncidentId, status: 'active' }) : Promise.resolve(null),
    ]);
    if (!source || !report) return res.status(404).json({ message: 'Incident or complaint not found.' });
    if (String(report.incidentId) !== String(source._id)) return res.status(409).json({ message: 'The complaint is not linked to this incident.' });
    if (targetIncidentId && !target) return res.status(404).json({ message: 'Active destination incident not found.' });
    report.incidentId = target?._id;
    await report.save();
    source.reportIds.pull(report._id);
    source.reportCount = Math.max(0, source.reportCount - 1);
    if (source.reportCount === 0) source.status = 'resolved';
    await source.save();
    if (target) { target.reportIds.addToSet(report._id); target.reportCount += 1; await target.save(); }
    else {
      report.incidentId = undefined;
      await report.save();
      const created = await attachReportToIncident(report, { excludeIncidentId: source._id });
      await audit(req, 'incident.report_reclustered', 'Incident', source.id, { reportId: report.id, targetIncidentId: created.incident._id, notes });
      await audit(req, 'incident.report_added_by_admin', 'Incident', created.incident.id, { reportId: report.id, sourceIncidentId: source.id, notes });
      await refreshIncidentStats(source._id);
      const refreshedCreated = await refreshIncidentStats(created.incident._id);
      return res.json({ message: 'Complaint moved to a separate incident cluster.', incident: refreshedCreated });
    }
    await audit(req, 'incident.report_reclustered', 'Incident', source.id, { reportId: report.id, targetIncidentId: target.id, notes });
    await audit(req, 'incident.report_added_by_admin', 'Incident', target.id, { reportId: report.id, sourceIncidentId: source.id, notes });
    await refreshIncidentStats(source._id);
    const refreshedTarget = await refreshIncidentStats(target._id);
    res.json({ message: 'Complaint moved to the selected incident.', incident: refreshedTarget });
  } catch (error) { next(error); }
});
router.get('/incidents/:id', authenticate, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid incident identifier.' });
    let viewerProvider = null;
    if (req.user.role === 'provider') {
      viewerProvider = await Provider.findOne({ owner: req.user.id, verificationStatus: 'verified' }).select('_id');
      if (!viewerProvider) return res.status(403).json({ message: 'Only verified responders can view incident response details.' });
    } else if (!['coordinator', 'admin'].includes(req.user.role)) return res.status(403).json({ message: 'Incident response details are limited to verified responders and coordinators.' });
    const incident = await Incident.findById(req.params.id).populate([{ path: 'reportIds', select: '-contact -reportedBy -communityConfirmations.user -evidence.storageKey -evidence.uploadedBy', populate: [{ path: 'assignments.provider', select: 'name category' }, { path: 'coordinationNotes.author', select: 'name role' }], options: { sort: { reportedAt: 1, createdAt: 1 } } }, { path: 'responders.provider', select: 'name providerType verificationStatus skills serviceCategories availability contactMethod' }]).lean();
    if (!incident) return res.status(404).json({ message: 'Incident not found.' });
    const activeResponderStatuses = ['claimed', 'preparing_assistance', 'on_the_way', 'reached_location', 'assistance_in_progress', 'partially_resolved'];
    const isParticipant = viewerProvider && incident.status === 'active' && incident.responders?.some(responder => String(responder.provider?._id || responder.provider) === String(viewerProvider._id) && activeResponderStatuses.includes(responder.status));
    if (viewerProvider && incident.status !== 'active' && !isParticipant) return res.status(404).json({ message: 'Incident not found.' });
    const canSeePreciseLocations = !viewerProvider || isParticipant;
    const reportIds = (incident.reportIds || []).map(report => report._id);
    const logs = await AuditLog.find({ $or: [{ targetType: 'EmergencyRequest', targetId: { $in: reportIds }, action: { $in: ['request.status_updated', 'request.provider_assigned', 'assignment.accepted', 'assignment.in_progress', 'assignment.fulfilled', 'request.community_confirmed', 'request.evidence_added', 'request.priority_overridden', 'request.fulfillment_confirmed', 'request.fulfillment_disputed', 'request.review_started', 'request.updated', 'request.verified', 'request.disputed', 'request.marked_duplicate'] } }, { targetType: 'Incident', targetId: incident._id, action: { $in: ['incident.status_updated', 'incident.response_status_updated', 'incident.responder_claimed', 'incident.report_reclustered', 'incident.report_added_by_admin'] } }] }).populate('actor', 'name role').sort({ createdAt: 1 }).limit(500).lean();
    const reports = (incident.reportIds || []).map(report => ({ ...report, reportedAt: report.reportedAt || report.createdAt, location: { label: report.location?.label || 'Location not provided', coordinatesAuthorized: Boolean(report.location?.coordinatesAuthorized && canSeePreciseLocations), coordinates: report.location?.coordinatesAuthorized && canSeePreciseLocations ? report.location.coordinates : null, accuracyMeters: report.location?.coordinatesAuthorized && canSeePreciseLocations ? report.location.accuracyMeters : null, capturedAt: report.location?.coordinatesAuthorized && canSeePreciseLocations ? report.location.capturedAt : null, source: report.location?.coordinatesAuthorized && canSeePreciseLocations ? report.location.source : null }, verificationStatus: verificationStatus(report), confirmationCount: report.communityConfirmations?.length || 0, communityFeedback: feedbackCounts(report.communityConfirmations), evidence: (report.evidence || []).map(publicEvidence) }));
    const summary = (await listIncidentSummaries([incident]))[0];
    const actors = await User.find({ _id: { $in: (incident.responseHistory || []).map(entry => entry.actor).filter(Boolean) } }).select('name role').lean();
    const actorById = new Map(actors.map(actor => [String(actor._id), actor]));
    const responseHistory = (incident.responseHistory || []).map(entry => ({ at: entry.at, action: `response_${entry.status}`, reportId: null, actor: actorById.get(String(entry.actor))?.name || 'Responder / coordinator', role: actorById.get(String(entry.actor))?.role, details: entry.update }));
    res.json({ incident: { ...summary, responseStatus: incident.responseStatus || 'reported', responderCount: (incident.responders || []).filter(responder => responder.status !== 'withdrawn').length, responders: (incident.responders || []).map(responder => ({ _id: responder._id, provider: responder.provider ? { _id: responder.provider._id, name: responder.provider.name, providerType: responder.provider.providerType, verificationStatus: responder.provider.verificationStatus, skills: responder.provider.skills, serviceCategories: responder.provider.serviceCategories, availability: responder.provider.availability, ...( ['coordinator', 'admin'].includes(req.user.role) ? { contactMethod: responder.provider.contactMethod } : {}) } : null, status: responder.status, services: responder.services, task: responder.task, resources: responder.resources || [], estimatedArrival: responder.estimatedArrival, startedAt: responder.startedAt, completedAt: responder.completedAt, withdrawalReason: responder.withdrawalReason, claimedAt: responder.claimedAt, updatedAt: responder.updatedAt, resolutionUpdate: responder.resolutionUpdate, statusHistory: responder.statusHistory || [] })), verificationStatus: reports.length && reports.every(report => report.verification?.state === 'verified') ? 'officially verified' : reports.some(report => report.verification?.state === 'verified') ? 'partially verified' : reports.some(report => report.verificationStatus === 'community supported') ? 'community supported' : 'unverified', reports, priorityHistory: incident.priorityHistory || [], timeline: [...logs.map(log => ({ at: log.createdAt || log.timestamp, action: log.action, reportId: log.targetId, actor: log.actor?.name || 'System', role: log.actor?.role, details: log.details || log.relevantChanges })), ...responseHistory].sort((a, b) => new Date(a.at) - new Date(b.at)) } });
  } catch (error) { next(error); }
});
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const request = await EmergencyRequest.findById(req.params.id).populate('reportedBy', 'name organization').populate('assignments.provider', 'name category verified availability lastAvailabilityUpdated').populate('reporterUpdates.author', 'name').lean();
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    if (!['coordinator', 'admin'].includes(req.user.role)) {
      const isRequester = String(request.reportedBy?._id || request.reportedBy) === req.user.id;
      const provider = req.user.role === 'provider' ? await Provider.findOne({ owner: req.user.id }).select('_id') : null;
      const acceptedAssignment = provider && request.assignments?.some(a => String(a.provider?._id || a.provider) === String(provider._id) && ['accepted', 'in_progress', 'partially_fulfilled'].includes(a.status));
      const hasAssignment = provider && request.assignments?.some(a => String(a.provider?._id || a.provider) === String(provider._id));
      if (!isRequester && !hasAssignment) return res.status(403).json({ message: 'You may only view your own requests or assigned requests.' });
      if (!isRequester && !acceptedAssignment) { delete request.contact; if (request.location) { delete request.location.coordinates; delete request.location.accuracyMeters; delete request.location.capturedAt; delete request.location.source; request.location.label = 'Location withheld until provider acceptance.'; } }
    }
    request.reportedAt = request.reportedAt || request.createdAt;
    Object.assign(request, withPriority(request));
    request.verificationStatus = verificationStatus(request);
    request.confirmationCount = request.communityConfirmations?.length || 0;
    request.communityFeedback = feedbackCounts(request.communityConfirmations);
    const viewerResponse = request.communityConfirmations?.find(item => String(item.user) === String(req.user._id));
    request.viewerCommunityAction = viewerResponse ? viewerResponse.action || 'confirm_issue' : null;
    request.canManageEvidence = ['coordinator', 'admin'].includes(req.user.role) || String(request.reportedBy?._id || request.reportedBy) === String(req.user._id);
    delete request.communityConfirmations;
    request.evidence = (request.evidence || []).map(publicEvidence);
    if (req.user.role === 'provider') { delete request.evidence; delete request.confirmationCount; delete request.communityFeedback; delete request.viewerCommunityAction; delete request.verificationStatus; }
    res.json({ request: withPriority(request) });
  } catch (error) { next(error); }
});
router.post('/', authenticate, allowRoles('requester', 'coordinator', 'admin'), async (req, res, next) => {
  try {
    const input = requestInput.parse(req.body);
    if ((Boolean(input.clientReportId) !== Boolean(input.clientCreatedAt)) || (input.offlineSync && !input.clientReportId)) return res.status(400).json({ message: 'Offline report ID and original creation time must be provided together.' });
    if (!input.offlineSync && new Date(input.responseDeadline) <= new Date()) return res.status(400).json({ message: 'Response deadline must be in the future.' });
    if (input.clientReportId) {
      const prior = await EmergencyRequest.findOne({ reportedBy: req.user.id, clientReportId: input.clientReportId }).select('_id incidentId status').lean();
      if (prior) return res.status(200).json({ message: 'This offline report was already synchronized.', request: { _id: prior._id, incidentId: prior.incidentId, status: prior.status }, duplicate: true });
    }
    const [longitude, latitude] = input.location.coordinates || [null, null];
    let emergencyRequest;
    try {
      const synchronizedAt = new Date();
      const requestedDeadline = new Date(input.responseDeadline);
      const effectiveDeadline = input.offlineSync && requestedDeadline <= synchronizedAt ? new Date(synchronizedAt.getTime() + 60 * 60 * 1000) : requestedDeadline;
      emergencyRequest = await EmergencyRequest.create({ ...input, reportedAt: synchronizedAt, clientReportedAt: input.clientReportId && input.clientCreatedAt ? new Date(input.clientCreatedAt) : undefined, synchronizedAt: input.offlineSync ? synchronizedAt : undefined, originalResponseDeadline: input.offlineSync ? requestedDeadline : undefined, latitude: input.location.coordinatesAuthorized ? latitude : null, longitude: input.location.coordinatesAuthorized ? longitude : null, requestId: `RQ-${randomUUID().slice(0, 8).toUpperCase()}`, responseDeadline: effectiveDeadline, location: { label: input.location.label, coordinatesAuthorized: input.location.coordinatesAuthorized, coordinates: input.location.coordinatesAuthorized ? input.location.coordinates || [0, 0] : [0, 0], accuracyMeters: input.location.accuracyMeters, capturedAt: input.location.capturedAt ? new Date(input.location.capturedAt) : undefined, source: input.location.source }, reportedBy: req.user.id, status: 'reported', verification: { state: 'unverified' } });
    } catch (error) {
      if (error.code === 11000 && input.clientReportId) {
        const prior = await EmergencyRequest.findOne({ reportedBy: req.user.id, clientReportId: input.clientReportId }).select('_id incidentId status').lean();
        if (prior) return res.status(200).json({ message: 'This offline report was already synchronized.', request: { _id: prior._id, incidentId: prior.incidentId, status: prior.status }, duplicate: true });
      }
      throw error;
    }
    const clustered = await attachReportToIncident(emergencyRequest);
    await audit(req, 'request.created', 'EmergencyRequest', emergencyRequest.id, { urgency: input.urgency, category: input.category, emergencyType: input.emergencyType, incidentId: clustered.incident.incidentId });
    await notify([req.user.id], 'request_created', 'Request submitted', `${input.title} was submitted and is awaiting coordinator verification.`, emergencyRequest.id);
    const liveIncident = liveIncidentPayload(clustered.incident, clustered.priority, clustered.recentReportCount, clustered.worsening);
    try {
      const resolvers = await User.find({ role: { $in: ['coordinator', 'admin'] }, active: true }).select('_id').lean();
      await notify(resolvers.map(user => user._id), 'incident_report_update', `${clustered.incident.emergencyType} incident updated`, `${liveIncident.reportCount} report(s) received near ${liveIncident.location}; estimated people affected: ${liveIncident.estimatedAffectedPeople}.`, emergencyRequest._id);
    } catch (notificationError) { console.error('Could not notify resolvers about an incident report:', notificationError.message); }
    try {
      const providers = await Provider.find({ verificationStatus: 'verified', availability: { $in: ['available', 'limited'] } }).select('owner category serviceCategories skills inventory availability location serviceRadiusKm').lean();
      const requiredTerms = [emergencyRequest.requiredService, emergencyRequest.category, ...(emergencyRequest.requiredSkills || [])].filter(Boolean).map(value => value.trim().toLowerCase());
      const matching = providers.filter(provider => {
        const capabilities = [provider.category, ...(provider.serviceCategories || []), ...(provider.skills || [])].filter(Boolean).map(value => value.trim().toLowerCase());
        if (!requiredTerms.some(need => capabilities.some(capability => capability === need))) return false;
        return (emergencyRequest.items || []).every(need => (provider.inventory || []).some(stock => stock.resource?.trim().toLowerCase() === need.resource.trim().toLowerCase() && stock.unit?.trim().toLowerCase() === need.unit.trim().toLowerCase() && Number(stock.availableQuantity ?? stock.quantity ?? 0) >= Number(need.quantity)));
      });
      for (const provider of matching) {
        await notify([provider.owner], 'provider_incident_match', 'An incident matches listed provider capabilities', `${clustered.incident.title}: a report lists a service and resources matching your verified provider profile. Review the incident before deciding whether to respond.`, clustered.incident._id);
      }
      if (clustered.priority?.level === 'P1' && clustered.incident.location?.coordinatesAuthorized) {
        const nearby = matching.filter(provider => {
          const origin = provider.location?.coordinates, target = clustered.incident.location?.coordinates;
          return origin?.some(value => value !== 0) && target?.length === 2 && distanceBetweenKm(origin, target) <= Number(provider.serviceRadiusKm || 0);
        });
        for (const provider of nearby) await notify([provider.owner], 'provider_critical_area', 'Critical emergency in your operational area', `${clustered.incident.title} is within your configured service radius based on locations shared for coordination.`, clustered.incident._id);
      }
      const history = clustered.incident.priorityHistory || [];
      const previousPriority = history.length > 1 ? history.at(-2)?.score : null;
      if (previousPriority !== null && clustered.priority?.score > previousPriority) {
        const participantIds = clustered.incident.responders?.filter(responder => responder.status !== 'withdrawn').map(responder => responder.provider) || [];
        const participants = await Provider.find({ _id: { $in: participantIds } }).select('owner').lean();
        await notify(participants.map(provider => provider.owner), 'incident_priority_increased', 'Incident priority increased', `${clustered.incident.title} now has a higher recorded priority score. Review the updated incident details.`, clustered.incident._id);
      }
    } catch (notificationError) { console.error('Could not notify providers about the incident:', notificationError.message); }
    publishLiveEvent('incident.updated', liveIncident);
    const incidentReporters = await EmergencyRequest.distinct('reportedBy', { incidentId: clustered.incident._id });
    publishUserEvent(incidentReporters, 'incident.response.updated', { incidentId: String(clustered.incident._id), reportCount: liveIncident.reportCount, responseStatus: liveIncident.responseStatus });
    res.status(201).json({ message: 'Complaint created and linked to a live incident.', request: { ...emergencyRequest.toObject(), reportedAt: emergencyRequest.createdAt, incidentId: clustered.incident._id, incident: liveIncident, priority: withPriority(emergencyRequest.toObject()).priority, verificationStatus: 'unverified', confirmationCount: 0 }, safetyNotice: input.urgency === 'critical' ? 'If anyone is in immediate life-threatening danger, contact official emergency services now. Sahayak does not replace emergency dispatch.' : undefined });
  } catch (error) { next(error); }
});
router.post('/:id/updates', authenticate, allowRoles('requester', 'coordinator', 'admin'), async (req, res, next) => {
  try {
    const { body, clientUpdateId } = z.object({ body: z.string().trim().min(5).max(1000), clientUpdateId: z.string().uuid().optional() }).strict().parse(req.body);
    const request = await EmergencyRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Report not found.' });
    if (req.user.role === 'requester' && String(request.reportedBy) !== req.user.id) return res.status(403).json({ message: 'You may only add information to your own report.' });
    const previousUpdate = clientUpdateId && request.reporterUpdates.find(update => update.clientUpdateId === clientUpdateId && String(update.author) === String(req.user._id));
    if (previousUpdate) return res.json({ message: 'This update was already received.', update: previousUpdate, duplicate: true });
    request.reporterUpdates.push({ author: req.user._id, body, clientUpdateId });
    await request.save();
    await audit(req, 'request.reporter_update_added', 'EmergencyRequest', request.id, { updateId: request.reporterUpdates.at(-1)._id });
    const coordinators = await User.distinct('_id', { role: { $in: ['coordinator', 'admin'] }, active: true });
    const activeProviderIds = request.assignments.filter(assignment => ['accepted', 'in_progress', 'partially_fulfilled'].includes(assignment.status)).map(assignment => assignment.provider);
    const activeResponders = request.incidentId ? await Incident.findById(request.incidentId).select('responders').lean() : null;
    const responderProviderIds = (activeResponders?.responders || []).filter(responder => ['claimed','preparing_assistance','on_the_way','reached_location','assistance_in_progress','partially_resolved'].includes(responder.status)).map(responder => responder.provider);
    const providersToNotify = await Provider.distinct('owner', { _id: { $in: [...activeProviderIds, ...responderProviderIds] }, verificationStatus: 'verified' });
    await notify([...coordinators, ...providersToNotify, request.reportedBy], 'request_reporter_update', 'New information added to a report', `The reporter added information to ${request.title}.`, request.id);
    publishLiveEvent('request.updated', { requestId: String(request._id), incidentId: request.incidentId ? String(request.incidentId) : null, action: 'reporter_update_added' });
    res.status(201).json({ message: 'Additional information added to the report.', update: request.reporterUpdates.at(-1) });
  } catch (error) { next(error); }
});
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const request = await EmergencyRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    if (!['coordinator', 'admin'].includes(req.user.role)) {
      if (!['requester', 'reporter'].includes(req.user.role) || String(request.reportedBy) !== req.user.id) return res.status(403).json({ message: 'You may only edit your own request.' });
      if (request.assignments.some(a => ['offered', 'accepted', 'in_progress', 'partially_fulfilled'].includes(a.status))) return res.status(409).json({ message: 'Requests with active assignments cannot be edited.' });
    }
    const editable = requestInput.omit({ clientReportId: true, clientCreatedAt: true, offlineSync: true }).partial().parse(req.body);
    Object.assign(request, editable);
    if (editable.responseDeadline) request.responseDeadline = new Date(editable.responseDeadline);
    await request.save();
    await audit(req, 'request.updated', 'EmergencyRequest', request.id, Object.keys(editable));
    if (request.incidentId) await refreshIncidentStats(request.incidentId);
    res.json({ request: withPriority(request.toObject()) });
  } catch (error) { next(error); }
});
router.patch('/:id/status', authenticate, allowRoles('coordinator', 'admin'), async (req, res, next) => {
  try {
    const { status } = z.object({ status: z.enum(['submitted', 'under_review', 'matching', 'awaiting_confirmation', 'accepted', 'in_progress', 'partially_fulfilled', 'fulfilled', 'cancelled', 'expired']) }).parse(req.body);
    const request = await EmergencyRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    const transitions = { reported: ['submitted', 'under_review', 'cancelled'], submitted: ['under_review', 'cancelled'], under_review: ['matching', 'cancelled'], verified: ['matching', 'awaiting_match', 'cancelled'], awaiting_match: ['matching', 'cancelled', 'expired'], matching: ['awaiting_confirmation', 'accepted', 'cancelled', 'expired'], assigned: ['accepted', 'in_progress', 'partially_fulfilled', 'cancelled'], accepted: ['in_progress', 'cancelled'], in_progress: ['partially_fulfilled', 'awaiting_confirmation', 'fulfilled', 'cancelled'], partially_fulfilled: ['in_progress', 'awaiting_confirmation', 'fulfilled', 'cancelled'], awaiting_confirmation: ['fulfilled', 'in_progress'], fulfilled: [], cancelled: [], expired: [] };
    if (!transitions[request.status]?.includes(status)) return res.status(409).json({ message: `Cannot change request status from ${request.status} to ${status}.` });
    if (status === 'fulfilled' && !request.fulfillmentConfirmation?.confirmed) return res.status(409).json({ message: 'Fulfillment must be confirmed before closing the request.' });
    if (status === 'expired' && request.responseDeadline > new Date()) return res.status(409).json({ message: 'A request cannot be expired before its response deadline.' });
    if (status === 'cancelled' && request.assignments.some(assignment => ['offered', 'accepted', 'in_progress', 'partially_fulfilled'].includes(assignment.status))) return res.status(409).json({ message: 'Cancel active assignments before cancelling the request so reserved resources can be released safely.' });
    request.status = status;
    await request.save();
    await audit(req, 'request.status_updated', 'EmergencyRequest', request.id, { status });
    if (request.incidentId) await refreshIncidentStats(request.incidentId);
    res.json({ request: withPriority(request.toObject()) });
  } catch (error) { next(error); }
});
router.patch('/:id/priority', authenticate, allowRoles('admin'), async (req, res, next) => {
  try {
    const input = z.object({ level: z.enum(['P1', 'P2', 'P3', 'P4']), score: z.number().int().min(0).max(100), reason: z.string().trim().min(5).max(500) }).strict().superRefine((value, context) => {
      const expected = value.score >= 80 ? 'P1' : value.score >= 60 ? 'P2' : value.score >= 35 ? 'P3' : 'P4';
      if (value.level !== expected) context.addIssue({ code: z.ZodIssueCode.custom, path: ['level'], message: `Level must match the score (${expected}).` });
    }).parse(req.body);
    const request = await EmergencyRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    const previous = withPriority(request.toObject()).priority;
    const severity = input.level === 'P1' ? 'Critical' : input.level === 'P2' ? 'High' : input.level === 'P3' ? 'Medium' : 'Low';
    request.priorityOverride = { ...input, severity, updatedBy: req.user.id, updatedAt: new Date() };
    await request.save();
    await audit(req, 'request.priority_overridden', 'EmergencyRequest', request.id, { previous: { level: previous.level, score: previous.score }, current: input, reason: input.reason });
    if (request.incidentId) await refreshIncidentStats(request.incidentId);
    res.json({ request: withPriority(request.toObject()) });
  } catch (error) { next(error); }
});
router.delete('/:id/priority', authenticate, allowRoles('admin'), async (req, res, next) => {
  try {
    const request = await EmergencyRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    const previous = request.priorityOverride?.toObject?.() || request.priorityOverride || null;
    request.set('priorityOverride', undefined);
    await request.save();
    await audit(req, 'request.priority_override_cleared', 'EmergencyRequest', request.id, { previous });
    if (request.incidentId) await refreshIncidentStats(request.incidentId);
    res.json({ request: withPriority(request.toObject()) });
  } catch (error) { next(error); }
});
const matchesHandler = async (req, res, next) => {
  try {
    const request = await EmergencyRequest.findById(req.params.id).lean();
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    if (['requester', 'reporter'].includes(req.user.role) && String(request.reportedBy) !== req.user.id) return res.status(403).json({ message: 'You can only view recommendations for your own request.' });
    if (req.user.role === 'provider') return res.status(403).json({ message: 'Provider accounts cannot browse request recommendations.' });
    if (request.verification?.state !== 'verified') return res.status(409).json({ message: 'A coordinator must verify this request before matching.' });
    if (!['verified', 'awaiting_match', 'matching'].includes(request.status)) return res.status(409).json({ message: 'This request is not in a matchable status.' });
    if (request.responseDeadline && request.responseDeadline <= new Date()) return res.status(409).json({ message: 'The response deadline has passed. This request cannot be matched.' });
    const completeness = requestInput.safeParse({ title: request.title, category: request.category, description: request.description, requiredService: request.requiredService, items: request.items, requiredSkills: request.requiredSkills || [], affectedPeople: request.affectedPeople, responseDeadline: request.responseDeadline?.toISOString(), contact: request.contact, location: { label: request.location?.label, coordinatesAuthorized: Boolean(request.location?.coordinatesAuthorized), ...(request.location?.coordinatesAuthorized ? { coordinates: request.location.coordinates } : {}) }, urgency: request.urgency });
    if (!completeness.success) return res.status(409).json({ message: 'This request has incomplete or invalid details and cannot be matched.', details: completeness.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
    const providers = await Provider.find({ verificationStatus: { $ne: 'suspended' } }).limit(500).lean();
    const assignments = await EmergencyRequest.aggregate([{ $unwind: '$assignments' }, { $match: { 'assignments.status': { $in: ['offered', 'accepted', 'in_progress', 'partially_fulfilled'] } } }, { $group: { _id: '$assignments.provider', count: { $sum: 1 } } }]);
    const activeLoads = new Map(assignments.map(row => [String(row._id), row.count]));
    const history = await loadProviderMatchHistory(providers.map(provider => provider._id));
    const ranked = providers.map(provider => evaluateMatch(request, provider, { ...history.get(String(provider._id)), activeLoad: activeLoads.get(String(provider._id)) || 0 }))
      .sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.score ?? -1) - (a.score ?? -1));
    const eligible = ranked.filter(match => match.eligible);
    const ineligible = ranked.filter(match => !match.eligible);
    const matches = [...eligible.slice(0, 20), ...ineligible.slice(0, eligible.length < 3 ? 5 : 5)];
    const minutesRemaining = Math.max(0, Math.ceil((new Date(request.responseDeadline).getTime() - Date.now()) / 60000));
    const unmetCriteria = [...new Set(ineligible.flatMap(match => match.limitations).filter(text => !text.startsWith('Scoring uncertainty:')))];
    const summary = eligible.length
      ? `${eligible.length} provider${eligible.length === 1 ? '' : 's'} passed all mandatory checks. Review the ranked candidates and confirm assignment according to coordination policy.`
      : providers.length
        ? `No provider currently satisfies every mandatory check. Criteria not met across the candidates include: ${unmetCriteria.slice(0, 5).join('; ') || 'mandatory information is incomplete'}. Consider broadening the service area, clarifying qualifications, or requesting additional resources.`
        : 'No provider profiles are available to evaluate. Register or request additional providers, then review matches again.';
    res.json({ requestId: request.requestId, matches, summary, coordinationPriority: { urgency: request.urgency, requiredBy: request.responseDeadline, minutesRemaining }, scoring: matchingModel, notice: request.verification.state !== 'verified' ? 'This request is unverified. Confirm details before assignment.' : undefined });
  } catch (error) { next(error); }
};
router.get('/:id/matches', authenticate, matchesHandler);
router.post('/:id/matches', authenticate, allowRoles('requester', 'coordinator', 'admin'), matchesHandler);
router.post('/:id/verify', authenticate, allowRoles('coordinator', 'admin'), async (req, res, next) => {
  try {
    const { state, notes } = z.object({ state: z.enum(['verified', 'disputed']), notes: z.string().trim().max(1000).optional() }).parse(req.body);
    const request = await EmergencyRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    if (state === 'verified' && request.responseDeadline && request.responseDeadline <= new Date()) return res.status(409).json({ message: 'The response deadline has passed; this request is expired.' });
    if (state === 'verified') {
      const valid = requestInput.safeParse({ title: request.title, category: request.category, description: request.description, requiredService: request.requiredService, items: request.items, requiredSkills: request.requiredSkills || [], affectedPeople: request.affectedPeople, responseDeadline: request.responseDeadline?.toISOString(), contact: request.contact, location: { label: request.location?.label, coordinatesAuthorized: Boolean(request.location?.coordinatesAuthorized), ...(request.location?.coordinatesAuthorized ? { coordinates: request.location.coordinates } : {}) }, urgency: request.urgency });
      if (!valid.success) return res.status(400).json({ message: 'Request details must be corrected before verification.', details: valid.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
    }
    request.verification = { state, notes, verifiedBy: req.user.id, verifiedAt: new Date() };
    if (state === 'verified') request.status = 'verified';
    await request.save();
    await audit(req, `request.${state}`, 'EmergencyRequest', request.id, { notes });
    if (request.incidentId) await refreshIncidentStats(request.incidentId);
    await notify([request.reportedBy], 'request_verification', `Request ${state}`, notes || `Your request “${request.title}” was ${state}.`, request.id);
    res.json({ request: withPriority(request.toObject()) });
  } catch (error) { next(error); }
});
router.post('/:id/review', authenticate, allowRoles('coordinator', 'admin'), async (req, res, next) => {
  try {
    const request = await EmergencyRequest.findOneAndUpdate({ _id: req.params.id, status: { $in: ['reported', 'submitted', 'under_review'] }, responseDeadline: { $gt: new Date() } }, { $set: { status: 'under_review' } }, { new: true, runValidators: true });
    if (!request) return res.status(409).json({ message: 'Request is not available for review.' });
    await audit(req, 'request.review_started', 'EmergencyRequest', request.id);
    await notify([request.reportedBy], 'request_review', 'Request under review', `${request.title} is being reviewed by a coordinator.`, request.id);
    res.json({ request: withPriority(request.toObject()) });
  } catch (error) { next(error); }
});
const assignHandler = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const input = z.object({ providerId: z.string().regex(/^[a-f\d]{24}$/i), matchScore: z.number().min(0).max(100), matchReasons: z.array(z.string().max(300)).max(10).default([]), limitations: z.array(z.string().max(300)).max(10).default([]), allocatedItems: z.array(item).min(1).max(50) }).parse(req.body);
    let updated;
    await session.withTransaction(async () => {
      const request = await EmergencyRequest.findOne({ _id: req.params.id, status: { $in: ['verified', 'awaiting_match'] }, 'verification.state': 'verified' }).session(session);
      if (!request) throw Object.assign(new Error('Request must be verified and unassigned before allocation.'), { status: 409 });
      if (request.responseDeadline && request.responseDeadline <= new Date()) throw Object.assign(new Error('The response deadline has passed; expired requests cannot be assigned.'), { status: 409 });
      if (request.assignments.some(a => ['offered', 'accepted', 'in_progress', 'partially_fulfilled'].includes(a.status))) throw Object.assign(new Error('This request already has an active allocation.'), { status: 409 });
      const provider = await Provider.findOne({ _id: input.providerId, verificationStatus: { $ne: 'suspended' } }).session(session);
      if (!provider) throw Object.assign(new Error('Provider is unavailable.'), { status: 409 });
      const activeLoad = await EmergencyRequest.countDocuments({ _id: { $ne: request._id }, assignments: { $elemMatch: { provider: provider._id, status: { $in: ['offered', 'accepted', 'in_progress', 'partially_fulfilled'] } } } }).session(session);
      const history = await loadProviderMatchHistory([provider._id], session);
      const verifiedMatch = evaluateMatch(request, provider, { ...history.get(String(provider._id)), activeLoad });
      if (!verifiedMatch.eligible) throw Object.assign(new Error(`Provider is not eligible: ${verifiedMatch.limitations.join('; ') || 'match criteria are not met'}.`), { status: 409 });
      const requestedTotals = totalsByResource(request.items), allocationTotals = totalsByResource(input.allocatedItems);
      const fullyAllocated = requestedTotals.size === allocationTotals.size && [...requestedTotals].every(([key, quantity]) => allocationTotals.get(key) === quantity);
      if (!fullyAllocated) throw Object.assign(new Error('The allocation must cover every requested resource quantity exactly.'), { status: 409 });
      for (const allocation of input.allocatedItems) {
        const stock = provider.inventory.find(i => i.resource.toLowerCase() === allocation.resource.toLowerCase() && i.unit.toLowerCase() === allocation.unit.toLowerCase());
        const available = stock ? stock.availableQuantity ?? stock.quantity ?? 0 : 0;
        if (!stock || available < allocation.quantity) throw Object.assign(new Error(`Insufficient unreserved inventory for ${allocation.resource}.`), { status: 409 });
        stock.availableQuantity = available - allocation.quantity;
        stock.quantity = undefined;
        stock.reservedQuantity = (stock.reservedQuantity || 0) + allocation.quantity;
        stock.updatedAt = new Date();
      }
      await provider.save({ session });
      request.assignments.push({ provider: provider.id, matchScore: verifiedMatch.score, matchReasons: verifiedMatch.reasons, limitations: verifiedMatch.limitations, allocatedItems: input.allocatedItems, status: 'offered' });
      request.status = 'awaiting_confirmation';
      updated = await request.save({ session });
    });
    await audit(req, 'request.provider_assigned', 'EmergencyRequest', updated.id, { providerId: input.providerId, matchScore: updated.assignments.at(-1)?.matchScore });
    if (updated.incidentId) await refreshIncidentStats(updated.incidentId);
    const provider = await Provider.findById(input.providerId).select('owner name');
    await notify([provider?.owner, updated.reportedBy], 'request_assigned', 'Provider assignment offered', `${provider?.name || 'A provider'} was assigned to ${updated.title} and must accept.`, updated.id);
    res.status(201).json({ request: updated });
  } catch (error) { next(error); }
  finally { await session.endSession(); }
};
router.post('/:id/assign', authenticate, allowRoles('coordinator', 'admin'), assignHandler);
router.post('/:id/assignments', authenticate, allowRoles('coordinator', 'admin'), assignHandler);
export const updateAssignmentStatus = async (req, res, next) => {
  try {
    const { status, eta, providerNote, consumedItems = [] } = z.object({ status: z.enum(['accepted', 'declined', 'in_progress', 'partially_fulfilled', 'fulfilled', 'cancelled']), eta: z.string().datetime().optional(), providerNote: z.string().trim().max(1000).optional(), consumedItems: z.array(item).max(50).optional() }).parse(req.body);
    const request = await EmergencyRequest.findById(req.params.id).populate('assignments.provider');
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    const assignment = request.assignments.id(req.params.assignmentId);
    if (!assignment) return res.status(404).json({ message: 'Assignment not found.' });
    if (status === 'accepted' && request.responseDeadline && request.responseDeadline <= new Date()) return res.status(409).json({ message: 'This request has expired and can no longer be accepted.' });
    if (req.user.role === 'provider' && String(assignment.provider.owner) !== req.user.id) return res.status(403).json({ message: 'This assignment belongs to another provider.' });
    if (['requester', 'reporter'].includes(req.user.role)) return res.status(403).json({ message: 'Requesters cannot change provider assignment status.' });
    if (req.user.role === 'provider' && !['accepted', 'declined', 'in_progress', 'partially_fulfilled', 'fulfilled'].includes(status)) return res.status(403).json({ message: 'Providers cannot cancel assignments.' });
    const allowed = { offered: ['accepted', 'declined', 'cancelled'], accepted: ['in_progress', 'cancelled'], in_progress: ['fulfilled', 'partially_fulfilled', 'cancelled'], partially_fulfilled: ['fulfilled', 'in_progress', 'cancelled'], declined: [], fulfilled: [], cancelled: [] };
    if (!allowed[assignment.status]?.includes(status)) return res.status(409).json({ message: `Cannot change ${assignment.status} to ${status}.` });
    const previousStatus = assignment.status;
    const allocatedTotals = totalsByResource(assignment.allocatedItems);
    const consumedTotals = totalsByResource(assignment.consumedItems || []);
    if (status === 'partially_fulfilled') {
      if (!consumedItems.length) return res.status(400).json({ message: 'Record the quantity consumed for a partial fulfillment.' });
      const nextConsumed = totalsByResource(consumedItems);
      for (const [key, quantity] of nextConsumed) {
        if ((consumedTotals.get(key) || 0) + quantity > (allocatedTotals.get(key) || 0)) return res.status(400).json({ message: 'Consumed quantity cannot exceed the allocated amount.' });
      }
      for (const consumption of consumedItems) {
        const stock = assignment.provider.inventory.find(i => inventoryResourceKey(i.resource, i.unit) === inventoryResourceKey(consumption.resource, consumption.unit));
        if (!stock || (stock.allocatedQuantity || 0) < consumption.quantity) return res.status(409).json({ message: `Allocated stock for ${consumption.resource} is no longer available.` });
        stock.allocatedQuantity -= consumption.quantity;
        stock.consumedQuantity = (stock.consumedQuantity || 0) + consumption.quantity;
        stock.updatedAt = new Date();
        assignment.consumedItems.push(consumption);
      }
      await assignment.provider.save();
    }
    assignment.status = status;
    if (status === 'accepted') assignment.acceptedAt = new Date();
    if (status === 'fulfilled') assignment.completedAt = new Date();
    if (eta) assignment.eta = new Date(eta);
    if (providerNote) assignment.providerNote = providerNote;
    if (status === 'accepted') {
      for (const allocation of assignment.allocatedItems) {
        const stock = assignment.provider.inventory.find(i => i.resource.toLowerCase() === allocation.resource.toLowerCase() && i.unit.toLowerCase() === allocation.unit.toLowerCase());
        if (stock) { stock.reservedQuantity = Math.max(0, (stock.reservedQuantity || 0) - allocation.quantity); stock.allocatedQuantity = (stock.allocatedQuantity || 0) + allocation.quantity; stock.updatedAt = new Date(); }
      }
      await assignment.provider.save();
    }
    if (['declined', 'cancelled'].includes(status)) {
      const wasOffered = previousStatus === 'offered';
      for (const allocation of assignment.allocatedItems) {
        const stock = assignment.provider.inventory.find(i => i.resource.toLowerCase() === allocation.resource.toLowerCase() && i.unit.toLowerCase() === allocation.unit.toLowerCase());
        if (stock) {
          const remaining = wasOffered ? allocation.quantity : Math.max(0, allocation.quantity - (consumedTotals.get(inventoryResourceKey(allocation.resource, allocation.unit)) || 0));
          if (wasOffered) stock.reservedQuantity = Math.max(0, (stock.reservedQuantity || 0) - remaining);
          else stock.allocatedQuantity = Math.max(0, (stock.allocatedQuantity || 0) - remaining);
          stock.availableQuantity = (stock.availableQuantity ?? stock.quantity ?? 0) + remaining;
          stock.quantity = undefined;
          stock.updatedAt = new Date();
        }
      }
      await assignment.provider.save();
    }
    if (status === 'fulfilled') {
      for (const allocation of assignment.allocatedItems) {
        const stock = assignment.provider.inventory.find(i => i.resource.toLowerCase() === allocation.resource.toLowerCase() && i.unit.toLowerCase() === allocation.unit.toLowerCase());
        const remaining = Math.max(0, allocation.quantity - (consumedTotals.get(inventoryResourceKey(allocation.resource, allocation.unit)) || 0));
        if (stock && remaining) { stock.allocatedQuantity = Math.max(0, (stock.allocatedQuantity || 0) - remaining); stock.consumedQuantity = (stock.consumedQuantity || 0) + remaining; stock.updatedAt = new Date(); }
      }
      await assignment.provider.save();
    }
    request.status = status === 'fulfilled' ? 'awaiting_confirmation' : status === 'partially_fulfilled' ? 'partially_fulfilled' : status === 'in_progress' ? 'in_progress' : status === 'accepted' ? 'accepted' : status === 'cancelled' || status === 'declined' ? 'awaiting_match' : 'assigned';
    await request.save();
    await audit(req, `assignment.${status}`, 'EmergencyRequest', request.id, { assignmentId: assignment.id, eta });
    if (request.incidentId) await refreshIncidentStats(request.incidentId);
    await notify([request.reportedBy, assignment.provider.owner], status === 'fulfilled' ? 'fulfillment_confirmation' : 'assignment_update', status === 'fulfilled' ? 'Please confirm assistance received' : 'Assignment updated', `${assignment.provider.name}: ${status.replace('_', ' ')} for ${request.title}.`, request.id);
    const responseRequest = request.toObject();
    if (req.user.role === 'provider' && !['accepted', 'in_progress', 'partially_fulfilled', 'fulfilled'].includes(assignment.status)) {
      delete responseRequest.contact;
      if (responseRequest.location) delete responseRequest.location.coordinates;
    }
    res.json({ request: withPriority(responseRequest) });
  } catch (error) { next(error); }
};
router.patch('/:id/assignments/:assignmentId/status', authenticate, allowRoles('coordinator', 'admin', 'provider'), updateAssignmentStatus);
router.post('/:id/confirm-fulfillment', authenticate, allowRoles('requester', 'coordinator', 'admin'), async (req, res, next) => {
  try {
    const { received, notes } = z.object({ received: z.boolean(), notes: z.string().trim().max(1000).optional() }).parse(req.body);
    const request = await EmergencyRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    if (req.user.role === 'requester' && String(request.reportedBy) !== req.user.id) return res.status(403).json({ message: 'You can only confirm your own request.' });
    if (request.status !== 'awaiting_confirmation') return res.status(409).json({ message: 'This request is not awaiting fulfillment confirmation.' });
    request.fulfillmentConfirmation = { confirmed: received, confirmedBy: req.user.id, confirmedAt: new Date(), notes };
    request.status = received ? 'fulfilled' : 'in_progress';
    if (!received) {
      const assignment = [...request.assignments].reverse().find(a => a.status === 'fulfilled');
      if (assignment) assignment.status = 'in_progress';
    }
    await request.save();
    await audit(req, received ? 'request.fulfillment_confirmed' : 'request.fulfillment_disputed', 'EmergencyRequest', request.id, { notes });
    if (request.incidentId) await refreshIncidentStats(request.incidentId);
    const owners = [];
    for (const a of request.assignments) { const p = await Provider.findById(a.provider).select('owner'); if (p) owners.push(p.owner); }
    await notify([...owners, request.reportedBy], received ? 'request_fulfilled' : 'fulfillment_disputed', received ? 'Assistance confirmed' : 'Assistance needs follow-up', notes || `${request.title}: ${received ? 'assistance received' : 'requester reports assistance was not received'}.`, request.id);
    res.json({ request: withPriority(request.toObject()) });
  } catch (error) { next(error); }
});
router.post('/:id/feedback', authenticate, async (req, res, next) => {
  try {
    const input = z.object({ providerId: z.string().regex(/^[a-f\d]{24}$/i), rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1000).optional() }).parse(req.body);
    const request = await EmergencyRequest.findById(req.params.id);
    if (!request || request.status !== 'fulfilled' || !request.fulfillmentConfirmation?.confirmed) return res.status(409).json({ message: 'Feedback is available after the requester confirms fulfillment.' });
    if (!['requester', 'reporter', 'coordinator', 'admin'].includes(req.user.role)) return res.status(403).json({ message: 'Only the requester or a coordinator can leave feedback.' });
    if (['requester', 'reporter'].includes(req.user.role) && String(request.reportedBy) !== req.user.id) return res.status(403).json({ message: 'Only the request reporter or coordinator can leave feedback.' });
    if (!request.assignments.some(a => String(a.provider) === input.providerId && a.status === 'fulfilled')) return res.status(400).json({ message: 'Provider was not part of a fulfilled assignment.' });
    const feedback = await Feedback.create({ ...input, request: request.id, provider: input.providerId, author: req.user.id, verifiedFulfillment: true });
    const [performance] = await Feedback.aggregate([{ $match: { provider: new mongoose.Types.ObjectId(input.providerId), verifiedFulfillment: true } }, { $group: { _id: '$provider', average: { $avg: '$rating' } } }]);
    if (performance) await Provider.findByIdAndUpdate(input.providerId, { reliability: Math.round(performance.average * 20) });
    const providerOwner = await Provider.findById(input.providerId).select('owner');
    await notify([providerOwner?.owner], 'feedback_received', 'Verified assistance feedback received', `${input.rating}/5 rating submitted for ${request.title}.`, request.id);
    await audit(req, 'request.feedback_submitted', 'EmergencyRequest', request.id, { providerId: input.providerId, rating: input.rating });
    res.status(201).json({ feedback });
  } catch (error) { next(error); }
});

function totalsByResource(items = []) {
  const totals = new Map();
  for (const item of items) { const key = `${item.resource.toLowerCase()}|${item.unit.toLowerCase()}`; totals.set(key, (totals.get(key) || 0) + item.quantity); }
  return totals;
}
function inventoryResourceKey(resource, unit) { return `${resource.toLowerCase()}|${unit.toLowerCase()}`; }
function distanceBetweenKm([lon1, lat1], [lon2, lat2]) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(lat2 - lat1), dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pagination(query) {
  const page = Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit, 10) || 25));
  return { page, limit };
}
export default router;
