const DEFAULT_WEIGHTS = Object.freeze({
  evidence: 20,
  communityConfirmation: 10,
  nearbyReport: 10,
  resolverVerification: 25,
  locationMismatch: -10,
  suspiciousActivity: -20,
});

export function confidenceWeights() {
  const raw = process.env.CONFIDENCE_WEIGHTS_JSON;
  if (!raw) return { ...DEFAULT_WEIGHTS };
  try {
    const configured = JSON.parse(raw);
    const keys = Object.keys(DEFAULT_WEIGHTS);
    if (!configured || Object.keys(configured).some(key => !keys.includes(key)) || keys.some(key => !Number.isFinite(configured[key]) || Math.abs(configured[key]) > 100)) throw new Error('invalid confidence weights');
    return { ...configured };
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

export function communitySignalCounts(responses = []) {
  return responses.reduce((counts, response) => {
    const action = response.action || 'confirm_issue';
    if (Object.hasOwn(counts, action)) {
      counts[action] += 1;
      if (response.locationMismatch !== true && ['confirm_issue', 'also_affected'].includes(action)) counts.nearbyPositive += 1;
    }
    if (response.locationMismatch === true) counts.locationMismatch += 1;
    return counts;
  }, { confirm_issue: 0, also_affected: 0, issue_not_found: 0, problem_resolved: 0, nearbyPositive: 0, locationMismatch: 0 });
}

export function verificationStatus(request, signals = communitySignalCounts(request.communityConfirmations), suspiciousActivity = 0) {
  if (['fulfilled', 'resolved'].includes(request.status)) return 'resolved';
  if (request.verification?.state === 'disputed' || signals.locationMismatch >= 3 || request.reviewFlags?.length || suspiciousActivity > 0) return 'flagged for review';
  if (request.verification?.state === 'verified') return 'officially verified';
  if (['under_review', 'submitted'].includes(request.status) && request.status === 'under_review') return 'under review';
  if (signals.nearbyPositive >= 3) return 'community supported';
  return 'unverified';
}

export function confidenceScore(request, { similarReports = 0, sameReporterDuplicates = 0 } = {}) {
  const weights = confidenceWeights();
  const signals = communitySignalCounts(request.communityConfirmations);
  const contributions = [];
  let score = 0;
  const add = (signal, value, points, reason) => {
    score += points;
    contributions.push({ signal, value, points, reason });
  };

  const evidenceCount = request.evidence?.length || 0;
  add('evidence', evidenceCount, evidenceCount ? weights.evidence : 0, evidenceCount ? `${evidenceCount} private evidence file(s) attached.` : 'No evidence is attached.');
  const positiveCount = Math.min(signals.nearbyPositive, 3);
  add('communityConfirmations', signals.nearbyPositive, positiveCount * weights.communityConfirmation, `${signals.nearbyPositive} nearby positive response(s); only these count toward community support.`);
  const distinctNearbyReports = Math.max(0, similarReports - sameReporterDuplicates);
  const nearbyPoints = Math.min(distinctNearbyReports, 2) * weights.nearbyReport;
  add('nearbyReports', distinctNearbyReports, nearbyPoints, `${distinctNearbyReports} related report(s) from other reporters in the same area and time window.`);
  const resolverVerified = request.verification?.state === 'verified';
  add('resolverVerification', resolverVerified, resolverVerified ? weights.resolverVerification : 0, resolverVerified ? 'A coordinator officially verified this report.' : 'No coordinator verification is recorded.');
  add('locationMismatch', signals.locationMismatch, signals.locationMismatch ? weights.locationMismatch : 0, signals.locationMismatch ? `${signals.locationMismatch} response(s) came from more than 2 km away; review the location mismatch.` : 'No community response location mismatch is recorded.');
  add('suspiciousActivity', sameReporterDuplicates, sameReporterDuplicates ? weights.suspiciousActivity : 0, sameReporterDuplicates ? `${sameReporterDuplicates} nearby similar report(s) came from the same reporter; review for duplicates.` : 'No repeated same-reporter cluster pattern is detected.');

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, status: verificationStatus(request, signals, sameReporterDuplicates), signals: contributions, weights, caution: 'This score summarizes review signals. It is not proof that a complaint is true.' };
}

export function descriptionSimilarity(left = '', right = '') {
  const stopWords = new Set(['about', 'after', 'also', 'and', 'area', 'around', 'because', 'been', 'being', 'from', 'have', 'into', 'near', 'need', 'that', 'the', 'there', 'they', 'this', 'were', 'with', 'would']);
  const tokens = value => new Set(String(value).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.filter(token => token.length > 2 && !stopWords.has(token)) || []);
  const a = tokens(left), b = tokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter(token => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

export function distanceMeters([lon1, lat1], [lon2, lat2]) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(lat2 - lat1), dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function buildComplaintGroups(complaints, viewer, canViewEvidence) {
  const groups = [];
  for (const complaint of complaints) {
    const point = complaint.location?.coordinates;
    const located = complaint.location?.coordinatesAuthorized && validCoordinates(point);
    const createdAt = new Date(complaint.reportedAt || complaint.createdAt).getTime();
    let group = located && groups.find(candidate => candidate.category.toLowerCase() === complaint.category.toLowerCase() && candidate.members.some(member => {
      if (!member.point || Math.abs(createdAt - member.createdAt) > 72 * 60 * 60 * 1000) return false;
      const distance = distanceMeters(member.point, point);
      return distance <= 500 && (distance <= 150 || descriptionSimilarity(member.description, complaint.description) >= 0.25);
    }));
    if (!group) {
      group = { category: complaint.category, members: [] };
      groups.push(group);
    }
    group.members.push({ complaint, point: located ? point : null, createdAt });
  }
  return groups.map(({ category, members }) => {
    const reporters = members.map(({ complaint }) => String(complaint.reportedBy?._id || complaint.reportedBy));
    const totalPeopleAffected = members.reduce((sum, { complaint }) => sum + (Number(complaint.affectedPeople) || 0), 0);
    const reports = members.map(({ complaint }) => {
      const reporterId = String(complaint.reportedBy?._id || complaint.reportedBy);
      const sameReporterDuplicates = members.filter(member => member.complaint._id !== complaint._id && String(member.complaint.reportedBy?._id || member.complaint.reportedBy) === reporterId).length;
      const related = members.filter(member => member.complaint._id !== complaint._id);
      const confidence = confidenceScore(complaint, { similarReports: related.length, sameReporterDuplicates });
      const signals = communitySignalCounts(complaint.communityConfirmations);
      return {
        _id: complaint._id,
        requestId: complaint.requestId,
        category: complaint.category,
        urgency: complaint.urgency,
        createdAt: complaint.reportedAt || complaint.createdAt,
        affectedPeople: complaint.affectedPeople || 0,
        confirmationCount: complaint.communityConfirmations?.length || 0,
        nearbyConfirmationCount: signals.nearbyPositive,
        communityFeedback: signals,
        viewerCommunityAction: viewerAction(complaint.communityConfirmations, viewer._id),
        verificationStatus: confidence.status,
        confidence,
        locationWarning: signals.locationMismatch > 0 ? 'Community feedback includes a location more than 2 km from this report.' : null,
        location: { coordinatesAuthorized: Boolean(complaint.location?.coordinatesAuthorized) },
        evidence: canViewEvidence(complaint, viewer) ? (complaint.evidence || []).map(file => ({ _id: file._id, mediaType: file.mediaType, size: file.size, uploadedAt: file.uploadedAt })) : [],
      };
    });
    return { category, count: reports.length, affectedReports: reports.length, totalPeopleAffected, duplicateCandidate: reports.length > 1, complaints: reports };
  });
}

function viewerAction(responses = [], viewerId) {
  const response = responses.find(item => String(item.user) === String(viewerId));
  return response ? response.action || 'confirm_issue' : null;
}
function validCoordinates(value) { return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite); }
