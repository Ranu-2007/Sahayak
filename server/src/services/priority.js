// Configurable request priority rules. Scores support triage; they never decide
// whether a complaint is accepted or whether emergency services are contacted.
export const priorityConfig = Object.freeze({
  // Requester-selected urgency informs triage but cannot alone force P1.
  urgencyPoints: Object.freeze({ critical: 45, high: 35, medium: 25, low: 15 }),
  affectedPeopleMaxPoints: 12,
  affectedPeopleLogScale: 3,
  unresolvedPointsPerHour: 1,
  levelThresholds: Object.freeze({ P1: 80, P2: 60, P3: 35 }),
  immediateDangerFloor: 85,
});

const dangerSignals = [
  [/\b(trapped|stranded|cannot escape|can't escape)\b/i, 'People are reported trapped or unable to leave.'],
  [/\b(flood|floodwater|rising water|water level.{0,15}rise)\b/i, 'Flooding or rising water is reported.'],
  [/\b(unconscious|not breathing|severe bleeding|life.?threatening)\b/i, 'The report describes an immediate life-threatening medical danger.'],
  [/\b(contaminat\w*|unsafe drinking water|poison\w* water)\b/i, 'Water contamination or unsafe drinking water is reported.'],
  [/\b(child|children|infant|elderly|pregnan\w*|disabilit\w*)\b/i, 'The report identifies people who may need additional assistance.'],
];

function classifyPriority(score) {
  if (score >= priorityConfig.levelThresholds.P1) return 'P1';
  if (score >= priorityConfig.levelThresholds.P2) return 'P2';
  if (score >= priorityConfig.levelThresholds.P3) return 'P3';
  return 'P4';
}

export function recommendedAction(request) {
  const text = `${request.emergencyType || ''} ${request.category || ''} ${request.title || ''} ${request.description || ''} ${request.requiredService || ''}`;
  if (/contaminat\w* water|unsafe drinking water|water test|water quality/i.test(text)) return 'Water testing and safe drinking water distribution';
  if (/flood|floodwater|rising water|water level.{0,15}rise/i.test(text)) return 'Rescue assessment and evacuation assistance';
  if (/garbage|rubbish|waste|sanitation|sewage/i.test(text)) return 'Sanitation team coordination';
  if (/damaged road|road damage|bridge damage|pothole|infrastructure/i.test(text)) return 'Infrastructure inspection and repair';
  if (/medical|health|injur|illness|sick|unconscious/i.test(text)) return 'Medical assessment or health team coordination';
  if (/rescue|evacuat|trapped|stranded/i.test(text)) return 'Rescue assessment and evacuation assistance';
  if (/water|drinking/i.test(text)) return 'Assess water access and coordinate safe drinking water distribution';
  if (/food/i.test(text)) return 'Assess food need and coordinate safe food distribution';
  if (/shelter|housing/i.test(text)) return 'Assess immediate shelter needs and coordinate temporary shelter';
  return 'Review the reported need and coordinate an appropriate response';
}

export function calculatePriority(request, now = new Date()) {
  const urgency = String(request.urgency || 'medium').toLowerCase();
  const text = `${request.emergencyType || ''} ${request.title || ''} ${request.description || ''} ${request.requiredService || ''}`;
  const people = Math.max(0, Number(request.affectedPeople) || 0);
  const reportedAt = new Date(request.reportedAt || request.createdAt || now);
  const ageHours = Number.isFinite(reportedAt.getTime()) ? Math.max(0, (now.getTime() - reportedAt.getTime()) / 3600000) : 0;
  const dangerReasons = dangerSignals.filter(([pattern]) => pattern.test(text)).map(([, reason]) => reason);
  const immediateDanger = /\b(immediate|life.?threatening|trapped|unconscious|not breathing|severe bleeding)\b/i.test(text);
  const urgencyPoints = priorityConfig.urgencyPoints[urgency] ?? priorityConfig.urgencyPoints.medium;
  const peoplePoints = Math.min(priorityConfig.affectedPeopleMaxPoints, Math.round(Math.log10(people + 1) * priorityConfig.affectedPeopleLogScale));
  const agePoints = Math.floor(ageHours * priorityConfig.unresolvedPointsPerHour);
  const categoryPoints = /rescue|evacuat|medical|health|earthquake|cyclone|tsunami|landslide|fire|explosion|accident/i.test(`${request.emergencyType || ''} ${request.category || ''} ${request.requiredService || ''}`) ? 8 : /water|food|shelter|sanitation|storm|flood/i.test(`${request.emergencyType || ''} ${request.category || ''} ${request.requiredService || ''}`) ? 5 : 2;
  const unverifiedPoints = 0; // Unverified reports remain eligible and are never down-ranked.
  const rawScore = Math.min(100, urgencyPoints + peoplePoints + agePoints + categoryPoints + dangerReasons.length * 4);
  const score = immediateDanger ? Math.max(priorityConfig.immediateDangerFloor, rawScore) : rawScore;
  const level = classifyPriority(score);
  const reasons = [];
  if (immediateDanger) reasons.push('Immediate danger is described in the complaint; the score floor protects urgent triage.');
  reasons.push(...dangerReasons);
  if (people > 0) reasons.push(`${people.toLocaleString()} ${people === 1 ? 'person is' : 'people are'} affected.`);
  if (ageHours >= 0.5 && !['fulfilled', 'cancelled', 'duplicate'].includes(request.status)) reasons.push(`The unresolved complaint has been open for ${ageHours < 1 ? `${Math.floor(ageHours * 60)} minutes` : `${Math.floor(ageHours)} hours`}; unresolved time gradually raises its score.`);
  if (!dangerReasons.length && !immediateDanger) reasons.push(`The request is marked ${urgency} urgency.`);
  if (request.verification?.state !== 'verified') reasons.push('Verification is pending; this does not lower priority, and coordinator review is recommended.');
  if (!reasons.length) reasons.push('Priority is based on the recorded urgency, affected population, category, and unresolved time.');
  return {
    score,
    level,
    severity: ({ P1: 'Critical', P2: 'High', P3: 'Medium', P4: 'Low' })[level],
    immediateDanger,
    reasons,
    recommendedAction: recommendedAction(request),
    calculatedAt: now.toISOString(),
    factors: { urgencyPoints, affectedPeoplePoints: peoplePoints, unresolvedHours: Math.floor(ageHours), unresolvedTimePoints: agePoints, categoryPoints, immediateDangerFloorApplied: immediateDanger && rawScore < priorityConfig.immediateDangerFloor, verificationPenalty: unverifiedPoints },
  };
}

export function withPriority(request, now = new Date()) {
  const computed = calculatePriority(request, now);
  const override = request.priorityOverride;
  if (!override?.level || !Number.isInteger(override.score)) return { ...request, priority: computed };
  return { ...request, priority: { ...computed, level: override.level, score: override.score, severity: override.severity || computed.severity, reasons: [...computed.reasons, `An administrator adjusted priority: ${override.reason}`], manualOverride: { reason: override.reason, updatedAt: override.updatedAt, updatedBy: override.updatedBy } } };
}

export function rankRequests(requests, now = new Date()) {
  return requests.map(request => withPriority(request, now))
    .sort((a, b) => b.priority.score - a.priority.score || new Date(a.reportedAt || a.createdAt) - new Date(b.reportedAt || b.createdAt));
}
