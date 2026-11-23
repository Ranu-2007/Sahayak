import mongoose from 'mongoose';
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['coordinator', 'provider', 'requester', 'reporter', 'admin'], default: 'requester' },
  accountStatus: { type: String, enum: ['active', 'suspended', 'disabled'], default: 'active', index: true },
  organization: { type: String, trim: true, maxlength: 120 },
  phone: { type: String, trim: true, maxlength: 30 },
  location: { state: { type: String, trim: true, maxlength: 100 }, district: { type: String, trim: true, maxlength: 100 }, city: { type: String, trim: true, maxlength: 100 }, address: { type: String, trim: true, maxlength: 240 } },
  emergencyContact: { name: { type: String, trim: true, maxlength: 100 }, phone: { type: String, trim: true, maxlength: 30 }, relationship: { type: String, trim: true, maxlength: 60 } },
  preferences: { language: { type: String, trim: true, maxlength: 40, default: 'English' }, notifications: { email: { type: Boolean, default: true }, sms: { type: Boolean, default: true }, inApp: { type: Boolean, default: true } }, privacy: { shareLocation: { type: Boolean, default: false } } },
  active: { type: Boolean, default: true },
}, { timestamps: true });
userSchema.pre('validate', function syncAccountStatus() {
  if (this.isModified('active')) this.accountStatus = this.active ? 'active' : 'disabled';
  else if (this.isModified('accountStatus')) this.active = this.accountStatus === 'active';
});
export default mongoose.model('User', userSchema);
