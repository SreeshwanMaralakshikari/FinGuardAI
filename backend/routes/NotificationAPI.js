import express from 'express';
import { verifyToken, authorizeRoles } from '../middleware/verifyToken.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import validate from '../middleware/validate.js';
import { notificationsQueryRules } from '../validators/queryValidators.js';
import NotificationModel from '../models/NotificationModel.js';

const router = express.Router();

router.use(verifyToken, authorizeRoles('CUSTOMER', 'ANALYST'));

// ── GET /notification-api/notifications ───────────────────────────────────────
router.get(
  '/notifications',
  notificationsQueryRules, // E-14: ?isRead=banana → 422
  validate,
  asyncHandler(async (req, res) => {
    const { isRead } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 20); // AUD-21

    const filter = { recipientId: req.user._id };
    if (isRead) filter.isRead = isRead === 'true'; // validated: 'true' | 'false' ('' = no filter)

    const [notifications, total] = await Promise.all([
      NotificationModel.find(filter)
        .sort({ createdAt: -1, _id: -1 }) // C-06
        .skip(skip)
        .limit(Number(limit))
        .select('type title message relatedEntityId relatedEntityType isRead createdAt'),
      NotificationModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: notifications,
      pagination: buildPagination(page, limit, total),
    });
  })
);

// ── PATCH /notification-api/notifications/read-all ────────────────────────────
// MUST be declared before /:id routes — static segment takes precedence (D-P4-13)
router.patch(
  '/notifications/read-all',
  asyncHandler(async (req, res) => {
    const result = await NotificationModel.updateMany(
      { recipientId: req.user._id, isRead: false },
      { $set: { isRead: true } }
    );

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read.',
      data: { modifiedCount: result.modifiedCount },
    });
  })
);

// ── GET /notification-api/notifications/unread-count ──────────────────────────
// MUST be declared before /:id routes — static segment takes precedence (D-P4-13)
router.get(
  '/notifications/unread-count',
  asyncHandler(async (req, res) => {
    const unreadCount = await NotificationModel.countDocuments({
      recipientId: req.user._id,
      isRead: false,
    });

    res.status(200).json({ success: true, data: { unreadCount } });
  })
);

// ── PATCH /notification-api/notifications/:id/read ────────────────────────────
router.patch(
  '/notifications/:id/read',
  asyncHandler(async (req, res) => {
    const notification = await NotificationModel.findOne({
      _id: req.params.id,
      recipientId: req.user._id,
    });

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }

    if (notification.isRead) {
      return res.status(200).json({
        success: true,
        message: 'Notification was already marked as read.',
        data: { id: notification._id, isRead: true },
      });
    }

    notification.isRead = true;
    await notification.save();

    res.status(200).json({
      success: true,
      message: 'Notification marked as read.',
      data: { id: notification._id, isRead: true },
    });
  })
);

export default router;
