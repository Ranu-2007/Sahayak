import AuditLog from '../models/AuditLog.js';
import Notification from '../models/Notification.js';
import { publishUserEvent } from './liveEvents.js';

export async function audit(req, action, targetType, targetId, details = {}) {
  await AuditLog.create({ actorId: req.user?._id, actor: req.user?._id, action, targetType, targetId, relevantChanges: details, details, ip: req.ip });
}

export async function notify(userIds, type, title, message, requestId) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return;
  const notifications = await Notification.insertMany(ids.map(user => ({ user, type, title, message, request: requestId })));
  for (const notification of notifications) publishUserEvent([notification.user], 'notification.created', { notificationId: String(notification._id), type: notification.type, requestId: notification.request ? String(notification.request) : null });
}
