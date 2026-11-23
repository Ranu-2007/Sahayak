import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import AuthSession from '../models/AuthSession.js';
import User from '../models/User.js';
import Provider from '../models/Provider.js';

let io;

function sessionToken(cookieHeader = '') {
  const pair = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith('resqlink_session='));
  if (!pair) return null;
  try { return decodeURIComponent(pair.slice('resqlink_session='.length)); }
  catch { return null; }
}

export function configureLiveSockets(httpServer, allowedOrigins) {
  io = new Server(httpServer, { cors: { origin: allowedOrigins, credentials: true } });
  io.use(async (socket, next) => {
    try {
      const token = sessionToken(socket.request.headers.cookie);
      if (!token || !process.env.JWT_SECRET) return next(new Error('Authentication required.'));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const sessionValid = payload.jti && await AuthSession.exists({ jti: payload.jti, user: payload.sub, expiresAt: { $gt: new Date() } });
      if (!sessionValid) return next(new Error('Session expired.'));
      const user = await User.findById(payload.sub).select('role active');
      if (!user?.active) return next(new Error('Active account required.'));
      if (['coordinator', 'admin'].includes(user.role)) socket.join('resolver-room');
      else if (user.role === 'provider') {
        const verifiedProvider = await Provider.exists({ owner: user._id, verificationStatus: 'verified' });
        if (!verifiedProvider) return next(new Error('Verified responder access required.'));
        socket.join('responder-room');
      } else if (user.role === 'requester') socket.join(`reporter-user:${user._id}`);
      else return next(new Error('Resolver, verified responder, or reporter access required.'));
      socket.data.userId = String(user._id);
      socket.data.sessionId = payload.jti;
      socket.data.sessionExpiresAt = payload.exp;
      socket.join(`resolver-user:${user._id}`);
      socket.join(`resolver-session:${payload.jti}`);
      next();
    } catch { next(new Error('Invalid or expired session.')); }
  });
  io.on('connection', socket => {
    const expiresIn = Math.max(0, (socket.data.sessionExpiresAt || 0) * 1000 - Date.now());
    const expiryTimer = setTimeout(() => socket.disconnect(true), expiresIn || 8 * 60 * 60 * 1000);
    expiryTimer.unref?.();
    socket.on('disconnect', () => clearTimeout(expiryTimer));
  });
  return io;
}

export function publishLiveEvent(eventName, payload) {
  io?.to('resolver-room').to('responder-room').emit(eventName, payload);
}

export function publishUserEvent(userIds, eventName, payload) {
  for (const userId of new Set((userIds || []).filter(Boolean).map(String))) io?.to(`reporter-user:${userId}`).emit(eventName, payload);
}

export function publishPrivateEvent(userIds, eventName, payload) {
  for (const userId of new Set((userIds || []).filter(Boolean).map(String))) {
    io?.to(`reporter-user:${userId}`).to(`resolver-user:${userId}`).emit(eventName, payload);
  }
}

export function disconnectSession(sessionId) {
  if (sessionId) io?.in(`resolver-session:${sessionId}`).disconnectSockets(true);
}

export function disconnectUser(userId) {
  if (userId) io?.in(`resolver-user:${userId}`).disconnectSockets(true);
}

export function closeLiveSockets(callback) {
  const current = io;
  io = undefined;
  if (current) current.close(callback);
  else callback?.();
}
