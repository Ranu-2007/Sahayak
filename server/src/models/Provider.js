import mongoose from 'mongoose';
const providerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  registrationNumber: { type: String, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 1500 },
  representative: { name: { type: String, trim: true, maxlength: 100 }, designation: { type: String, trim: true, maxlength: 100 }, phone: { type: String, trim: true, maxlength: 30 }, email: { type: String, trim: true, lowercase: true, maxlength: 254 } },
  teamComposition: { teamSize: { type: Number, min: 0, max: 100000, default: 0 }, volunteers: { type: Number, min: 0, max: 100000, default: 0 }, medicalStaff: { type: Number, min: 0, max: 100000, default: 0 }, vehicles: { type: Number, min: 0, max: 100000, default: 0 }, equipment: [{ type: String, trim: true, maxlength: 100 }] },
  teamMembers: [{ name: { type: String, required: true, trim: true, maxlength: 100 }, role: { type: String, enum: ['Organization Admin', 'Coordinator', 'Responder', 'Medical Staff', 'Volunteer', 'Resource Manager'], required: true }, skills: [{ type: String, trim: true, maxlength: 80 }], availability: { type: String, enum: ['available', 'busy', 'unavailable'], default: 'available' }, activeAssignment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' }, notes: { type: String, trim: true, maxlength: 500 } }],
  providerType: { type: String, enum: ['individual', 'organization', 'hospital', 'ambulance', 'ngo', 'volunteer_group', 'supplier', 'rescue_team', 'other'], default: 'other' },
  category: { type: String, required: true, trim: true, maxlength: 80 },
  skills: [{ type: String, trim: true, maxlength: 80 }],
  qualifications: [{ type: String, trim: true, maxlength: 120 }],
  serviceCategories: [{ type: String, trim: true, maxlength: 80 }],
  credentials: [{ name: { type: String, required: true, maxlength: 100 }, issuer: { type: String, maxlength: 120 }, reference: { type: String, maxlength: 200 }, evidenceUrl: { type: String, maxlength: 500 }, status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' }, reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, reviewedAt: Date, notes: { type: String, maxlength: 500 } }],
  inventory: [{ resource: { type: String, required: true }, quantity: { type: Number, min: 0 }, availableQuantity: { type: Number, min: 0 }, reservedQuantity: { type: Number, min: 0, default: 0 }, allocatedQuantity: { type: Number, min: 0, default: 0 }, consumedQuantity: { type: Number, min: 0, default: 0 }, unit: { type: String, required: true }, updatedAt: { type: Date, default: Date.now } }],
  capacity: { type: Number, min: 1, default: 1 },
  location: { label: { type: String, maxlength: 200 }, type: { type: String, enum: ['Point'], default: 'Point' }, coordinates: { type: [Number], default: [0, 0] } },
  serviceRadiusKm: { type: Number, min: 0, default: 25 },
  operationalHours: { timezone: { type: String, default: 'UTC', maxlength: 80 }, schedule: [{ day: { type: Number, min: 0, max: 6 }, open: String, close: String, closed: { type: Boolean, default: false } }] },
  availability: { type: String, enum: ['available', 'limited', 'unavailable'], default: 'available' },
  availabilitySource: { type: String, enum: ['provider_reported', 'coordinator_confirmed'], default: 'provider_reported' },
  lastAvailabilityUpdated: { type: Date, default: Date.now },
  contactMethod: { email: { type: String, trim: true, lowercase: true, maxlength: 254 }, phone: { type: String, trim: true, maxlength: 30 }, website: { type: String, trim: true, maxlength: 500 }, preferred: { type: String, enum: ['email', 'phone', 'website', 'platform'], default: 'platform' } },
  verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected', 'suspended'], default: 'pending' },
  verified: { type: Boolean, default: false }, verifiedAt: Date, verificationNotes: { type: String, maxlength: 1000 },
  reliability: { type: Number, min: 0, max: 100, default: 50 },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  suspendedAt: Date, suspensionReason: { type: String, maxlength: 500 },
}, { timestamps: true });
providerSchema.index({ location: '2dsphere' });
providerSchema.index({ owner: 1 }, { unique: true });
providerSchema.index({ availability: 1, verificationStatus: 1, lastAvailabilityUpdated: -1 });
export default mongoose.model('Provider', providerSchema);
