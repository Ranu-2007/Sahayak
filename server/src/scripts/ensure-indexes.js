import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ensureDatabaseIndexes } from '../services/database.js';

dotenv.config({ path: new URL('../../.env', import.meta.url) });

if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be configured.');

try {
  await mongoose.connect(process.env.MONGODB_URI);
  await ensureDatabaseIndexes();
  console.info('Required database indexes verified.');
} catch (error) {
  console.error('Could not verify required database indexes:', error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
