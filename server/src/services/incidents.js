import { randomUUID } from 'node:crypto';
import Incident from '../models/Incident.js';
import EmergencyRequest from '../models/EmergencyRequest.js';
import { calculatePriority, withPriority } from './priority.js';
import { descriptionSimilarity, distanceMeters } from './complaintVerification.js';
import { publishLiveEvent } from './liveEvents.js';

const boundedConfig = (value, fallback, min, max) => { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback; };
export const CLUSTER_WINDOW_HOURS = boundedConfig(process.env.INCIDENT_CLUSTER_WINDOW_HOURS, 72, 1, 720);
export const CLUSTER_RADIUS_METERS = boundedConfig(process.env.INCIDENT_CLUSTER_RADIUS_METERS, 1000, 100, 50000);
const validPoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && !(point[0] === 0 && point[1] === 0);
const normalizeLocation = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const reportText = request => `${request.title || ''} ${request.description || ''} ${request.requiredService || ''}`;

export function matchesIncident(request, incident) {
  if (incident.status && incident.status !== 'active') return false;
  if (incident.emergencyType !== request.emergencyType) return false;
  if (incident.category && request.category && incident.category !== request.category) return false;
  if (incident.affectedAreaType && request.affectedAreaType && incident.affectedAreaType !== 'other' && request.affectedAreaType !== 'other' && incident.affectedAreaType !== request.affectedAreaType) return false;
  const similarity = descriptionSimilarity(reportText(request), `${incident.title || ''} ${incident.description || ''} ${incident.requiredService || ''}`);
  const requestTime = request.reportedAt || request.createdAt ? new Date(request.reportedAt || request.createdAt).getTime() : null;
  const incidentTime = incident.lastReportedAt || incident.firstReportedAt ? new Date(incident.lastReportedAt || incident.firstReportedAt).getTime() : null;
  if (requestTime !== null && incidentTime !== null && (!Number.isFinite(requestTime) || !Number.isFinite(incidentTime) || Math.abs(requestTime - incidentTime) > CLUSTER_WINDOW_HOURS * 3600000)) return false;
  const requestPoint = request.location?.coordinatesAuthorized && validPoint(request.location.coordinates) ? request.location.coordinates : null;
  const incidentPoint = incident.location?.coordinatesAuthorized && validPoint(incident.location.coordinates) ? incident.location.coordinates : null;
  if (requestPoint && incidentPoint) {
    const distance = distanceMeters(requestPoint, incidentPoint);
    const severeSignals = ['critical', 'high'].includes(request.urgency) || ['critical', 'high'].includes(incident.highestReportUrgency);
    return distance <= CLUSTER_RADIUS_METERS && similarity >= (severeSignals ? 0.1 : 0.12);
  }
  return !requestPoint && !incidentPoint && normalizeLocation(request.location?.label) === normalizeLocation(incident.location?.label) && similarity >= 0.2;
}

function incidentPriorityScore(incident, distinctReporterCount, worsening) {
  const score = Math.min(100, incident.highestReportPriority + Math.min(12, Math.max(0, distinctReporterCount - 1) * 3) + (worsening ? 8 : 0));
  return { score, level: score >= 80 ? 'P1' : score >= 60 ? 'P2' : score >= 35 ? 'P3' : 'P4', severity: score >= 80 ? 'Critical' : score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low' };
}

function currentIncidentPriority(incident, distinctReporterCount, worsening, now) {
  const ageGrowth = incident.status === 'resolved' || !incident.updatedAt ? 0 : Math.max(0, Math.floor((now.getTime() - new Date(incident.updatedAt).getTime()) / 3600000));
  return incidentPriorityScore({ ...incident, highestReportPriority: Math.min(100, Number(incident.highestReportPriority || 0) + ageGrowth) }, distinctReporterCount, worsening);
}

export function inferEmergencyType(request) {
  const text = `${request.emergencyType || ''} ${request.title || ''} ${request.description || ''} ${request.category || ''}`.toLowerCase();
  if (/train|railway|derail/i.test(text)) return 'Train accident';
  if (/road accident|traffic collision|vehicle crash|car crash/i.test(text)) return 'Road accident';
  if (/industrial accident|factory accident|chemical plant/i.test(text)) return 'Industrial accident';
  if (/earthquake|tremor/i.test(text)) return 'Earthquake';
  if (/cyclone|hurricane|typhoon/i.test(text)) return 'Cyclone';
  if (/tsunami/i.test(text)) return 'Tsunami';
  if (/landslide|mudslide/i.test(text)) return 'Landslide';
  if (/flood|waterlogging/i.test(text)) return 'Flood';
  if (/storm|tornado/i.test(text)) return 'Storm';
  if (/fire|blaze/i.test(text)) return 'House fire';
  if (/explosion|cylinder blast|gas leak/i.test(text)) return 'Explosion';
  if (/contaminat|unsafe drinking water|water quality/i.test(text)) return 'Water contamination';
  if (/hospital|clinic/i.test(text)) return 'Hospital issue';
  if (/outbreak|epidemic|pandemic|infectious disease/i.test(text)) return 'Disease outbreak';
  if (/garbage|sanitation|sewage|waste/i.test(text)) return 'Sanitation problem';
  if (/damaged road|infrastructure|bridge failure|power grid/i.test(text)) return 'Infrastructure failure';
  return 'Other';
}

export async function backfillUnclusteredIncidents(batchSize = 100) {
  let migrated = 0;
  const lookback = new Date(Date.now() - CLUSTER_WINDOW_HOURS * 60 * 60 * 1000);
  while (true) {
    const unlinked = await EmergencyRequest.find({ incidentId: { $exists: false }, status: { $nin: ['fulfilled', 'cancelled', 'duplicate'] }, $or: [{ reportedAt: { $gte: lookback } }, { reportedAt: { $exists: false }, createdAt: { $gte: lookback } }] }).select('_id').sort({ reportedAt: 1, createdAt: 1 }).limit(batchSize).lean();
    if (!unlinked.length) {
      const legacyIncidents = await Incident.find({ $or: [{ verifiedReportCount: { $exists: false } }, { totalAffectedPeople: { $exists: false } }, { priorityScore: { $exists: false } }] }).select('_id').limit(500).lean();
      for (const incident of legacyIncidents) await refreshIncidentStats(incident._id, { emit: false });
      return migrated;
    }
    for (const { _id } of unlinked) {
      const request = await EmergencyRequest.findById(_id);
      if (!request || request.incidentId) continue;
      if (!request.emergencyType || request.emergencyType === 'Other') request.emergencyType = inferEmergencyType(request.toObject());
      await attachReportToIncident(request);
      migrated += 1;
    }
  }
}

export async function attachReportToIncident(request, { excludeIncidentId } = {}) {
  const cutoff = new Date(Date.now() - CLUSTER_WINDOW_HOURS * 3600000);
  const requestPoint = request.location?.coordinatesAuthorized && validPoint(request.location.coordinates) ? request.location.coordinates : null;
  const spatialFilter = requestPoint ? { 'location.coordinatesAuthorized': true, 'location.coordinates': { $near: { $geometry: { type: 'Point', coordinates: requestPoint }, $maxDistance: CLUSTER_RADIUS_METERS } } } : {};
  const candidateQuery = Incident.find({ emergencyType: request.emergencyType, status: 'active', lastReportedAt: { $gte: cutoff }, ...spatialFilter, ...(excludeIncidentId ? { _id: { $ne: excludeIncidentId } } : {}), ...(request.category ? { $or: [{ category: request.category }, { category: { $exists: false } }] } : {}) });
  if (!requestPoint) candidateQuery.sort({ lastReportedAt: -1 });
  const candidates = await candidateQuery.limit(100).populate('matchingReportId', 'title description requiredService').lean();
  const incident = candidates.find(candidate => matchesIncident(request, { ...candidate, ...(candidate.matchingReportId || {}) }));
  const requestPriority = calculatePriority(request);
  const now = new Date();
  let saved;
  let created = false;
  let estimateIncreased = false;

  if (incident) {
    estimateIncreased = Number(request.affectedPeople || 0) > Number(incident.estimatedAffectedPeople || 0);
    const update = {
      $addToSet: { reportIds: request._id, reporterIds: request.reportedBy },
      $inc: { reportCount: 1 },
      $max: { estimatedAffectedPeople: Number(request.affectedPeople || 0), highestReportPriority: requestPriority.score },
      $set: { lastReportedAt: now, ...(incident.status === 'active' && incident.responseStatus === 'resolved' ? { responseStatus: 'reopened' } : {}) },
    };
    if (estimateIncreased) update.$set.lastWorsenedAt = now;
    saved = await Incident.findOneAndUpdate({ _id: incident._id, status: 'active' }, update, { new: true, runValidators: true });
    if (!saved) return attachReportToIncident(request, { excludeIncidentId });
    const urgencyRank = { low: 0, medium: 1, high: 2, critical: 3 };
    if ((urgencyRank[request.urgency] ?? 1) > (urgencyRank[saved.highestReportUrgency] ?? 1)) saved.highestReportUrgency = request.urgency;
  } else {
    created = true;
    saved = await Incident.create({
      incidentId: `INC-${randomUUID().slice(0, 8).toUpperCase()}`,
      emergencyType: request.emergencyType || 'Other', category: request.category, affectedAreaType: request.affectedAreaType || 'other', title: request.title, matchingReportId: request._id,
      location: { label: request.location?.label || 'Location not provided', coordinatesAuthorized: Boolean(request.location?.coordinatesAuthorized), coordinates: request.location?.coordinatesAuthorized ? request.location.coordinates : [0, 0] },
      firstReportedAt: now, lastReportedAt: now, reportCount: 1,
      responseStatus: 'reported',
      reporterIds: [request.reportedBy], reportIds: [request._id],
      estimatedAffectedPeople: Number(request.affectedPeople || 0), highestReportPriority: requestPriority.score,
      highestReportUrgency: request.urgency || 'medium',
    });
  }

  request.incidentId = saved._id;
  await request.save();
  if (incident) {
    saved.matchingReportId = request._id;
    saved.category ||= request.category;
    saved.affectedAreaType ||= request.affectedAreaType || 'other';
  }
  const recentDistinctReporters = await EmergencyRequest.distinct('reportedBy', { incidentId: saved._id, reportedAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } });
  const recentReportCount = await EmergencyRequest.countDocuments({ incidentId: saved._id, reportedAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } });
  const worsening = estimateIncreased || recentDistinctReporters.length >= 3;
  if (worsening && !saved.lastWorsenedAt) saved.lastWorsenedAt = now;
  const priority = incidentPriorityScore(saved, saved.reporterIds.length, worsening);
  if (worsening) saved.lastWorsenedAt = now;
  await saved.save();
  const refreshed = await refreshIncidentStats(saved._id, { emit: false });
  return { incident: refreshed || saved, created, worsening, recentReportCount, priority };
}

const severityValues = { low: 1, medium: 2, high: 3, critical: 4 };
export function calculateIncidentStatistics(reports, now = new Date()) {
  const severities = reports.map(report => severityValues[report.urgency] || severityValues.medium);
  const maxSeverityValue = severities.reduce((max, value) => Math.max(max, value), 0);
  const maximumSeverity = Object.keys(severityValues).find(key => severityValues[key] === maxSeverityValue) || 'medium';
  const originals = reports.filter(report => report.status !== 'duplicate' && !report.duplicateOf);
  const populationReports = originals.length ? originals : reports;
  const totalAffectedPeople = populationReports.reduce((highest, report) => Math.max(highest, Number(report.affectedPeople) || 0), 0);
  const timestamps = reports.map(report => new Date(report.reportedAt || report.createdAt).getTime()).filter(Number.isFinite);
  const firstReportedAt = timestamps.length ? new Date(timestamps.reduce((min, value) => Math.min(min, value), Infinity)) : null;
  const lastReportedAt = timestamps.length ? new Date(timestamps.reduce((max, value) => Math.max(max, value), -Infinity)) : null;
  const verifiedReportCount = reports.filter(report => report.verification?.state === 'verified').length;
  return {
    totalReports: reports.length, totalAffectedPeople, maximumSeverity,
    averageSeverity: severities.length ? severities.reduce((sum, value) => sum + value, 0) / severities.length : 0,
    verifiedReportCount, unverifiedReportCount: reports.length - verifiedReportCount,
    communityConfirmationCount: reports.reduce((sum, report) => sum + (report.communityConfirmations?.length || 0), 0),
    duplicateReportCount: reports.filter(report => report.status === 'duplicate' || report.duplicateOf || report.reviewFlags?.some(flag => /duplicate|similar report/i.test(flag))).length,
    incidentAgeHours: firstReportedAt ? Math.max(0, (now.getTime() - firstReportedAt.getTime()) / 3600000) : 0,
    firstReportedAt, lastReportedAt,
  };
}

export function deriveIncidentResponseStatus(incident, reports = []) {
  if (incident.status === 'resolved') return 'resolved';
  const activeResponders = (incident.responders || []).filter(responder => responder.status !== 'withdrawn');
  const states = activeResponders.map(responder => responder.status);
  if (states.includes('assistance_in_progress')) return 'assistance_in_progress';
  if (states.includes('reached_location')) return 'reached_location';
  if (states.includes('on_the_way')) return 'on_the_way';
  if (states.includes('preparing_assistance')) return 'preparing_assistance';
  if (states.includes('claimed')) return 'claimed';
  if (states.includes('partially_resolved')) return 'partially_resolved';
  if (incident.responseStatus === 'reopened') return 'reopened';
  if (states.length && states.every(status => status === 'resolved')) return 'resolved';
  if (incident.responders?.length && !activeResponders.length) return 'awaiting_response';
  if (reports.some(report => report.status === 'under_review')) return 'under_review';
  if (reports.length && reports.every(report => report.verification?.state === 'verified')) return 'awaiting_response';
  return incident.responseStatus === 'verified' ? 'awaiting_response' : 'reported';
}

export async function refreshIncidentStats(incidentId, { emit = true } = {}) {
  const incident = await Incident.findById(incidentId);
  if (!incident) return null;
  const reports = await EmergencyRequest.find({ incidentId: incident._id }).select('title emergencyType category affectedAreaType location urgency affectedPeople verification communityConfirmations status duplicateOf reviewFlags reportedAt createdAt reportedBy priorityOverride').sort({ reportedAt: 1, createdAt: 1 }).lean();
  if (!reports.length) {
    incident.reportCount = 0; incident.totalAffectedPeople = 0; incident.estimatedAffectedPeople = 0;
    incident.verifiedReportCount = 0; incident.unverifiedReportCount = 0; incident.communityConfirmationCount = 0; incident.duplicateReportCount = 0;
    incident.averageSeverity = 0; incident.priorityScore = 0; incident.priorityLevel = 'P4'; incident.reportIds = []; incident.reporterIds = [];
    incident.incidentAgeHours = incident.firstReportedAt ? Math.max(0, (Date.now() - new Date(incident.firstReportedAt).getTime()) / 3600000) : 0;
    await incident.save();
    if (emit) publishLiveEvent('incident.updated', liveIncidentPayload(incident, incidentPriorityScore(incident, 0, false), 0, false));
    return incident;
  }
  const stats = calculateIncidentStatistics(reports, new Date());
  const reporters = [...new Set(reports.map(report => String(report.reportedBy)).filter(Boolean))];
  const now = new Date();
  const recentCutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const recentReports = reports.filter(report => new Date(report.reportedAt || report.createdAt) >= recentCutoff);
  const recentReporterCount = new Set(recentReports.map(report => String(report.reportedBy)).filter(Boolean)).size;
  const worsening = recentReporterCount >= 3 || Boolean(incident.lastWorsenedAt && now.getTime() - new Date(incident.lastWorsenedAt).getTime() <= 3600000);
  const maxRequestPriority = reports.reduce((highest, report) => Math.max(highest, withPriority(report, now).priority.score), 0);
  incident.reportCount = reports.length;
  incident.reportIds = reports.map(report => report._id);
  incident.reporterIds = [...new Set(reports.map(report => String(report.reportedBy)).filter(Boolean))];
  incident.matchingReportId = reports.at(-1)._id;
  incident.title ||= reports[0].title;
  const geolocatedReports = reports.filter(report => report.location?.coordinatesAuthorized && validPoint(report.location.coordinates));
  if (geolocatedReports.length) {
    incident.location.coordinatesAuthorized = true;
    incident.location.coordinates = [geolocatedReports.reduce((sum, report) => sum + report.location.coordinates[0], 0) / geolocatedReports.length, geolocatedReports.reduce((sum, report) => sum + report.location.coordinates[1], 0) / geolocatedReports.length];
  } else {
    incident.location.coordinatesAuthorized = false;
    incident.location.coordinates = [0, 0];
  }
  incident.location.label = reports.at(-1).location?.label || incident.location.label;
  incident.totalAffectedPeople = stats.totalAffectedPeople;
  incident.estimatedAffectedPeople = stats.totalAffectedPeople;
  incident.maximumSeverity = stats.maximumSeverity;
  incident.averageSeverity = stats.averageSeverity;
  incident.verifiedReportCount = stats.verifiedReportCount;
  incident.unverifiedReportCount = stats.unverifiedReportCount;
  incident.communityConfirmationCount = stats.communityConfirmationCount;
  incident.duplicateReportCount = stats.duplicateReportCount;
  incident.firstReportedAt = stats.firstReportedAt || incident.firstReportedAt;
  incident.lastReportedAt = stats.lastReportedAt || incident.lastReportedAt;
  incident.incidentAgeHours = stats.incidentAgeHours;
  incident.highestReportPriority = maxRequestPriority;
  incident.highestReportUrgency = stats.maximumSeverity;
  incident.responseStatus = deriveIncidentResponseStatus(incident, reports);
  const priority = incidentPriorityScore(incident, Math.max(reporters.length, incident.reporterIds?.length || 0), worsening);
  incident.priorityScore = priority.score;
  incident.priorityLevel = priority.level;
  const lastHistory = incident.priorityHistory?.at(-1);
  if (!lastHistory || lastHistory.score !== priority.score || lastHistory.maximumReportedSeverity !== stats.maximumSeverity || Math.abs((lastHistory.averageReportedSeverity || 0) - stats.averageSeverity) > 0.001) {
    incident.priorityHistory ||= [];
    incident.priorityHistory.push({ score: priority.score, level: priority.level, severity: priority.severity, maximumReportedSeverity: stats.maximumSeverity, averageReportedSeverity: stats.averageSeverity, at: now, reportId: reports.at(-1)._id });
    if (incident.priorityHistory.length > 100) incident.priorityHistory.splice(0, incident.priorityHistory.length - 100);
  }
  incident.status = incident.status || 'active';
  await incident.save();
  if (emit) publishLiveEvent('incident.updated', liveIncidentPayload(incident, priority, recentReports.length, worsening));
  return incident;
}

export function liveIncidentPayload(incident, priority, recentReportCount = 0, worsening = false) {
  return {
    _id: incident._id, incidentId: incident.incidentId, title: incident.title, emergencyType: incident.emergencyType,
    category: incident.category, affectedAreaType: incident.affectedAreaType, location: incident.location?.label || 'Location not provided',
    reportCount: incident.reportCount, totalAffectedPeople: incident.totalAffectedPeople ?? incident.estimatedAffectedPeople,
    estimatedAffectedPeople: incident.totalAffectedPeople ?? incident.estimatedAffectedPeople,
    affectedEstimateMethod: incident.affectedPeopleEstimateMethod || 'maximum individual estimate; reports may overlap',
    maximumSeverity: incident.maximumSeverity, averageSeverity: incident.averageSeverity,
    verifiedReportCount: incident.verifiedReportCount, unverifiedReportCount: incident.unverifiedReportCount,
    communityConfirmationCount: incident.communityConfirmationCount, duplicateReportCount: incident.duplicateReportCount,
    incidentAgeHours: incident.incidentAgeHours, status: incident.status, responseStatus: incident.responseStatus || 'reported', responderCount: (incident.responders || []).filter(responder => responder.status !== 'withdrawn').length, priority, verificationStatus: incident.reportCount > 0 && incident.verifiedReportCount === incident.reportCount ? 'officially verified' : incident.verifiedReportCount ? 'partially verified' : incident.communityConfirmationCount >= 3 ? 'community supported' : 'unverified',
    worsening, recentReportCount, firstReportedAt: incident.firstReportedAt, lastReportedAt: incident.lastReportedAt, lastUpdatedAt: incident.updatedAt, live: true,
  };
}

export async function incidentSummary(incident, now = new Date()) {
  const recentCutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const [recentReportCount, recentReporters] = await Promise.all([
    EmergencyRequest.countDocuments({ incidentId: incident._id, reportedAt: { $gte: recentCutoff } }),
    EmergencyRequest.distinct('reportedBy', { incidentId: incident._id, reportedAt: { $gte: recentCutoff } }),
  ]);
  const worsening = recentReporters.length >= 3 || Boolean(incident.lastWorsenedAt && now.getTime() - new Date(incident.lastWorsenedAt).getTime() <= 60 * 60 * 1000);
  const priority = currentIncidentPriority(incident, incident.reporterIds?.length || 1, worsening, now);
  priority.reasons = [
    Number(incident.estimatedAffectedPeople || 0) > 0 ? `A report estimates ${Number(incident.estimatedAffectedPeople).toLocaleString()} people may be affected.` : null,
    incident.highestReportUrgency === 'critical' || incident.highestReportUrgency === 'high' ? `A linked report marks urgency as ${incident.highestReportUrgency}.` : null,
    recentReportCount > 0 ? `${recentReportCount} reports were received in the last hour.` : null,
    worsening ? 'Recent reports or increased reported impact indicate the situation may be worsening.' : null,
    incident.firstReportedAt ? `The incident ${incident.status === 'resolved' ? 'was first reported' : 'has remained open since'} ${new Date(incident.firstReportedAt).toLocaleString()}.` : null,
  ].filter(Boolean);
  return {
    _id: incident._id, incidentId: incident.incidentId, emergencyType: incident.emergencyType, category: incident.category, affectedAreaType: incident.affectedAreaType, title: incident.title,
    location: incident.location?.label || 'Location not provided', reportCount: incident.reportCount, totalReports: incident.reportCount,
    totalAffectedPeople: incident.totalAffectedPeople ?? incident.estimatedAffectedPeople, estimatedAffectedPeople: incident.totalAffectedPeople ?? incident.estimatedAffectedPeople, affectedEstimateMethod: incident.affectedPeopleEstimateMethod || 'maximum individual estimate; reports may overlap',
    maximumSeverity: incident.maximumSeverity || incident.highestReportUrgency, averageSeverity: incident.averageSeverity,
    verifiedReportCount: incident.verifiedReportCount || 0, unverifiedReportCount: incident.unverifiedReportCount ?? incident.reportCount,
    communityConfirmationCount: incident.communityConfirmationCount || 0, duplicateReportCount: incident.duplicateReportCount || 0,
    incidentAgeHours: incident.firstReportedAt ? Math.max(0, (now.getTime() - new Date(incident.firstReportedAt).getTime()) / 3600000) : incident.incidentAgeHours || 0,
    status: incident.status, responseStatus: incident.responseStatus || 'reported', responderCount: (incident.responders || []).filter(responder => responder.status !== 'withdrawn').length, worsening, recentReportCount, firstReportedAt: incident.firstReportedAt, lastReportedAt: incident.lastReportedAt, lastUpdatedAt: incident.updatedAt, verificationStatus: 'unverified',
    priority, live: true,
  };
}

export async function listIncidentSummaries(incidents, now = new Date()) {
  if (!incidents.length) return [];
  const recentCutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const recent = await EmergencyRequest.aggregate([
    { $match: { incidentId: { $in: incidents.map(incident => incident._id) }, reportedAt: { $gte: recentCutoff } } },
    { $group: { _id: '$incidentId', count: { $sum: 1 }, reporters: { $addToSet: '$reportedBy' } } },
  ]);
  const byId = new Map(recent.map(row => [String(row._id), row]));
  return incidents.map(incident => {
    const signals = byId.get(String(incident._id));
    const recentReportCount = signals?.count || 0;
    const worsening = (signals?.reporters.length || 0) >= 3 || Boolean(incident.lastWorsenedAt && now.getTime() - new Date(incident.lastWorsenedAt).getTime() <= 60 * 60 * 1000);
    const priority = currentIncidentPriority(incident, incident.reporterIds?.length || 1, worsening, now);
    priority.reasons = [
      Number(incident.estimatedAffectedPeople || 0) > 0 ? `A report estimates ${Number(incident.estimatedAffectedPeople).toLocaleString()} people may be affected.` : null,
      incident.highestReportUrgency === 'critical' || incident.highestReportUrgency === 'high' ? `A linked report marks urgency as ${incident.highestReportUrgency}.` : null,
      recentReportCount > 0 ? `${recentReportCount} reports were received in the last hour.` : null,
      worsening ? 'Recent reports or increased reported impact indicate the situation may be worsening.' : null,
      incident.firstReportedAt ? `The incident ${incident.status === 'resolved' ? 'was first reported' : 'has remained open since'} ${new Date(incident.firstReportedAt).toLocaleString()}.` : null,
    ].filter(Boolean);
    return {
      _id: incident._id, incidentId: incident.incidentId, emergencyType: incident.emergencyType, category: incident.category, affectedAreaType: incident.affectedAreaType, title: incident.title,
      location: incident.location?.label || 'Location not provided', reportCount: incident.reportCount, totalReports: incident.reportCount,
      totalAffectedPeople: incident.totalAffectedPeople ?? incident.estimatedAffectedPeople, estimatedAffectedPeople: incident.totalAffectedPeople ?? incident.estimatedAffectedPeople, affectedEstimateMethod: incident.affectedPeopleEstimateMethod || 'maximum individual estimate; reports may overlap',
      maximumSeverity: incident.maximumSeverity || incident.highestReportUrgency, averageSeverity: incident.averageSeverity,
      verifiedReportCount: incident.verifiedReportCount || 0, unverifiedReportCount: incident.unverifiedReportCount ?? incident.reportCount,
      communityConfirmationCount: incident.communityConfirmationCount || 0, duplicateReportCount: incident.duplicateReportCount || 0,
      incidentAgeHours: incident.firstReportedAt ? Math.max(0, (now.getTime() - new Date(incident.firstReportedAt).getTime()) / 3600000) : incident.incidentAgeHours || 0,
      status: incident.status, responseStatus: incident.responseStatus || 'reported', responderCount: (incident.responders || []).filter(responder => responder.status !== 'withdrawn').length, worsening, recentReportCount, firstReportedAt: incident.firstReportedAt, lastReportedAt: incident.lastReportedAt, lastUpdatedAt: incident.updatedAt, verificationStatus: 'unverified', priority, live: true,
    };
  });
}
