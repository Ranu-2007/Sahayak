const urgencyRank = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

export function offlineTransferRank(report) {
  const urgency = urgencyRank[String(report.payload?.urgency || 'medium').toLowerCase()] ?? urgencyRank.medium;
  const text = `${report.payload?.title || ''} ${report.payload?.description || ''} ${report.payload?.emergencyType || ''}`;
  const immediateDanger = /trapped|cannot escape|unconscious|not breathing|severe bleeding|building collapse/i.test(text) ? 0 : 1;
  const vulnerability = /child|children|infant|elderly|pregnan|disabilit|injur|seriously ill/i.test(text) ? 0 : 1;
  const people = Math.min(1000, Number(report.payload?.affectedPeople || 0));
  const waiting = new Date(report.createdAt).getTime();
  return [immediateDanger, urgency, vulnerability, -people, waiting];
}

export function sortOfflineReports(reports) {
  return [...reports].sort((a, b) => {
    const left = offlineTransferRank(a), right = offlineTransferRank(b);
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
    return 0;
  });
}
