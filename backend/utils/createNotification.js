/**
 * createNotification.js
 *
 * Persists an in-app notification document and pushes a live socket event to
 * the recipient.
 *
 * Purpose:
 *   Creates a NotificationModel document in MongoDB, then attempts to emit the
 *   "new-notification" event to the recipient's Socket.io room so their
 *   notification bell updates in real time.  The socket emit is wrapped in
 *   try/catch — a failure (e.g. Socket.io not yet initialized, or recipient
 *   not connected) is non-fatal and never throws.
 *
 * Exported function:
 *   createNotification(options) → Promise<NotificationDocument>
 *
 * @param {Object}          options
 * @param {ObjectId|string} options.recipientId       User ID of the recipient (CUSTOMER or ANALYST)
 * @param {string}          options.recipientRole     'CUSTOMER' | 'ANALYST'
 * @param {string}          options.type              'FRAUD_ALERT' | 'CASE_ASSIGNED' | 'CASE_STATUS_CHANGED'
 * @param {string}          options.title             Short notification title (≤200 chars)
 * @param {string}          options.message           Notification body text (≤1000 chars)
 * @param {ObjectId|string} options.relatedEntityId   Polymorphic entity ObjectId
 * @param {string}          options.relatedEntityType 'TRANSACTION' | 'FRAUD_ALERT' | 'FRAUD_CASE'
 * @returns {Promise<import('mongoose').Document>}    The saved NotificationModel document
 */

import NotificationModel from '../models/NotificationModel.js';
import { getIO } from './socketManager.js';

const createNotification = async ({
  recipientId,
  recipientRole,
  type,
  title,
  message,
  relatedEntityId,
  relatedEntityType,
}) => {
  // 1. Persist the notification document — this is always required
  const notification = await NotificationModel.create({
    recipientId,
    recipientRole,
    type,
    title,
    message,
    relatedEntityId,
    relatedEntityType,
    isRead: false,
  });

  // 2. Emit live event to the recipient's socket room.
  //    Each connected user joins a room named after their own user ID string
  //    (set up in server.js on socket connection).
  //    Non-fatal: socket may not be initialized yet or recipient may be offline.
  try {
    getIO()
      .to(recipientId.toString())
      .emit('new-notification', {
        _id: notification._id, // AUD-08: same key as REST list items (markNotificationReadThunk matches on _id)
        id: notification._id,  // kept for backward compatibility
        type: notification.type,
        title: notification.title,
        message: notification.message,
        relatedEntityId: notification.relatedEntityId,
        relatedEntityType: notification.relatedEntityType,
        isRead: false,
        createdAt: notification.createdAt,
      });
  } catch (_) {
    // Socket.io not yet initialized, or recipient not in any room — non-fatal.
    // The notification is already persisted; the client fetches it on next poll.
  }

  return notification;
};

export default createNotification;
