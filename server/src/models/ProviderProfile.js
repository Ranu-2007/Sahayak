import mongoose from 'mongoose';

const providerProfileSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  organizationName: { type: String, trim: true, maxlength: 160 },
  providerType: { type: String, enum: ['individual', 'organization', 'hospital', 'ambulance', 'ngo', 'volunteer_group', 'supplier', 'rescue_team', 'other'], required: true },
  skills: [{ type: String, trim: true, maxlength: 100 }],
  certifications: [{ name: { type: String, required: true, trim: true, maxlength: 120 }, issuer: { type: String, trim: true, maxlength: 120 }, expiresAt: Date, verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' } }],
  serviceCategories: [{ type: String, trim: true, maxlength: 100 }],
  serviceArea: { label: { type: String, trim: true, maxlength: 200 }, radiusKm: { type: Number, min: 0, default: 25 }, polygon: { type: { type: String, enum: ['Polygon'] }, coordinates: [[[Number]]] } },
  location: { type: { type: String, enum: ['Point'], default: 'Point' }, coordinates: { type: [Number], default: undefined }, label: { type: String, trim: true, maxlength: 200 } },
  verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected', 'suspended'], default: 'pending', index: true },
  currentAvailability: { type: String, enum: ['available', 'limited', 'busy', 'unavailable'], default: 'unavailable', index: true },
  lastAvailabilityUpdate: { type: Date, default: Date.now, index: true },
  operatingHours: { timezone: { type: String, maxlength: 80, default: 'UTC' }, schedule: [{ day: { type: Number, min: 0, max: 6 }, open: String, close: String, closed: { type: Boolean, default: false } }] },
  reliabilityMetrics: { completedAssignments: { type: Number, min: 0, default: 0 }, onTimeRate: { type: Number, min: 0, max: 100 }, verifiedRating: { type: Number, min: 0, max: 5 }, lastCalculatedAt: Date },
}, { timestamps: true });

providerProfileSchema.index({ location: '2dsphere' });
providerProfileSchema.index({ 'serviceArea.polygon': '2dsphere' });
providerProfileSchema.index({ currentAvailability: 1, verificationStatus: 1, lastAvailabilityUpdate: -1 });

export default mongoose.models.ProviderProfile || mongoose.model('ProviderProfile', providerProfileSchema);
