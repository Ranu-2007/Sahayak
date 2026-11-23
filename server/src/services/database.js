import EmergencyRequest from '../models/EmergencyRequest.js';
import Incident from '../models/Incident.js';
import LiveLocationSession from '../models/LiveLocationSession.js';

// Mongoose autoIndex may be disabled in production. Keep retry idempotency
// enforced by MongoDB itself instead of relying on an application pre-check.
export async function ensureDatabaseIndexes() {
  await EmergencyRequest.collection.createIndex(
    { reportedBy: 1, clientReportId: 1 },
    {
      name: 'reportedBy_1_clientReportId_1',
      unique: true,
      partialFilterExpression: { clientReportId: { $type: 'string' } },
    },
  );
  await Incident.collection.createIndex(
    { status: 1, resolvedAt: -1 },
    { name: 'status_1_resolvedAt_-1' },
  );
  await LiveLocationSession.collection.createIndex(
    { expiresAt: 1 },
    { name: 'live_location_expiry_ttl', expireAfterSeconds: 60 * 60 * 24 * 7 },
  );
  await LiveLocationSession.collection.createIndex(
    { report: 1, status: 1 },
    { name: 'live_location_report_status' },
  );
  await LiveLocationSession.collection.createIndex(
    { report: 1 },
    { name: 'one_active_live_location_per_report', unique: true, partialFilterExpression: { status: 'active' } },
  );
  await LiveLocationSession.collection.createIndex(
    { requester: 1 },
    { name: 'one_active_live_location_per_requester', unique: true, partialFilterExpression: { status: 'active' } },
  );
}
