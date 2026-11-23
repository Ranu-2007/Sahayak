import mongoose from 'mongoose';
const notificationSchema = new mongoose.Schema({ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, type: { type: String, required: true, maxlength: 80 }, title: { type: String, required: true, maxlength: 180 }, message: { type: String, required: true, maxlength: 500 }, request: { type: mongoose.Schema.Types.ObjectId, ref: 'EmergencyRequest' }, readAt: Date }, { timestamps: true });
notificationSchema.index({ user: 1, createdAt: -1 });
export default mongoose.model('Notification', notificationSchema);
