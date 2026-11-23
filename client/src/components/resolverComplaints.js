function distanceKm(origin, point) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(point[1] - origin[1]), dLon = radians(point[0] - origin[0]);
  const factor = Math.sin(dLat / 2) ** 2 + Math.cos(radians(origin[1])) * Math.cos(radians(point[1])) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(factor), Math.sqrt(1 - factor));
}

export function filterAndRankComplaints(requests, { severity = 'all', category = 'all', minAffected = '', nearbyCenter = null, unassignedOnly = false } = {}) {
  return requests.filter(row => {
    if (severity !== 'all' && String(row.priority?.severity || '').toLowerCase() !== severity) return false;
    if (category !== 'all' && row.category !== category) return false;
    if (minAffected !== '' && Number(row.affectedPeople || 0) < Number(minAffected)) return false;
    if (nearbyCenter && !(row.location?.coordinatesAuthorized && Array.isArray(row.location.coordinates) && row.location.coordinates.length === 2 && distanceKm(nearbyCenter, row.location.coordinates) <= 25)) return false;
    if (unassignedOnly && (row.assignments || []).some(item => ['offered', 'accepted', 'in_progress', 'partially_fulfilled'].includes(item.status))) return false;
    return true;
  }).slice().sort((a, b) => (b.priority?.score ?? -1) - (a.priority?.score ?? -1) || new Date(a.reportedAt || a.createdAt) - new Date(b.reportedAt || b.createdAt));
}
