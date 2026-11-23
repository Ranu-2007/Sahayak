import LiveLocationSession from '../models/LiveLocationSession.js';
import EmergencyRequest from '../models/EmergencyRequest.js';
import Incident from '../models/Incident.js';
import Provider from '../models/Provider.js';
import { publishPrivateEvent } from './liveEvents.js';

export async function expireLiveLocations() {
  const now = new Date();
  const expired = await LiveLocationSession.find({ status: 'active', expiresAt: { $lte: now } }).select('_id requester report incident').limit(500).lean();
  if (!expired.length) return 0;
  await LiveLocationSession.updateMany({ _id: { $in: expired.map(item => item._id) }, status: 'active', expiresAt: { $lte: now } }, { $set: { status: 'expired', stoppedAt: now } });
  const incidentIds = [...new Set(expired.filter(item => item.incident).map(item => String(item.incident)))];
  const incidents = incidentIds.length ? await Incident.find({ _id: { $in: incidentIds } }).select('_id responders').lean() : [];
  const providerIds = [...new Set(incidents.flatMap(incident => incident.responders.filter(responder => ['claimed','preparing_assistance','on_the_way','reached_location','assistance_in_progress','partially_resolved'].includes(responder.status)).map(responder => responder.provider)))];
  const owners = providerIds.length ? await Provider.distinct('owner', { _id: { $in: providerIds }, verificationStatus: 'verified' }) : [];
  for (const session of expired) {
    const report = await EmergencyRequest.findById(session.report).select('reportedBy').lean();
    publishPrivateEvent([session.requester, ...(report?.reportedBy ? [report.reportedBy] : []), ...owners], 'live-location-expired', { reportId: String(session.report), sessionId: String(session._id), expiredAt: now });
  }
  return expired.length;
}
