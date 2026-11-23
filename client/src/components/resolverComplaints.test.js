import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAndRankComplaints } from './resolverComplaints.js';

const row = (id, score, extras = {}) => ({ _id: id, category: 'Medical assistance', affectedPeople: 2, reportedAt: '2026-11-20T11:00:00Z', priority: { score, severity: 'High' }, location: { coordinatesAuthorized: true, coordinates: [0, 0] }, assignments: [], ...extras });

test('resolver complaint filters combine severity, category, affected count and assignment state', () => {
  const rows = [row('p1', 91, { priority: { score: 91, severity: 'Critical' }, affectedPeople: 20 }), row('active', 72, { assignments: [{ status: 'accepted' }] }), row('small', 65, { affectedPeople: 1 })];
  const filtered = filterAndRankComplaints(rows, { severity: 'critical', category: 'Medical assistance', minAffected: '10', unassignedOnly: true });
  assert.deepEqual(filtered.map(item => item._id), ['p1']);
});

test('nearby filter uses authorized complaint coordinates and results stay score ranked', () => {
  const rows = [row('lower', 60), row('higher', 90), row('far', 99, { location: { coordinatesAuthorized: true, coordinates: [10, 10] } }), row('private', 100, { location: { coordinatesAuthorized: false, coordinates: [0, 0] } })];
  const filtered = filterAndRankComplaints(rows, { nearbyCenter: [0, 0] });
  assert.deepEqual(filtered.map(item => item._id), ['higher', 'lower']);
});
