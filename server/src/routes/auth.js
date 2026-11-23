import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import User from '../models/User.js';
import AuthSession from '../models/AuthSession.js';
import { authenticate } from '../middleware/auth.js';
import { audit } from '../services/record.js';
import { disconnectSession, disconnectUser } from '../services/liveEvents.js';

const router = Router();
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { message: 'Too many authentication attempts. Try again later.' } });
const credentials = z.object({ email: z.string().trim().email().max(254), password: z.string().min(10).max(128) });

router.post('/register', authLimit, async (req, res, next) => {
  try {
    const input = credentials.extend({ name: z.string().trim().min(2).max(100), organization: z.string().trim().max(120).optional(), phone: z.string().trim().min(7).max(30).optional(), role: z.enum(['requester', 'provider']).default('requester') }).strict().parse(req.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await User.create({ name: input.name, email: input.email.toLowerCase(), organization: input.organization, phone: input.phone, passwordHash, role: input.role });
    await issueSession(user, res);
    res.status(201).json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

router.post('/login', authLimit, async (req, res, next) => {
  try {
    const input = credentials.strict().parse(req.body);
    const user = await User.findOne({ email: input.email.toLowerCase() }).select('+passwordHash');
    if (!user || !user.active || !(await bcrypt.compare(input.password, user.passwordHash))) return res.status(401).json({ message: 'Email or password is incorrect.' });
    await issueSession(user, res);
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token = req.cookies?.resqlink_session || bearerToken(req);
    if (token) {
      try { const payload = jwt.verify(token, process.env.JWT_SECRET); if (payload.jti) { await AuthSession.deleteOne({ jti: payload.jti }); disconnectSession(payload.jti); } } catch { /* Expired sessions are already unusable. */ }
    }
    res.clearCookie('resqlink_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
    res.status(204).end();
  } catch (error) { next(error); }
});

router.get('/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));
router.patch('/me', authenticate, async (req, res, next) => {
  try {
    const input = z.object({
      name: z.string().trim().min(2).max(100).optional(), organization: z.string().trim().max(120).nullable().optional(), phone: z.string().trim().min(7).max(30).nullable().optional(),
      location: z.object({ state: z.string().trim().max(100).optional(), district: z.string().trim().max(100).optional(), city: z.string().trim().max(100).optional(), address: z.string().trim().max(240).optional() }).strict().optional(),
      emergencyContact: z.object({ name: z.string().trim().max(100).optional(), phone: z.string().trim().max(30).optional(), relationship: z.string().trim().max(60).optional() }).strict().optional(),
      preferences: z.object({ language: z.string().trim().max(40).optional(), notifications: z.object({ email: z.boolean().optional(), sms: z.boolean().optional(), inApp: z.boolean().optional() }).strict().optional(), privacy: z.object({ shareLocation: z.boolean().optional() }).strict().optional() }).strict().optional(),
    }).strict().refine(value => Object.keys(value).length > 0, 'Provide at least one profile field.').parse(req.body);
    if (input.organization === null) input.organization = undefined;
    Object.assign(req.user, input);
    await req.user.save();
    res.json({ user: publicUser(req.user) });
  } catch (error) { next(error); }
});
router.patch('/me/password', authLimit, authenticate, async (req, res, next) => {
  try {
    const input = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(10).max(128) }).strict().parse(req.body);
    const user = await User.findById(req.user.id).select('+passwordHash');
    if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) return res.status(400).json({ message: 'Current password is incorrect.' });
    user.passwordHash = await bcrypt.hash(input.newPassword, 12);
    await user.save();
    await AuthSession.deleteMany({ user: user.id });
    disconnectUser(user.id);
    await audit(req, 'auth.password_changed', 'User', user.id, { otherSessionsRevoked: true });
    await issueSession(user, res);
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

async function issueSession(user, res) {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const token = jwt.sign({ sub: user.id, role: user.role, jti }, process.env.JWT_SECRET, { expiresIn: '8h', issuer: 'resqlink' });
  await AuthSession.create({ jti, user: user.id, expiresAt });
  res.cookie('resqlink_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 8 * 60 * 60 * 1000 });
}
function bearerToken(req) { const header = req.headers.authorization || ''; return header.startsWith('Bearer ') ? header.slice(7) : null; }
function publicUser(user) { return { id: user.id, name: user.name, email: user.email, organization: user.organization, phone: user.phone, location: user.location, emergencyContact: user.emergencyContact, preferences: user.preferences, role: user.role === 'reporter' ? 'requester' : user.role }; }
export default router;
