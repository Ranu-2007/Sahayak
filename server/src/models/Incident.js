import mongoose from 'mongoose';

const incidentSchema = new mongoose.Schema({
  incidentId: { type: String, required: true, unique: true, index: true },
  emergencyType: { type: String, required: true, index: true },
  category: { type: String, default: 'Other emergency supplies', index: true },
  affectedAreaType: { type: String, enum: ['village', 'neighborhood', 'road', 'facility', 'watershed', 'other'], default: 'other' },
  title: { type: String, required: true, maxlength: 180 },
  matchingReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmergencyRequest' },
  location: { label: { type: String, required: true }, coordinatesAuthorized: { type: Boolean, default: false }, coordinates: { type: [Number], default: [0, 0] } },
  firstReportedAt: { type: Date, required: true, index: true },
  lastReportedAt: { type: Date, required: true, index: true },
  reportCount: { type: Number, default: 1, min: 1 },
  totalAffectedPeople: { type: Number, default: 0, min: 0 },
  affectedPeopleEstimateMethod: { type: String, default: 'maximum individual estimate; reports may overlap' },
  maximumSeverity: { type: String, enum: ['critical', 'high', 'medium', 'low'], default: 'medium' },
  averageSeverity: { type: Number, min: 0, max: 4, default: 2 },
  verifiedReportCount: { type: Number, default: 0, min: 0 },
  unverifiedReportCount: { type: Number, default: 1, min: 0 },
  communityConfirmationCount: { type: Number, default: 0, min: 0 },
  duplicateReportCount: { type: Number, default: 0, min: 0 },
  incidentAgeHours: { type: Number, default: 0, min: 0 },
  priorityScore: { type: Number, default: 0, min: 0, max: 100 },
  priorityLevel: { type: String, enum: ['P1', 'P2', 'P3', 'P4'], default: 'P4' },
  reporterIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  reportIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'EmergencyRequest' }],
  estimatedAffectedPeople: { type: Number, default: 0, min: 0 },
  highestReportPriority: { type: Number, default: 0, min: 0, max: 100 },
  highestReportUrgency: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
  status: { type: String, enum: ['active', 'resolved'], default: 'active', index: true },
  resolvedAt: { type: Date, default: null, index: true },
  responseStatus: { type: String, enum: ['reported', 'under_review', 'verified', 'awaiting_response', 'claimed', 'preparing_assistance', 'on_the_way', 'reached_location', 'assistance_in_progress', 'partially_resolved', 'resolved', 'reopened'], default: 'reported', index: true },
  responders: [{
    provider: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true },
    status: { type: String, enum: ['claimed', 'preparing_assistance', 'on_the_way', 'reached_location', 'assistance_in_progress', 'partially_resolved', 'resolved', 'withdrawn'], default: 'claimed' },
    services: [{ type: String, trim: true, maxlength: 100 }],
    task: { type: String, trim: true, maxlength: 500 },
    estimatedArrival: Date,
    startedAt: Date,
    completedAt: Date,
    withdrawalReason: { type: String, trim: true, maxlength: 500 },
    resources: [{ name: { type: String, required: true, trim: true, maxlength: 100 }, quantity: { type: Number, min: 0 }, unit: { type: String, trim: true, maxlength: 30 }, status: { type: String, enum: ['planned', 'prepared', 'dispatched', 'delivered', 'unavailable'], default: 'planned' }, updatedAt: { type: Date, default: Date.now } }],
    claimedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    resolutionUpdate: { type: String, trim: true, maxlength: 1000 },
    statusHistory: [{ status: String, update: { type: String, maxlength: 1000 }, at: { type: Date, default: Date.now } }],
  }],
  responseHistory: [{ status: String, provider: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider' }, update: { type: String, maxlength: 1000 }, at: { type: Date, default: Date.now }, actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' } }],
  resolutionFeedback: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, action: { type: String, enum: ['confirmed_resolved', 'still_present', 'incomplete'], required: true }, note: { type: String, trim: true, maxlength: 500 }, at: { type: Date, default: Date.now } }],
  lastWorsenedAt: Date,
  priorityHistory: [{ score: { type: Number, min: 0, max: 100 }, level: String, severity: String, maximumReportedSeverity: String, averageReportedSeverity: Number, at: { type: Date, default: Date.now }, reportId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmergencyRequest' } }],
}, { timestamps: true });

incidentSchema.index({ emergencyType: 1, status: 1, lastReportedAt: -1 });
incidentSchema.index({ 'location.coordinates': '2dsphere' });
incidentSchema.index({ category: 1, status: 1, priorityScore: -1, lastReportedAt: -1 });
incidentSchema.index({ reportIds: 1 });
export default mongoose.models.Incident || mongoose.model('Incident', incidentSchema);
