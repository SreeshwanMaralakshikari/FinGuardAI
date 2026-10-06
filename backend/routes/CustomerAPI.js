import express from 'express';
import { verifyToken, authorizeRoles } from '../middleware/verifyToken.js';
import { transactionLimiter, profileUpdateLimiter } from '../middleware/rateLimiter.js';
import validate from '../middleware/validate.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { parsePagination } from '../utils/pagination.js';
import { submitTransactionRules } from '../validators/transactionValidators.js';
import uploadMiddleware, { requireImageContent } from '../middleware/uploadMiddleware.js';
import { checkFraud } from '../services/fraudDetectionService.js';
import { createWithSequentialId } from '../utils/generateSequentialId.js';
import calcBehaviorProfile from '../utils/calcBehaviorProfile.js';
import updateDeviceReputation from '../utils/updateDeviceReputation.js';
import updateTrustScore from '../utils/updateTrustScore.js';
import createNotification from '../utils/createNotification.js';
import createAuditLog from '../utils/createAuditLog.js';
import { withUserLock } from '../utils/userLock.js';
import { buildDateRange } from '../utils/dateRange.js';
import { formatRupees } from '../utils/normalize.js';
import { uploadProfileImage, destroyImageByUrl } from '../utils/imageUpload.js';
import { getIO } from '../utils/socketManager.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import BehaviorProfileModel from '../models/BehaviorProfileModel.js';
import DeviceReputationModel from '../models/DeviceReputationModel.js';
import SystemConfigModel from '../models/SystemConfigModel.js';
import UserModel from '../models/UserModel.js';

const router = express.Router();

// ── RBAC: all routes under /customer-api require CUSTOMER role ─────────────────
router.use(verifyToken, authorizeRoles('CUSTOMER'));

/**
 * Post-commit helpers must never turn an already-saved transaction into an HTTP
 * 500 (the customer would retry and pay twice): log and carry on (BE-5).
 */
const bestEffort = async (label, fn) => {
  try {
    return await fn();
  } catch (err) {
    console.error(`[CustomerAPI] ${label} failed after the transaction was saved:`, err.message);
    return null;
  }
};

/** Keep only the known location fields (the validator already guarantees they are strings). */
const pickLocation = (location) => {
  const picked = {};
  if (location?.city !== undefined) picked.city = location.city;
  if (location?.country !== undefined) picked.country = location.country;
  return picked;
};

/** One alert type per alert: the rule that fired, COMPOSITE when several different rules did. */
const alertTypeFromSignals = (signals) => (signals.length === 1 ? signals[0] : 'COMPOSITE');

// recommendedAction → transaction status.
//   OTP is only a label: there is NO OTP step. MEDIUM is approved with an alert
//   (notification to the customer) but is NOT learned as normal behaviour (L-01).
const ACTION_TO_STATUS = { APPROVE: 'APPROVED', OTP: 'APPROVED', HOLD: 'HELD', BLOCK: 'BLOCKED' };

// ── POST /customer-api/transactions ───────────────────────────────────────────
router.post(
  '/transactions',
  transactionLimiter,
  submitTransactionRules,
  validate,
  asyncHandler(async (req, res) => {
    const { amount, merchantName, merchantCategory, paymentMethod, deviceId } = req.body;
    const location = pickLocation(req.body.location);
    const userId = req.user._id;

    // L-08 / N-28: one submission at a time PER USER. Velocity, trust score, device
    // reputation and the behaviour profile are all read-then-write; overlapping
    // requests of one user used to read the same snapshot (12 parallel payments → no
    // velocity flag) and could write derived scores out of order.
    const data = await withUserLock(userId, async () => {
      // 1. Load live thresholds — never hardcode (D-P4-08)
      //    AUD-18: .lean() — checkFraud merges thresholds with object spread; a
      //    hydrated Mongoose document spreads as { $__, _doc, … }, so every admin
      //    setting except highRiskMerchants was silently replaced by the defaults.
      const thresholds = await SystemConfigModel.findOne({ singleton: 'system' }).lean();

      // 2. Fetch behavioral context for fraud evaluation.
      //    AUD-03: velocity is counted LIVE at check time. The stored
      //    transactionVelocity is a snapshot from the customer's previous
      //    transaction, so five purchases yesterday still read "5 in the last
      //    hour" today. All outcomes count (a burst of blocked attempts is
      //    velocity too). The current transaction is not saved yet, so the counts
      //    are prior transactions only — consistent with the >= rule (C-P5-01).
      const now = Date.now();
      const [behaviorProfile, deviceReputation, txnsLastHour, txnsLastDay] = await Promise.all([
        BehaviorProfileModel.findOne({ userId }).lean(),
        DeviceReputationModel.findOne({ deviceId }).lean(),
        TransactionModel.countDocuments({ userId, timestamp: { $gte: new Date(now - 60 * 60 * 1000) } }),
        TransactionModel.countDocuments({ userId, timestamp: { $gte: new Date(now - 24 * 60 * 60 * 1000) } }),
      ]);
      const profileForCheck = {
        ...(behaviorProfile ?? {}),
        transactionVelocity: { perHour: txnsLastHour, perDay: txnsLastDay },
      };

      // 3. Build transaction input for the pure fraud service function
      const transactionInput = {
        amount,
        merchantName,
        merchantCategory: merchantCategory ?? 'GENERAL',
        paymentMethod,
        location,
        deviceId,
        userId,
        timestamp: new Date(),
      };

      // 4. Run fraud detection — pure function, no DB side-effects (D-P4-05)
      const { fraudScore, riskLevel, reasons, recommendedAction, estimatedLoss, signals } = checkFraud({
        transaction: transactionInput,
        behaviorProfile: profileForCheck,
        deviceReputation,
        thresholds,
      });

      // 5. Map recommendedAction → transaction status
      const status = ACTION_TO_STATUS[recommendedAction] ?? 'HELD';

      // 6. Persist transaction together with its TXN-YYYY-NNNNN public ID in a
      //    single insert (AUD-05 — replaces create-then-save, D-P4-07 revised)
      const transaction = await createWithSequentialId(TransactionModel, 'publicId', 'TXN', {
        userId,
        amount,
        merchantName,
        merchantCategory: merchantCategory ?? 'GENERAL',
        paymentMethod,
        location,
        deviceId,
        ipAddress: req.ip,
        fraudScore,
        riskLevel,
        reasons,
        recommendedAction,
        estimatedLoss,
        status,
      });

      // 7. Public ID was assigned atomically at insert time (AUD-05)
      const { publicId } = transaction;

      // 8. MEDIUM+ risk: create FraudAlert and Customer notification.
      //    Everything here runs after the transaction was saved, so all of it
      //    (alert, audit entry, notification, socket event) is best-effort (BE-5).
      let fraudAlert = null;
      if (['MEDIUM', 'HIGH', 'CRITICAL'].includes(riskLevel)) {
        // L-15: the type comes from the rules that fired, not from parsing reason text.
        const alertType = alertTypeFromSignals(signals);

        // The transaction is already saved: a failing alert insert must not turn
        // the request into a 500 (the customer would retry and pay twice).
        // Analysts can only open a case from an alert, so one retry is made before giving up
        // (a HIGH / CRITICAL payment without an alert could not be reviewed or released).
        const alertDoc = {
          transactionId: transaction._id,
          userId,
          alertType,
          riskLevel,
          fraudScore,
          reasons,
          status: 'OPEN',
        };
        fraudAlert = await bestEffort('fraud alert creation', () => FraudAlertModel.create(alertDoc))
          ?? await bestEffort('fraud alert creation (retry)', () => FraudAlertModel.create(alertDoc));

        if (fraudAlert) {
          await createAuditLog( // BS-19: alert creation is part of the audit trail
            userId,
            'CUSTOMER',
            'FRAUD_ALERT_CREATED',
            'FraudAlert',
            fraudAlert._id.toString(),
            { transactionId: publicId, alertType, riskLevel, fraudScore },
            req.ip
          );

          await bestEffort('customer notification', () => createNotification({
            recipientId: userId,
            recipientRole: 'CUSTOMER',
            type: 'FRAUD_ALERT',
            title: `${riskLevel} Risk Transaction Detected`,
            message: `Your transaction of ₹${formatRupees(amount)} at ${merchantName} was flagged. Fraud score: ${fraudScore}/100.`,
            relatedEntityId: fraudAlert._id,
            relatedEntityType: 'FRAUD_ALERT',
          }));
        }

        // Push live event to admin WebSocket room (non-fatal — C-P4-03)
        try {
          getIO().emit('fraud_alert', {
            transactionId: transaction._id,
            publicId,
            userId,
            amount,
            merchantName,
            riskLevel,
            fraudScore,
            timestamp: transaction.timestamp,
          });
        } catch (_) { /* socket not yet initialized — non-fatal */ }
      }

      // 9. Update behavioral profile — only APPROVED + LOW-risk transactions teach
      //    the trusted baseline (C-P4-01 revised by AUD-37 and L-01):
      //      • HELD / BLOCKED are suspected fraud;
      //      • MEDIUM is approved (no OTP step exists) but is suspicious by
      //        definition — learning from it let an attacker's new device and
      //        city become "usual" after one attempt.
      //    updateDeviceReputation and updateTrustScore run for all outcomes (AUD-09).
      //    The device lock keeps two customers who share a device from writing a
      //    stale reputation over a fresher one (N-28).
      const shouldUpdateBehaviorProfile = status === 'APPROVED' && riskLevel === 'LOW';
      await Promise.all([
        shouldUpdateBehaviorProfile
          ? bestEffort('behaviour profile update', () => calcBehaviorProfile(userId, transaction))
          : Promise.resolve(),
        bestEffort('device reputation update', () =>
          withUserLock(`device:${deviceId}`, () => updateDeviceReputation(deviceId, userId, transaction))),
        bestEffort('trust score update', () => updateTrustScore(userId)),
      ]);

      // 10. Audit log
      await createAuditLog(
        userId,
        'CUSTOMER',
        'TRANSACTION_SUBMITTED',
        'Transaction',
        publicId,
        { amount, merchantName, paymentMethod, riskLevel, fraudScore, status },
        req.ip
      );

      return {
        id: transaction._id,
        publicId,
        amount,
        merchantName,
        merchantCategory: transaction.merchantCategory,
        paymentMethod,
        fraudScore,
        riskLevel,
        reasons,
        recommendedAction,
        estimatedLoss,
        status,
        fraudAlert: fraudAlert ? { id: fraudAlert._id } : null,
        timestamp: transaction.timestamp,
      };
    });

    res.status(201).json({
      success: true,
      message: 'Transaction submitted successfully.',
      data,
    });
  })
);

// ── GET /customer-api/transactions ────────────────────────────────────────────
router.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    const { riskLevel, paymentMethod } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 10); // AUD-21

    const filter = { userId: req.user._id };
    if (riskLevel) filter.riskLevel = riskLevel;
    if (paymentMethod) filter.paymentMethod = paymentMethod;
    const dateFilter = buildDateRange(req.query); // L-05: 'YYYY-MM-DD' = a whole IST day
    if (dateFilter) filter.timestamp = dateFilter;

    const [transactions, total] = await Promise.all([
      TransactionModel.find(filter)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(Number(limit))
        .select('publicId amount merchantName merchantCategory paymentMethod riskLevel fraudScore recommendedAction status timestamp'),
      TransactionModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: transactions,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  })
);

// ── GET /customer-api/transactions/:id ────────────────────────────────────────
router.get(
  '/transactions/:id',
  asyncHandler(async (req, res) => {
    // Scope to owner — customers cannot view other users' transactions
    const transaction = await TransactionModel.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    const deviceReputation = await DeviceReputationModel.findOne({ deviceId: transaction.deviceId })
      .select('reputationScore flagCount fraudTransactionCount isBlacklisted firstSeenAt lastSeenAt');

    res.status(200).json({
      success: true,
      data: { transaction, deviceReputation: deviceReputation ?? null },
    });
  })
);

// ── GET /customer-api/fraud-alerts ────────────────────────────────────────────
router.get(
  '/fraud-alerts',
  asyncHandler(async (req, res) => {
    const { status, riskLevel } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 10); // AUD-21

    const filter = { userId: req.user._id };
    if (status) filter.status = status;
    if (riskLevel) filter.riskLevel = riskLevel;

    const [alerts, total] = await Promise.all([
      FraudAlertModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate('transactionId', 'publicId amount merchantName paymentMethod timestamp status'),
      FraudAlertModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: alerts,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  })
);

// ── GET /customer-api/fraud-alerts/:id ───────────────────────────────────────
router.get(
  '/fraud-alerts/:id',
  asyncHandler(async (req, res) => {
    const alert = await FraudAlertModel.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).populate('transactionId');

    if (!alert) {
      return res.status(404).json({ success: false, message: 'Fraud alert not found.' });
    }

    res.status(200).json({ success: true, data: alert });
  })
);

// ── GET /customer-api/trust-score ─────────────────────────────────────────────
router.get(
  '/trust-score',
  asyncHandler(async (req, res) => {
    const now = Date.now();
    const [user, profile, perHour, perDay] = await Promise.all([
      UserModel.findById(req.user._id).select('trustScore'),
      BehaviorProfileModel.findOne({ userId: req.user._id })
        .select('avgTransactionAmount maxTransactionAmount transactionVelocity usualLocations usualPaymentMethods lastUpdated')
        .lean(),
      // L-15: velocity is counted live (all outcomes, last 1 h / 24 h) — exactly what the
      // fraud check uses — instead of the snapshot stored at the last approved transaction.
      TransactionModel.countDocuments({ userId: req.user._id, timestamp: { $gte: new Date(now - 60 * 60 * 1000) } }),
      TransactionModel.countDocuments({ userId: req.user._id, timestamp: { $gte: new Date(now - 24 * 60 * 60 * 1000) } }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        trustScore: user.trustScore,
        behaviorSummary: profile ? { ...profile, transactionVelocity: { perHour, perDay } } : null,
      },
    });
  })
);

// ── GET /customer-api/profile ─────────────────────────────────────────────────
router.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const user = await UserModel.findById(req.user._id).select('-password');
    res.status(200).json({ success: true, data: user });
  })
);

// ── PATCH /customer-api/profile ───────────────────────────────────────────────
router.patch(
  '/profile',
  profileUpdateLimiter,
  uploadMiddleware.single('profileImage'),
  requireImageContent, // N-09: magic-byte check — the client-declared MIME type proves nothing
  asyncHandler(async (req, res) => {
    const updates = {};

    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string') { // AUD-25: {name: 123} used to crash with a 500
        return res.status(422).json({ success: false, message: 'Name must be a string.' });
      }
      const name = req.body.name.trim();
      if (name.length < 2 || name.length > 100) {
        return res.status(422).json({ success: false, message: 'Name must be between 2 and 100 characters.' });
      }
      updates.name = name;
    }

    if (req.file) {
      // Upload from multer memory buffer to Cloudinary. Cloudinary errors are plain
      // objects ({ message, http_code }), not HTTP errors: answer 502 and keep the
      // SDK's message out of the response (N-09).
      try {
        const uploadResult = await uploadProfileImage(req.file.buffer);
        updates.profileImage = uploadResult.secure_url;
      } catch (err) {
        console.error('[CustomerAPI] Cloudinary upload failed:', err?.message ?? err);
        return res.status(502).json({ success: false, message: 'Image upload failed. Please try again.' });
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields provided for update.' });
    }

    const previousImage = req.user.profileImage;
    let updatedUser;
    try {
      updatedUser = await UserModel.findByIdAndUpdate(
        req.user._id,
        updates,
        { returnDocument: 'after', runValidators: true }
      ).select('-password');
    } catch (err) {
      // The new image was uploaded but never saved: don't leave it orphaned.
      if (updates.profileImage) await destroyImageByUrl(updates.profileImage);
      throw err;
    }

    // The replaced image is no longer referenced anywhere — delete it (best effort:
    // a Cloudinary hiccup must not fail a profile update that already succeeded).
    if (updates.profileImage && previousImage && previousImage !== updates.profileImage) {
      await destroyImageByUrl(previousImage);
    }

    await createAuditLog(
      req.user._id,
      'CUSTOMER',
      'PROFILE_UPDATED',
      'User',
      req.user._id.toString(),
      { updatedFields: Object.keys(updates) },
      req.ip
    );

    res.status(200).json({ success: true, message: 'Profile updated.', data: updatedUser });
  })
);

export default router;
