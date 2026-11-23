import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateIncidentStatistics, inferEmergencyType, matchesIncident } from './incidents.js';

const report = overrides => ({ emergencyType: 'Train accident', title: 'Train collision near Central station', description: 'Passengers need assessment after a train collision.', location: { label: 'Chennai Central', coordinatesAuthorized: true, coordinates: [80.2707, 13.0827] }, ...overrides });
const incident = overrides => ({ emergencyType: 'Train accident', title: 'Train collision near Central station', description: '', location: { label: 'Chennai Central', coordinatesAuthorized: true, coordinates: [80.271, 13.083] }, ...overrides });

test('same emergency type and close location link a report to the incident', () => {
  assert.equal(matchesIncident(report(), incident()), true);
});

test('different emergency types remain separate at the same location', () => {
  assert.equal(matchesIncident(report(), incident({ emergencyType: 'House fire' })), false);
});

test('nearby reports with unrelated details remain separate beyond the tight radius', () => {
  assert.equal(matchesIncident(report({ title: 'Train accident near station', description: 'Need help after collision' }), incident({ location: { label: 'Nearby', coordinatesAuthorized: true, coordinates: [80.276, 13.088] }, title: 'Power outage in apartments' })), false);
});

test('same location alone does not merge unrelated accidents into one incident', () => {
  assert.equal(matchesIncident(report({ title: 'Train collision at Central station', description: 'Multiple injured passengers need triage.' }), incident({ title: 'Train service delayed', description: 'Signal equipment failure with no accident.' })), false);
});

test('category and affected area characteristics must be compatible', () => {
  assert.equal(matchesIncident(report({ category: 'Food and drinking water', affectedAreaType: 'village' }), incident({ category: 'Medical assistance', affectedAreaType: 'village' })), false);
  assert.equal(matchesIncident(report({ category: 'Food and drinking water', affectedAreaType: 'village' }), incident({ category: 'Food and drinking water', affectedAreaType: 'facility' })), false);
});

test('reports outside the configured incident time window stay separate', () => {
  const now = Date.now();
  assert.equal(matchesIncident(report({ reportedAt: new Date(now) }), incident({ lastReportedAt: new Date(now - 73 * 3600000) })), false);
});

test('resolved incidents are excluded from automatic matching', () => {
  assert.equal(matchesIncident(report(), incident({ status: 'resolved' })), false);
});

test('far apart reports stay separate even when category and wording match', () => {
  assert.equal(matchesIncident(report({ category: 'Food and drinking water', title: 'Water contamination in Rampur', description: 'Residents report dirty water from the shared well.' }), incident({ category: 'Food and drinking water', title: 'Water contamination in Rampur', description: 'Residents report dirty water from the shared well.', location: { label: 'Other village', coordinatesAuthorized: true, coordinates: [80.6, 13.4] } })), false);
});

test('reports without shared precise coordinates require matching place and similar description', () => {
  const noCoordinates = { coordinatesAuthorized: false, coordinates: [0, 0], label: 'Chennai Central station' };
  assert.equal(matchesIncident(report({ location: noCoordinates }), incident({ location: noCoordinates })), true);
  assert.equal(matchesIncident(report({ location: noCoordinates }), incident({ location: { ...noCoordinates, label: 'Marina Beach' } })), false);
});

test('legacy reports can infer an emergency type from their content', () => {
  assert.equal(inferEmergencyType({ title: 'Train derailment near Central', description: 'Passengers need help', category: 'Rescue and evacuation' }), 'Train accident');
  assert.equal(inferEmergencyType({ title: 'Unsafe drinking water', description: 'Water appears contaminated' }), 'Water contamination');
});

test('incident statistics count reports and confirmations without summing overlapping populations', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const stats = calculateIncidentStatistics([
    { urgency: 'high', affectedPeople: 12, verification: { state: 'verified' }, communityConfirmations: [{}, {}], reportedAt: new Date('2026-01-01T10:00:00Z'), reportedBy: 'a' },
    { urgency: 'low', affectedPeople: 50, status: 'duplicate', duplicateOf: 'canonical', communityConfirmations: [{}], reportedAt: new Date('2026-01-01T11:00:00Z'), reportedBy: 'b' },
    { urgency: 'medium', affectedPeople: 20, communityConfirmations: [], reportedAt: new Date('2026-01-01T11:30:00Z'), reportedBy: 'c' },
  ], now);
  assert.equal(stats.totalReports, 3);
  assert.equal(stats.totalAffectedPeople, 20);
  assert.equal(stats.maximumSeverity, 'high');
  assert.equal(stats.averageSeverity, 2);
  assert.equal(stats.verifiedReportCount, 1);
  assert.equal(stats.unverifiedReportCount, 2);
  assert.equal(stats.communityConfirmationCount, 3);
  assert.equal(stats.duplicateReportCount, 1);
  assert.equal(stats.incidentAgeHours, 2);
});
