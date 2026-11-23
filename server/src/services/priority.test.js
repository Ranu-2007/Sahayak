import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePriority, rankRequests, recommendedAction, withPriority } from './priority.js';

const fixedNow = new Date('2026-11-20T12:00:00.000Z');
const request = overrides => ({
  urgency: 'medium', category: 'Other emergency supplies', title: 'General request', description: 'Needs support', requiredService: 'Coordination',
  affectedPeople: 0, reportedAt: new Date('2026-11-20T11:00:00.000Z'), status: 'reported', verification: { state: 'unverified' }, ...overrides,
});

test('life-threatening and critical complaints retain P1 when population data is incomplete', () => {
  const result = calculatePriority(request({ urgency: 'high', title: 'People trapped', affectedPeople: 0 }), fixedNow);
  assert.equal(result.level, 'P1');
  assert.equal(result.immediateDanger, true);
  assert.ok(result.reasons.some(reason => /trapped/i.test(reason)));
  assert.ok(result.reasons.some(reason => /does not lower priority/i.test(reason)));
});

test('requester-selected critical urgency alone cannot trigger the life-threatening score floor', () => {
  const result = calculatePriority(request({ urgency: 'critical', title: 'General request' }), fixedNow);
  assert.equal(result.immediateDanger, false);
  assert.ok(result.score < 80);
});

test('affected population contribution is capped and cannot outrank immediate danger on its own', () => {
  const none = calculatePriority(request({ urgency: 'low', affectedPeople: 0 }), fixedNow);
  const many = calculatePriority(request({ urgency: 'low', affectedPeople: 10000000 }), fixedNow);
  assert.equal(many.factors.affectedPeoplePoints, 12);
  assert.ok(many.score < 80);
  assert.ok(many.score > none.score);
});

test('unresolved complaints gain score over time', () => {
  const recent = calculatePriority(request({ urgency: 'low', reportedAt: fixedNow }), fixedNow);
  const older = calculatePriority(request({ urgency: 'low', reportedAt: new Date(fixedNow.getTime() - 5 * 3600000) }), fixedNow);
  assert.ok(older.score > recent.score);
});

test('recommended actions reflect complaint category and details', () => {
  assert.match(recommendedAction(request({ title: 'Flood water rising' })), /Rescue assessment/);
  assert.match(recommendedAction(request({ title: 'Contaminated water supply' })), /Water testing/);
  assert.match(recommendedAction(request({ category: 'Medical assistance' })), /Medical assessment/);
  assert.match(recommendedAction(request({ title: 'Garbage piling in street' })), /Sanitation team/);
  assert.match(recommendedAction(request({ title: 'Damaged road after storm' })), /Infrastructure inspection/);
});

test('resolver ranking sorts by backend score descending and uses age as tie break', () => {
  const ranked = rankRequests([
    request({ _id: 'older-low', urgency: 'low', reportedAt: new Date('2026-11-20T10:00:00.000Z') }),
    request({ _id: 'critical', urgency: 'critical', reportedAt: new Date('2026-11-20T11:00:00.000Z') }),
    request({ _id: 'newer-low', urgency: 'low', reportedAt: new Date('2026-11-20T11:30:00.000Z') }),
  ], fixedNow);
  assert.equal(ranked[0]._id, 'critical');
  assert.equal(ranked[1]._id, 'older-low');
  assert.equal(ranked[2]._id, 'newer-low');
});

test('manual admin override affects the effective priority and is disclosed', () => {
  const row = withPriority(request({ priorityOverride: { level: 'P1', score: 91, severity: 'Critical', reason: 'Coordinator confirmed immediate rescue need.' } }), fixedNow);
  assert.equal(row.priority.score, 91);
  assert.equal(row.priority.manualOverride.reason, 'Coordinator confirmed immediate rescue need.');
  assert.ok(row.priority.reasons.at(-1).includes('Coordinator confirmed'));
});
