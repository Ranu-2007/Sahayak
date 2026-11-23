import mongoose from 'mongoose';

const locationPoint = new mongoose.Schema({
  type: { type: String, enum: ['Point'], default: 'Point' },
  coordinates: { type: [Number], required: true },
}, { _id: false });

const schema = new mongoose.Schema({
  requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  report: { type: mongoose.Schema.Types.ObjectId, ref: 'EmergencyRequest', required: true, index: true },
  incident: { type: mongoose.Schema.Types.ObjectId, ref: 'Incident', index: true },
  status: { type: String, enum: ['active', 'stopped', 'expired'], default: 'active', index: true },
  startedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: true },
  stoppedAt: Date,
  lastUpdatedAt: Date,
  lastLocation: locationPoint,
  accuracyMeters: { type: Number, min: 0, max: 100000 },
  source: { type: String, enum: ['gps', 'manual'], default: 'gps' },
}, { timestamps: true });

schema.index({ report: 1, status: 1 }, { name: 'live_location_report_status' });
schema.index({ report: 1 }, { name: 'one_active_live_location_per_report', unique: true, partialFilterExpression: { status: 'active' } });
schema.index({ requester: 1 }, { name: 'one_active_live_location_per_requester', unique: true, partialFilterExpression: { status: 'active' } });
schema.index({ expiresAt: 1 }, { name: 'live_location_expiry_ttl', expireAfterSeconds: 60 * 60 * 24 * 7 });

export default mongoose.model('LiveLocationSession', schema);
