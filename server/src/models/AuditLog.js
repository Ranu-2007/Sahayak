import mongoose from 'mongoose';
const auditLogSchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true, maxlength: 100 },
  targetType: { type: String, required: true, maxlength: 80 },
  targetId: { type: mongoose.Schema.Types.ObjectId },
  timestamp: { type: Date, default: Date.now, index: true },
  relevantChanges: { type: mongoose.Schema.Types.Mixed, default: {} },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  ip: { type: String, maxlength: 80 },
}, { timestamps: true });
auditLogSchema.pre('validate', function synchronizeAuditFields() {
  this.actorId ??= this.actor;
  this.actor ??= this.actorId;
  if (this.isModified('details')) this.relevantChanges = this.details;
  else if (this.isModified('relevantChanges')) this.details = this.relevantChanges;
});
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, timestamp: -1 });
export default mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);
