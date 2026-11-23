import test from 'node:test';
import assert from 'node:assert/strict';
import { sortOfflineReports } from './offlinePriority.js';

const report = (localId, urgency, description, affectedPeople, createdAt) => ({ localId, createdAt, payload: { urgency, description, affectedPeople } });

test('offline transfer puts immediate life danger ahead of routine critical urgency', () => {
  const routine = report('routine', 'critical', 'Request supplies for the neighborhood', 80, '2026-11-21T10:00:00Z');
  const trapped = report('trapped', 'low', 'People are trapped and cannot escape', 2, '2026-11-21T10:02:00Z');
  assert.deepEqual(sortOfflineReports([routine, trapped]).map(item => item.localId), ['trapped', 'routine']);
});

test('offline transfer uses urgency, vulnerable groups, capped population, and waiting time as tie breakers', () => {
  const critical = report('critical', 'critical', 'Need clean water', 20, '2026-11-21T10:00:00Z');
  const high = report('high', 'high', 'Need clean water', 20, '2026-11-21T09:00:00Z');
  const vulnerable = report('vulnerable', 'medium', 'Children need shelter', 20, '2026-11-21T10:00:00Z');
  const larger = report('larger', 'medium', 'Shelter needed', 9000, '2026-11-21T10:00:00Z');
  const older = report('older', 'medium', 'Shelter needed', 9000, '2026-11-20T10:00:00Z');
  assert.deepEqual(sortOfflineReports([high, vulnerable, critical, larger, older]).map(item => item.localId), ['critical', 'high', 'vulnerable', 'older', 'larger']);
});
