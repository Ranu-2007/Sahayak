import mongoose from 'mongoose';
const requestSchema = new mongoose.Schema({
  requestId: { type: String, required: true },
  clientReportId: { type: String, trim: true, maxlength: 80 },
  clientReportedAt: Date,
  synchronizedAt: Date,
  offlineSync: { type: Boolean, default: false },
  originalResponseDeadline: Date,
  emergencyType: { type: String, enum: ['Flood', 'Earthquake', 'Cyclone', 'Tsunami', 'Landslide', 'Storm', 'House fire', 'Explosion', 'Road accident', 'Train accident', 'Industrial accident', 'Water contamination', 'Hospital issue', 'Disease outbreak', 'Sanitation problem', 'Infrastructure failure', 'Other'], default: 'Other', index: true },
  incidentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Incident', index: true },
  affectedAreaType: { type: String, enum: ['village', 'neighborhood', 'road', 'facility', 'watershed', 'other'], default: 'other' },
  title: { type: String, required: true, trim: true, maxlength: 180 }, category: { type: String, required: true, enum: ['Medical assistance', 'Rescue and evacuation', 'Food and drinking water', 'Temporary shelter', 'Transportation', 'Communication equipment', 'Electricity and generators', 'Medical equipment', 'Clothing and blankets', 'Other emergency supplies'] },
  description: { type: String, trim: true, maxlength: 2000 },
  requiredService: { type: String, required: true, trim: true, maxlength: 120 },
  latitude: { type: Number, min: -90, max: 90, default: null },
  longitude: { type: Number, min: -180, max: 180, default: null },
  reportedAt: { type: Date, default: Date.now, index: true },
  affectedPeople: { type: Number, required: true, min: 0, max: 10000000 },
  responseDeadline: { type: Date, required: true },
  contact: { name: { type: String, required: true, trim: true, maxlength: 100 }, email: { type: String, trim: true, lowercase: true, maxlength: 254 }, phone: { type: String, trim: true, maxlength: 30 } },
  items: [{ resource: { type: String, required: true }, quantity: { type: Number, min: 0, required: true }, unit: { type: String, required: true } }],
  requiredSkills: [{ type: String, trim: true }],
  location: { label: { type: String, required: true, trim: true }, coordinatesAuthorized: { type: Boolean, default: false }, coordinates: { type: [Number], default: [0, 0] }, accuracyMeters: { type: Number, min: 0, max: 100000 }, capturedAt: Date, source: { type: String, enum: ['gps', 'manual'] } },
  urgency: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
  priorityOverride: { level: { type: String, enum: ['P1', 'P2', 'P3', 'P4'] }, score: { type: Number, min: 0, max: 100, validate: Number.isInteger }, severity: { type: String, enum: ['Critical', 'High', 'Medium', 'Low'] }, reason: { type: String, trim: true, maxlength: 500 }, updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, updatedAt: Date },
  status: { type: String, enum: ['reported', 'verified', 'awaiting_match', 'assigned', 'in_progress', 'awaiting_confirmation', 'fulfilled', 'cancelled', 'duplicate', 'submitted', 'under_review', 'matching', 'accepted', 'partially_fulfilled', 'expired'], default: 'reported' },
  verification: { state: { type: String, enum: ['unverified', 'verified', 'disputed'], default: 'unverified' }, verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, verifiedAt: Date, notes: String },
  evidence: [{ clientFileId: { type: String, maxlength: 80 }, storageKey: { type: String, required: true }, mediaType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'], required: true }, size: { type: Number, required: true }, originalName: { type: String, required: true, maxlength: 160 }, uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, uploadedAt: { type: Date, default: Date.now } }],
  communityConfirmations: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, action: { type: String, enum: ['confirm_issue', 'also_affected', 'issue_not_found', 'problem_resolved'], default: 'confirm_issue' }, createdAt: { type: Date, default: Date.now }, coordinates: { type: [Number], required: true }, locationMismatch: { type: Boolean, default: false } }],
  reviewFlags: [{ type: String, trim: true, maxlength: 200 }],
  duplicateOf: { type: mongoose.Schema.Types.ObjectId, ref: 'EmergencyRequest' },
  assignments: [{ provider: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true }, status: { type: String, enum: ['offered', 'accepted', 'declined', 'in_progress', 'partially_fulfilled', 'fulfilled', 'cancelled'], default: 'offered' }, matchScore: { type: Number, min: 0, max: 100 }, matchReasons: [String], limitations: [String], allocatedItems: [{ resource: String, quantity: Number, unit: String }], consumedItems: [{ resource: String, quantity: Number, unit: String }], eta: { type: Date }, providerNote: { type: String, maxlength: 1000 }, offeredAt: { type: Date, default: Date.now }, acceptedAt: Date, completedAt: Date }],
  fulfillmentConfirmation: { confirmed: { type: Boolean, default: false }, confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, confirmedAt: Date, notes: { type: String, maxlength: 1000 } },
  reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  coordinationNotes: [{ author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, body: { type: String, maxlength: 1000 }, createdAt: { type: Date, default: Date.now } }],
  reporterUpdates: [{ author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, body: { type: String, required: true, trim: true, maxlength: 1000 }, clientUpdateId: { type: String, trim: true, maxlength: 80 }, createdAt: { type: Date, default: Date.now } }],
}, { timestamps: true });
requestSchema.index({ 'location.coordinates': '2dsphere' });
requestSchema.index({ status: 1, urgency: 1, createdAt: -1 });
requestSchema.index({ status: 1, urgency: 1, responseDeadline: 1 });
requestSchema.index({ reportedBy: 1, createdAt: -1 });
requestSchema.index({ incidentId: 1, reportedAt: -1 });
requestSchema.index({ responseDeadline: 1, status: 1 });
requestSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });
requestSchema.index({ reportedBy: 1, clientReportId: 1 }, { unique: true, partialFilterExpression: { clientReportId: { $type: 'string' } } });
// API-facing names from the request model map onto the established persisted fields.
requestSchema.virtual('requesterId').get(function getRequesterId() { return this.reportedBy; }).set(function setRequesterId(value) { this.reportedBy = value; });
requestSchema.virtual('priority').get(function getPriority() { return this.urgency; }).set(function setPriority(value) { this.urgency = String(value).toLowerCase(); });
requestSchema.virtual('requiredResources').get(function getRequiredResources() { return this.items; }).set(function setRequiredResources(value) { this.items = value; });
requestSchema.virtual('requiredBy').get(function getRequiredBy() { return this.responseDeadline; }).set(function setRequiredBy(value) { this.responseDeadline = value; });
requestSchema.virtual('peopleAffected').get(function getPeopleAffected() { return this.affectedPeople; }).set(function setPeopleAffected(value) { this.affectedPeople = value; });
requestSchema.virtual('assignedProviderIds').get(function getAssignedProviderIds() { return this.assignments.map(assignment => assignment.provider); });
export default mongoose.model('EmergencyRequest', requestSchema);
