import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';

const [email, role] = process.argv.slice(2);
if (!email || !['coordinator', 'admin', 'requester', 'provider'].includes(role)) {
  console.error('Usage: npm run promote-user -w server -- <email> <requester|provider|coordinator|admin>');
  process.exit(2);
}
if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI must be configured in server/.env.');
  process.exit(2);
}
try {
  await mongoose.connect(process.env.MONGODB_URI);
  const user = await User.findOneAndUpdate({ email: email.toLowerCase() }, { role }, { new: true, runValidators: true }).select('name email role');
  if (!user) throw new Error(`No account found for ${email}. Register that account first.`);
  console.info(`Updated ${user.email} to role ${user.role}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
