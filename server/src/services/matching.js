import EmergencyRequest from '../models/EmergencyRequest.js';
import Feedback from '../models/Feedback.js';

const DEFAULT_WEIGHTS = Object.freeze({ skillService: 25, resourceCapacity: 20, availability: 20, distance: 15, reliability: 10, feedback: 10 });
const COMPONENT_LABELS = Object.freeze({ skillService: 'Skill and service compatibility', resourceCapacity: 'Resource capacity', availability: 'Availability', distance: 'Straight-line distance', reliability: 'Verified reliability', feedback: 'Verified recipient feedback' });

function configuredWeights() {
  const raw = process.env.MATCH_WEIGHTS_JSON;
  if (!raw) return { weights: DEFAULT_WEIGHTS, source: 'defaults' };
  try {
    const supplied = JSON.parse(raw);
    const keys = Object.keys(DEFAULT_WEIGHTS);
    if (!supplied || Object.keys(supplied).some(key => !keys.includes(key)) || keys.some(key => !Number.isFinite(supplied[key]) || supplied[key] < 0) || keys.reduce((sum, key) => sum + supplied[key], 0) !== 100) throw new Error('Weights must use the six documented keys and sum to 100.');
    return { weights: Object.freeze(supplied), source: 'MATCH_WEIGHTS_JSON' };
  } catch (error) {
    console.warn(`Ignoring invalid MATCH_WEIGHTS_JSON: ${error.message}`);
    return { weights: DEFAULT_WEIGHTS, source: 'defaults' };
  }
}

const configured = configuredWeights();
export const matchingModel = Object.freeze({
  weights: configured.weights,
  source: configured.source,
  missingDataPolicy: 'A missing non-mandatory component is omitted and the remaining configured weights are renormalized to 100. Missing mandatory eligibility data fails that eligibility check. Missing values are listed as uncertainties.',
  distancePolicy: 'When authorized coordinates and a registered service radius are available, score straight-line distance within that radius. This is not a travel-time estimate.'
});

const norm = value => String(value ?? '').trim().toLocaleLowerCase();
const ageMinutes = value => value && Number.isFinite(new Date(value).getTime()) ? Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000)) : null;
const coordsKnown = coordinates => Array.isArray(coordinates) && coordinates.length === 2 && coordinates.every(Number.isFinite) && !(coordinates[0] === 0 && coordinates[1] === 0);
const radians = value => value * Math.PI / 180;
function straightLineKm(a, b) {
  const [lon1, lat1] = a, [lon2, lat2] = b;
  const dLat = radians(lat2 - lat1), dLon = radians(lon2 - lon1);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}
function inventoryKey(resource, unit) { return `${norm(resource)}|${norm(unit)}`; }
function demandByResource(items = []) {
  const totals = new Map();
  for (const item of items) {
    const key = inventoryKey(item.resource, item.unit);
    totals.set(key, (totals.get(key) || 0) + Number(item.quantity || 0));
  }
  return totals;
}
function isOperationalNow(operationalHours) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: operationalHours.timezone || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday);
    const current = Number(values.hour) * 60 + Number(values.minute);
    const toMinutes = value => { const [hour, minute] = String(value || '').split(':').map(Number); return hour * 60 + minute; };
    const today = operationalHours.schedule.find(entry => entry.day === day);
    if (!today || today.closed) return false;
    const open = toMinutes(today.open), close = toMinutes(today.close);
    if (![open, close, current].every(Number.isFinite)) return false;
    if (close >= open) return current >= open && current <= close;
    if (current >= open) return true;
    const yesterday = operationalHours.schedule.find(entry => entry.day === (day + 6) % 7);
    return Boolean(yesterday && !yesterday.closed && toMinutes(yesterday.close) < toMinutes(yesterday.open) && current <= toMinutes(yesterday.close));
  } catch { return false; }
}

/** Builds user-facing copy only from structured match evidence; it never infers missing facts. */
export function generateMatchExplanation(match) {
  const { evidence, scoreComponents = [], eligibilityChecks = {}, uncertainties = [] } = match;
  const reasons = [...(match.reasons || [])];
  const safetyLimitations = Object.entries(eligibilityChecks)
    .filter(([, passed]) => passed === false)
    .map(([key]) => {
      if (key === 'serviceOffered') return `Requested category “${evidence.service.requestedCategory}” is not listed. Provider lists: ${evidence.service.offeredCategories.join(', ') || 'no service categories'}.`;
      if (key === 'qualificationsSatisfied') return `Missing requested skills or qualifications: ${evidence.skills.missing.join(', ') || 'provider records are incomplete'}.`;
      if (key === 'resourcesSufficient') return `Inventory is insufficient: ${evidence.resources.filter(item => !item.sufficient).map(item => `${item.resource} ${item.availableQuantity}/${item.requestedQuantity} ${item.unit}`).join('; ') || 'requested resources are not listed'}.`;
      if (key === 'capacityAvailable') return `Capacity limitation: ${evidence.capacity.remainingSlots ?? 'unknown'} of ${evidence.capacity.totalSlots ?? 'unknown'} response slots remain (${evidence.capacity.concurrentAssignments} active assignments).`;
      if (key === 'currentlyAvailable') return `Provider availability is ${evidence.availability.status || 'not recorded'}.`;
      if (key === 'withinServiceArea') return evidence.location.distanceKm === null || evidence.location.serviceRadiusKm === null
        ? 'Service-area coverage cannot be confirmed because authorized coordinates or service radius are missing.'
        : `Outside the registered ${evidence.location.serviceRadiusKm} km service radius (${evidence.location.distanceKm} km straight-line distance).`;
      if (key === 'verified') return `Provider verification status is ${evidence.verification.status || 'not recorded'}.`;
      if (key === 'withinOperatingHours') return 'Provider is outside registered operating hours.';
      return null;
    }).filter(Boolean);

  if (evidence.skills.required.length) {
    reasons.push(`Skill compatibility: ${evidence.skills.matched.length}/${evidence.skills.required.length} requested skills or qualifications match provider records.`);
  }
  for (const resource of evidence.resources) {
    const updated = resource.ageMinutes === null ? 'inventory update time not recorded' : `inventory updated ${resource.ageMinutes < 1 ? 'less than a minute ago' : `${resource.ageMinutes} minutes ago`}`;
    reasons.push(`${resource.resource}: ${resource.availableQuantity} ${resource.unit} available for ${resource.requestedQuantity} requested; ${updated}.`);
  }
  if (evidence.availability.status) {
    const updated = evidence.availability.ageMinutes === null ? 'last update time not recorded' : `last updated ${evidence.availability.ageMinutes < 1 ? 'less than a minute ago' : `${evidence.availability.ageMinutes} minutes ago`}`;
    reasons.push(`Provider reports ${evidence.availability.status} availability; ${updated}.`);
  }
  if (evidence.verification.status) reasons.push(`Verification status: ${evidence.verification.status}.`);
  if (evidence.location.distanceKm !== null) reasons.push(`Distance: ${evidence.location.distanceKm} km straight-line distance; no travel-time estimate is available.`);
  if (evidence.performance.verifiedCompletedAssignments) {
    const etaHistory = evidence.performance.etaKnownCompletedAssignments
      ? `, ${evidence.performance.onTimeCompletedAssignments}/${evidence.performance.etaKnownCompletedAssignments} with recorded arrival estimates were completed on time`
      : ', no completed assignments have a recorded arrival estimate';
    reasons.push(`${evidence.performance.verifiedCompletedAssignments} verified completed assignments${etaHistory}.`);
  } else reasons.push('No verified completed assignments are on record.');
  if (evidence.feedback.verifiedCount) reasons.push(`Verified recipient feedback: ${evidence.feedback.averageRating}/5 from ${evidence.feedback.verifiedCount} rating${evidence.feedback.verifiedCount === 1 ? '' : 's'}.`);

  const scoreFactors = scoreComponents.filter(component => component.score !== null && component.score < 100).map(component => ({
    component: component.key,
    label: component.label,
    score: component.score,
    appliedWeight: component.appliedWeight,
    explanation: `${component.label} scored ${component.score}/100 (applied weight ${component.appliedWeight}%).`
  }));
  const missingInformation = [...new Set(uncertainties)];
  const limitations = [
    ...safetyLimitations,
    ...scoreFactors.map(factor => factor.explanation),
    ...missingInformation.map(item => `Uncertainty: ${item}`),
    'A recommendation is not an assignment; coordinator approval and provider acceptance are still required.'
  ];
  return { reasons: [...new Set(reasons)], scoreFactors, safetyLimitations, missingInformation, limitations };
}

export function evaluateMatch(request, provider, { activeLoad = 0, verifiedCompletedCount = 0, etaKnownCompletedCount = 0, onTimeCompletedCount = 0, verifiedFeedbackCount = 0, averageVerifiedRating = null } = {}) {
  const reasons = [], limitations = [], uncertainties = [];
  const requestCategory = norm(request.category);
  const offeredServices = [provider.category, ...(provider.serviceCategories || [])].map(norm).filter(Boolean);
  const serviceOffered = Boolean(requestCategory) && offeredServices.includes(requestCategory);
  if (serviceOffered) reasons.push(`Offers ${request.category}`);
  else limitations.push(`Requested service category “${request.category || 'unspecified'}” is not listed`);

  const requiredTerms = [...new Set([request.requiredService, ...(request.requiredSkills || [])].map(norm).filter(Boolean))];
  const verifiedCredentials = (provider.credentials || []).filter(credential => credential.status === 'verified').map(credential => norm(credential.name));
  const listedQualifications = [...(provider.skills || []), ...(provider.qualifications || []), ...verifiedCredentials].map(norm).filter(Boolean);
  const satisfiedTerms = requiredTerms.filter(term => listedQualifications.includes(term));
  const qualificationsSatisfied = satisfiedTerms.length === requiredTerms.length;
  const qualificationScore = requiredTerms.length ? satisfiedTerms.length / requiredTerms.length * 100 : (serviceOffered ? 100 : 0);
  if (qualificationsSatisfied) reasons.push(requiredTerms.length ? 'All requested skills and qualifications are listed' : 'No additional qualification requirement was specified');
  else limitations.push(`Missing listed skill or qualification: ${requiredTerms.filter(term => !satisfiedTerms.includes(term)).join(', ')}`);
  if (requiredTerms.length && !listedQualifications.length) uncertainties.push('Provider has not listed skills, qualifications, or verified credentials');

  const inventory = provider.inventory || [];
  const demand = demandByResource(request.items);
  const supply = new Map();
  for (const item of inventory) {
    const key = inventoryKey(item.resource, item.unit);
    supply.set(key, (supply.get(key) || 0) + Number(item.availableQuantity ?? item.quantity ?? 0));
  }
  const resourceCoverage = demand.size ? [...demand].reduce((total, [key, quantity]) => total + Math.min(1, (supply.get(key) || 0) / quantity), 0) / demand.size : 0;
  const resourcesSufficient = demand.size > 0 && [...demand].every(([key, quantity]) => (supply.get(key) || 0) >= quantity);
  if (!inventory.length) uncertainties.push('Provider has not registered inventory');
  if (resourcesSufficient) reasons.push('Unreserved inventory covers every requested quantity');
  else limitations.push('Unreserved inventory is insufficient for one or more requested quantities; partial allocation is not enabled for this request');

  const capacity = Number(provider.capacity);
  const hasCapacityData = Number.isFinite(capacity) && capacity > 0;
  const capacityAvailable = hasCapacityData && activeLoad < capacity;
  const workloadScore = hasCapacityData ? Math.max(0, Math.min(100, (capacity - activeLoad) / capacity * 100)) : null;
  if (!hasCapacityData) uncertainties.push('Provider response capacity is not registered');
  else if (capacityAvailable) reasons.push(`${capacity - activeLoad} of ${capacity} response slots available`);
  else limitations.push('Provider has reached registered concurrent response capacity');

  let availabilityScore = null;
  const availability = provider.availability;
  if (availability === 'available') { availabilityScore = 100; reasons.push('Provider reports current availability'); }
  else if (availability === 'limited') { availabilityScore = 50; limitations.push('Limited availability requires explicit provider confirmation before it can be considered eligible'); }
  else if (availability === 'unavailable') { availabilityScore = 0; limitations.push('Provider reports that it is unavailable'); }
  else { uncertainties.push('Current provider availability is not recorded'); limitations.push('Current availability cannot be confirmed'); }

  const requestCoordinates = request.location?.coordinates;
  const providerCoordinates = provider.location?.coordinates;
  const hasCoordinates = request.location?.coordinatesAuthorized === true && coordsKnown(requestCoordinates) && coordsKnown(providerCoordinates);
  const radius = Number(provider.serviceRadiusKm);
  const hasRadius = Number.isFinite(radius) && radius >= 0;
  const distanceKm = hasCoordinates ? straightLineKm(requestCoordinates, providerCoordinates) : null;
  const withinRadius = hasCoordinates && hasRadius && distanceKm <= radius;
  const distanceScore = hasCoordinates && hasRadius ? (radius === 0 ? (distanceKm === 0 ? 100 : 0) : Math.max(0, Math.min(100, (1 - distanceKm / radius) * 100))) : null;
  if (!hasCoordinates) { uncertainties.push('Authorized request and registered provider coordinates are required to confirm service-area coverage'); limitations.push('Service-area fit cannot be confirmed because authorized precise coordinates are unavailable'); }
  else if (!hasRadius) { uncertainties.push('Provider service radius is not registered'); limitations.push('Service-area fit cannot be confirmed without a registered response radius'); }
  else if (withinRadius) reasons.push(`Straight-line distance is ${distanceKm.toFixed(1)} km, within the registered ${radius} km service radius; this is not a travel-time estimate`);
  else limitations.push(`Outside the registered ${radius} km service radius`);

  const verified = provider.verified === true && provider.verificationStatus === 'verified';
  if (verified) reasons.push('Provider and account verification are current');
  else limitations.push('Provider has not passed mandatory verification');

  const hasHours = Boolean(provider.operationalHours?.schedule?.length);
  const withinHours = hasHours ? isOperationalNow(provider.operationalHours) : null;
  if (!hasHours) uncertainties.push('Provider operating hours are not registered');
  else if (!withinHours) limitations.push('Provider is outside registered operating hours');
  else reasons.push('Provider is within registered operating hours');

  const completedCount = Number(verifiedCompletedCount) || 0;
  const etaKnownCount = Number(etaKnownCompletedCount) || 0;
  const reliabilityScore = etaKnownCount > 0 ? (Number(onTimeCompletedCount) || 0) / etaKnownCount * 100 : null;
  if (reliabilityScore === null) uncertainties.push('No verified completed assignments with recorded arrival estimates are available for reliability scoring');
  else reasons.push(`On-time reliability is ${Math.round(reliabilityScore)}/100 across ${etaKnownCount} verified completed assignments with recorded arrival estimates (${completedCount} verified completions total)`);
  const feedbackScore = Number(verifiedFeedbackCount) > 0 && Number.isFinite(Number(averageVerifiedRating)) ? Number(averageVerifiedRating) / 5 * 100 : null;
  if (feedbackScore === null) uncertainties.push('No verified recipient feedback is available');

  const resourceCapacityScore = inventory.length && demand.size && hasCapacityData ? Math.min(resourceCoverage * 100, workloadScore) : null;
  const resources = [...demand].map(([key, requestedQuantity]) => {
    const requestItem = request.items.find(item => inventoryKey(item.resource, item.unit) === key);
    const records = inventory.filter(item => inventoryKey(item.resource, item.unit) === key);
    const updateTimes = records.map(item => item.updatedAt).filter(value => value && Number.isFinite(new Date(value).getTime())).map(value => new Date(value));
    const lastUpdatedAt = updateTimes.length ? new Date(Math.max(...updateTimes.map(value => value.getTime()))) : null;
    if (!lastUpdatedAt) uncertainties.push(`${requestItem.resource} inventory update time is not recorded`);
    return { resource: requestItem.resource, unit: requestItem.unit, source: 'provider-reported', requestedQuantity, availableQuantity: supply.get(key) || 0, sufficient: (supply.get(key) || 0) >= requestedQuantity, lastUpdatedAt, ageMinutes: ageMinutes(lastUpdatedAt) };
  });
  const components = {
    skillService: serviceOffered ? (qualificationScore + 100) / 2 : qualificationScore / 2,
    resourceCapacity: resourceCapacityScore,
    availability: availabilityScore,
    distance: distanceScore,
    reliability: reliabilityScore,
    feedback: feedbackScore
  };
  const presentWeight = Object.entries(configured.weights).reduce((sum, [key, weight]) => sum + (components[key] === null ? 0 : weight), 0);
  const scoreComponents = Object.entries(configured.weights).map(([key, configuredWeight]) => ({ key, label: COMPONENT_LABELS[key], score: components[key] === null ? null : Math.round(components[key]), configuredWeight, appliedWeight: components[key] === null || presentWeight === 0 ? 0 : Number((configuredWeight / presentWeight * 100).toFixed(1)) }));
  const score = presentWeight ? Math.round(scoreComponents.reduce((sum, component) => sum + (component.score === null ? 0 : component.score * component.appliedWeight), 0) / 100) : null;
  reasons.push(`Weighted score components: ${scoreComponents.map(component => `${component.label} ${component.score === null ? 'unavailable' : `${component.score}/100`} (configured ${component.configuredWeight}%, applied ${component.appliedWeight}%)`).join('; ')}`);

  const eligible = serviceOffered && qualificationsSatisfied && resourcesSufficient && capacityAvailable && availability === 'available' && withinRadius && verified && withinHours !== false;
  const lastAvailabilityUpdated = provider.lastAvailabilityUpdated || null;
  const availabilityAgeMinutes = ageMinutes(lastAvailabilityUpdated);
  if (!lastAvailabilityUpdated) uncertainties.push('Provider availability update time is not recorded');
  else if (availabilityAgeMinutes > 60) limitations.push(`Provider-reported availability is stale (${availabilityAgeMinutes} minutes old); reconfirm directly before offering an assignment`);
  const match = {
    provider: { id: provider._id, name: provider.name, category: provider.category, availability, availabilitySource: provider.availabilitySource || 'provider_reported', lastAvailabilityUpdated, verificationStatus: provider.verificationStatus, verified, reliability: reliabilityScore, capacity: hasCapacityData ? capacity : null, activeAssignments: activeLoad },
    eligible, eligibilityStatus: eligible ? 'Eligible for coordinator review' : 'Not eligible', score, scoreComponents, uncertainties,
    distanceKm: distanceKm === null ? null : Number(distanceKm.toFixed(1)), distanceLabel: distanceKm === null ? null : 'Straight-line distance; not travel time',
    eligibilityChecks: { serviceOffered, qualificationsSatisfied, resourcesSufficient, capacityAvailable, currentlyAvailable: availability === 'available', withinServiceArea: Boolean(withinRadius), verified, withinOperatingHours: withinHours === null ? null : withinHours },
    evidence: {
      service: { requestedCategory: request.category, offeredCategories: [...new Set([provider.category, ...(provider.serviceCategories || [])].filter(Boolean))], offered: serviceOffered },
      skills: { required: [...new Set([request.requiredService, ...(request.requiredSkills || [])].filter(Boolean))], matched: [...new Set([request.requiredService, ...(request.requiredSkills || [])].filter(Boolean))].filter(term => listedQualifications.includes(norm(term))), missing: requiredTerms.filter(term => !satisfiedTerms.includes(term)), score: Math.round(qualificationScore) },
      resources,
      availability: { status: availability || null, source: provider.availabilitySource || 'provider_reported', lastUpdatedAt: lastAvailabilityUpdated, ageMinutes: availabilityAgeMinutes, needsReconfirmation: availabilityAgeMinutes === null || availabilityAgeMinutes > 60 },
      verification: { status: provider.verificationStatus || null, verified },
      capacity: { concurrentAssignments: activeLoad, totalSlots: hasCapacityData ? capacity : null, remainingSlots: hasCapacityData ? Math.max(0, capacity - activeLoad) : null },
      location: { distanceKm: distanceKm === null ? null : Number(distanceKm.toFixed(1)), distanceType: 'straight_line', serviceRadiusKm: hasRadius ? radius : null, withinServiceArea: Boolean(withinRadius) },
      performance: { verifiedCompletedAssignments: completedCount, etaKnownCompletedAssignments: etaKnownCount, onTimeCompletedAssignments: Number(onTimeCompletedCount) || 0, onTimeReliabilityScore: reliabilityScore === null ? null : Math.round(reliabilityScore) },
      feedback: { verifiedCount: Number(verifiedFeedbackCount) || 0, averageRating: Number(verifiedFeedbackCount) > 0 && Number.isFinite(Number(averageVerifiedRating)) ? Number(Number(averageVerifiedRating).toFixed(2)) : null }
    },
    reasons,
    limitations
  };
  match.explanation = generateMatchExplanation(match);
  match.reasons = match.explanation.reasons;
  match.limitations = match.explanation.limitations;
  return match;
}

export async function loadProviderMatchHistory(providerIds, session) {
  const ids = providerIds.filter(Boolean);
  const output = new Map(ids.map(id => [String(id), { verifiedCompletedCount: 0, verifiedFeedbackCount: 0, averageVerifiedRating: null }]));
  if (!ids.length) return output;
  let completedQuery = EmergencyRequest.aggregate([
    { $match: { 'fulfillmentConfirmation.confirmed': true } },
    { $unwind: '$assignments' },
    { $match: { 'assignments.provider': { $in: ids }, 'assignments.status': 'fulfilled' } },
    { $group: {
      _id: '$assignments.provider',
      count: { $sum: 1 },
      etaKnownCount: { $sum: { $cond: [{ $ne: ['$assignments.eta', null] }, 1, 0] } },
      onTimeCount: { $sum: { $cond: [{ $and: [{ $ne: ['$assignments.eta', null] }, { $lte: ['$assignments.completedAt', '$assignments.eta'] }] }, 1, 0] } }
    } }
  ]);
  let feedbackQuery = Feedback.aggregate([
    { $match: { provider: { $in: ids }, verifiedFulfillment: true } },
    { $group: { _id: '$provider', count: { $sum: 1 }, average: { $avg: '$rating' } } }
  ]);
  if (session) { completedQuery = completedQuery.session(session); feedbackQuery = feedbackQuery.session(session); }
  const [completed, feedback] = session
    ? [await completedQuery, await feedbackQuery]
    : await Promise.all([completedQuery, feedbackQuery]);
  for (const row of completed) Object.assign(output.get(String(row._id)), { verifiedCompletedCount: row.count, etaKnownCompletedCount: row.etaKnownCount, onTimeCompletedCount: row.onTimeCount });
  for (const row of feedback) {
    const record = output.get(String(row._id));
    if (record) { record.verifiedFeedbackCount = row.count; record.averageVerifiedRating = row.average; }
  }
  return output;
}
