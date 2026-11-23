import mongoose from 'mongoose';

const resourceSchema = new mongoose.Schema({
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true, index: true },
  resourceType: { type: String, required: true, trim: true, maxlength: 100, index: true },
  name: { type: String, required: true, trim: true, maxlength: 160 },
  quantityAvailable: { type: Number, required: true, min: 0, default: 0 },
  source: { type: String, enum: ['provider_reported'], default: 'provider_reported' },
  independentlyVerified: { type: Boolean, default: false },
  reservedQuantity: { type: Number, min: 0, default: 0 },
  allocatedQuantity: { type: Number, min: 0, default: 0 },
  consumedQuantity: { type: Number, min: 0, default: 0 },
  unit: { type: String, required: true, trim: true, maxlength: 40 },
  condition: { type: String, enum: ['new', 'good', 'fair', 'poor', 'unknown'], default: 'unknown' },
  expirationDate: Date,
  lastUpdated: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

resourceSchema.index({ resourceType: 1, quantityAvailable: 1, lastUpdated: -1 });
resourceSchema.index({ providerId: 1, resourceType: 1, unit: 1 });

// The conditional write is atomic: concurrent reservations cannot drive stock below zero.
resourceSchema.statics.reserveAvailable = function reserveAvailable(id, quantity, options = {}) {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new TypeError('Reservation quantity must be positive.');
  return this.findOneAndUpdate(
    { _id: id, quantityAvailable: { $gte: quantity } },
    { $inc: { quantityAvailable: -quantity, reservedQuantity: quantity }, $set: { lastUpdated: new Date() } },
    { new: true, runValidators: true, session: options.session },
  );
};

resourceSchema.statics.releaseReserved = function releaseReserved(id, quantity, options = {}) {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new TypeError('Release quantity must be positive.');
  return this.findOneAndUpdate(
    { _id: id, reservedQuantity: { $gte: quantity } },
    { $inc: { quantityAvailable: quantity, reservedQuantity: -quantity }, $set: { lastUpdated: new Date() } },
    { new: true, runValidators: true, session: options.session },
  );
};

export default mongoose.models.Resource || mongoose.model('Resource', resourceSchema);
