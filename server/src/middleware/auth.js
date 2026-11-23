import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import AuthSession from '../models/AuthSession.js';

export async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = req.cookies?.resqlink_session || (header.startsWith('Bearer ') ? header.slice(7) : null);
  if (!token) return res.status(401).json({ message: 'Authentication required.' });
  if (!process.env.JWT_SECRET) return next(new Error('JWT_SECRET is not configured.'));

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }

  try {
    if (!payload.jti || !(await AuthSession.exists({ jti: payload.jti, user: payload.sub, expiresAt: { $gt: new Date() } }))) return res.status(401).json({ message: 'Session expired. Please sign in again.' });
    const user = await User.findById(payload.sub).select('-passwordHash');
    if (!user || !user.active) return res.status(401).json({ message: 'Account unavailable.' });
    req.user = user;
    req.authTokenPayload = payload;
    return next();
  } catch (error) {
    return next(error);
  }
}

export const allowRoles = (...roles) => (req, res, next) => {
  const role = req.user?.role === 'reporter' ? 'requester' : req.user?.role;
  if (!role || !roles.includes(role)) return res.status(403).json({ message: 'You do not have permission to do that.' });
  next();
};
