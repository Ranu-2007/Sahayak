import mongoose from 'mongoose';
const feedbackSchema = new mongoose.Schema({
  requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmergencyRequest' },
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' },
  requesterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider' },
  verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
  comments: { type: String, trim: true, maxlength: 1000 },
  // Legacy names remain available while existing API routes are migrated.
  request: { type: mongoose.Schema.Types.ObjectId, ref: 'EmergencyRequest' },
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider' },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rating: { type: Number, min: 1, max: 5, required: true },
  comment: { type: String, trim: true, maxlength: 1000 },
  verifiedFulfillment: { type: Boolean, default: false },
}, { timestamps: true });
feedbackSchema.pre('validate', function synchronizeFeedbackFields() {
  this.requestId ??= this.request;
  this.request ??= this.requestId;
  this.providerId ??= this.provider;
  this.provider ??= this.providerId;
  this.requesterId ??= this.author;
  this.author ??= this.requesterId;
  this.comments ??= this.comment;
  this.comment ??= this.comments;
  if (this.verifiedFulfillment && this.verificationStatus === 'pending') this.verificationStatus = 'verified';
  if (this.verificationStatus === 'verified') this.verifiedFulfillment = true;
});
feedbackSchema.index({ request: 1, author: 1 }, { unique: true });
feedbackSchema.index({ requestId: 1, requesterId: 1 }, { unique: true, sparse: true });
feedbackSchema.index({ providerId: 1, verificationStatus: 1, createdAt: -1 });
export default mongoose.models.Feedback || mongoose.model('Feedback', feedbackSchema);
