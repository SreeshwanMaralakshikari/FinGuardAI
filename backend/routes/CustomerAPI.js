import express from 'express';
import { verifyToken, authorizeRoles } from '../middleware/verifyToken.js';
import { transactionLimiter, profileUpdateLimiter } from '../middleware/rateLimiter.js';
import validate from '../middleware/validate.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import { submitTransactionRules, customerResponseRules } from '../validators/transactionValidators.js';
import { customerAlertsQueryRules, customerTransactionsQueryRules, customerTimelineQueryRules } from '../validators/queryValidators.js';
import uploadMiddleware, { requireImageContent } from '../middleware/uploadMiddleware.js';
import createAuditLog from '../utils/createAuditLog.js';
import { processTransaction, buildTransactionResponse } from '../services/transactionService.js';
import { getMlClient } from '../services/scoringService.js';
import { recordCustomerResponse, CustomerResponseError } from '../services/customerResponseService.js';
import { buildDateRange } from '../utils/dateRange.js';
import { OUTCOME_TITLES } from '../utils/caseWorkflow.js';
import { formatRupees } from '../utils/normalize.js';
import { uploadProfileImage, destroyImageByUrl } from '../utils/imageUpload.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import BehaviorProfileModel from '../models/BehaviorProfileModel.js';
import NotificationModel from '../models/NotificationModel.js';
import DeviceReputationModel from '../models/DeviceReputationModel.js';
import UserModel from '../models/UserModel.js';

const router = express.Router();

// ── RBAC: all routes under /customer-api require CUSTOMER role ─────────────────
router.use(verifyToken, authorizeRoles('CUSTOMER'));

// ── POST /customer-api/transactions ───────────────────────────────────────────
// A-09: thin handler — validation here, the orchestration in services/transactionService.js.
// C-01: an optional `Idempotency-Key` header makes a retry safe: the original result comes back
// as 200 with `replayed: true` (first-time creation stays 201).
router.post(
  '/transactions',
  transactionLimiter,
  submitTransactionRules,
  validate,
  asyncHandler(async (req, res) => {
    const { transaction, alert, replayed } = await processTransaction({
      user: req.user,
      payload: { ...req.body, idempotencyKey: req.get('Idempotency-Key') || undefined },
      context: { ip: req.ip },
    });

    res.status(replayed ? 200 : 201).json({
      success: true,
      message: 'Transaction submitted successfully.',
      data: buildTransactionResponse(transaction, alert),
      ...(replayed ? { replayed: true } : {}),
    });
  })
);

// ── POST /customer-api/ml-warm-up ──────────────────────────────────────────────
// D-2: the "Submit transaction" page calls this when it opens. The ML service sleeps after 15 minutes without
// payments (Render free tier); this starts its background wake-up while the customer fills in the form, so the
// payment is usually scored by the model instead of falling back to the rules. Answers at once and never waits
// for the ML service; nothing happens when ML is off or the service answered in the last 10 minutes.
router.post('/ml-warm-up', (req, res) => {
  const client = getMlClient();
  const warming = client ? client.wakeUpIfIdle() : false;
  res.status(202).json({ success: true, data: { mlEnabled: Boolean(client), warming } });
});

// ── GET /customer-api/transactions ────────────────────────────────────────────
router.get(
  '/transactions',
  customerTransactionsQueryRules, // E-14
  validate,
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
        .sort({ timestamp: -1, _id: -1 }) // C-06: stable paging when timestamps tie
        .skip(skip)
        .limit(Number(limit))
        .select('publicId amount merchantName merchantCategory paymentMethod riskLevel fraudScore recommendedAction status timestamp scoreBreakdown'),
      TransactionModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: transactions,
      pagination: buildPagination(page, limit, total),
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

// ── POST /customer-api/transactions/:id/response ──────────────────────────────
// R4 "Was this you?": the customer confirms or disputes one of their HELD / BLOCKED payments while its alert is
// still open. Evidence for the analyst only: the payment's status does not change (services/customerResponseService.js).
router.post(
  '/transactions/:id/response',
  customerResponseRules,
  validate,
  asyncHandler(async (req, res) => {
    try {
      const transaction = await recordCustomerResponse({
        user: req.user, transactionId: req.params.id, answer: req.body.answer, note: req.body.note ?? '', ip: req.ip,
      });
      res.status(200).json({
        success: true,
        message: req.body.answer === 'DISPUTED'
          ? 'Thank you. The fraud team has been told you did not make this payment.'
          : 'Thank you. The fraud team has been told you made this payment.',
        data: { id: transaction._id, publicId: transaction.publicId, status: transaction.status, customerResponse: transaction.customerResponse },
      });
    } catch (err) {
      if (err instanceof CustomerResponseError) return res.status(err.status).json({ success: false, message: err.message });
      throw err;
    }
  })
);

// ── GET /customer-api/fraud-alerts ────────────────────────────────────────────
router.get(
  '/fraud-alerts',
  customerAlertsQueryRules, // E-14
  validate,
  asyncHandler(async (req, res) => {
    const { status, riskLevel } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 10); // AUD-21

    const filter = { userId: req.user._id };
    if (status) filter.status = status;
    if (riskLevel) filter.riskLevel = riskLevel;

    const [alerts, total] = await Promise.all([
      FraudAlertModel.find(filter)
        .sort({ createdAt: -1, _id: -1 }) // C-06
        .skip(skip)
        .limit(Number(limit))
        .populate('transactionId', 'publicId amount merchantName paymentMethod timestamp status'),
      FraudAlertModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: alerts,
      pagination: buildPagination(page, limit, total),
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

// ── PATCH /customer-api/fraud-alerts/:id/acknowledge ──────────────────────────
// F-02: "yes, that was me". Only the customer's OWN MEDIUM alert that is still OPEN (HIGH / CRITICAL belong to the
// fraud team). ACKNOWLEDGED is not "open", so it drops out of every needs-attention count.
router.patch(
  '/fraud-alerts/:id/acknowledge',
  asyncHandler(async (req, res) => {
    const alert = await FraudAlertModel.findOne({ _id: req.params.id, userId: req.user._id });
    if (!alert) {
      return res.status(404).json({ success: false, message: 'Fraud alert not found.' });
    }
    if (alert.riskLevel !== 'MEDIUM') {
      return res.status(400).json({
        success: false,
        message: 'Only MEDIUM risk alerts can be acknowledged. HIGH and CRITICAL alerts are reviewed by our fraud team.',
      });
    }
    if (alert.status !== 'OPEN') {
      return res.status(400).json({
        success: false,
        message: `This alert is already ${alert.status.toLowerCase()}; only open alerts can be acknowledged.`,
      });
    }

    // Conditional write: two simultaneous taps acknowledge once, the loser gets the 400 above.
    const updated = await FraudAlertModel.findOneAndUpdate(
      { _id: alert._id, userId: req.user._id, riskLevel: 'MEDIUM', status: 'OPEN' },
      { $set: { status: 'ACKNOWLEDGED' } },
      { returnDocument: 'after' }
    );
    if (!updated) {
      return res.status(400).json({ success: false, message: 'This alert is no longer open.' });
    }

    const populated = await FraudAlertModel.findById(updated._id).populate('transactionId');
    await createAuditLog(
      req.user._id,
      'CUSTOMER',
      'ALERT_ACKNOWLEDGED',
      'FraudAlert',
      updated._id.toString(),
      { transactionId: populated?.transactionId?.publicId ?? null, riskLevel: updated.riskLevel, previousStatus: 'OPEN' },
      req.ip
    );

    res.status(200).json({ success: true, message: 'Alert acknowledged.', data: populated ?? updated });
  })
);

// ── GET /customer-api/timeline ────────────────────────────────────────────────
// A-02: one newest-first activity feed built from the customer's own transactions, fraud alerts and
// case-outcome notices. Each source is cut to `limit` before merging (so a feed never reads more than
// 3 × limit rows), then the merge is cut to `limit`. Only customer-visible fields are used: no case notes,
// no analyst names or ids.
const TIMELINE_DEFAULT_LIMIT = 50;
const OUTCOME_TITLE_LIST = Object.values(OUTCOME_TITLES);
const OUTCOME_STATUS_BY_TITLE = Object.fromEntries(Object.entries(OUTCOME_TITLES).map(([status, title]) => [title, status]));
const STATUS_WORDS = { APPROVED: 'approved', HELD: 'held for review', BLOCKED: 'blocked' };

router.get(
  '/timeline',
  customerTimelineQueryRules,
  validate,
  asyncHandler(async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : TIMELINE_DEFAULT_LIMIT;
    const userId = req.user._id;

    const [transactions, alerts, outcomes] = await Promise.all([
      TransactionModel.find({ userId })
        .sort({ timestamp: -1, _id: -1 })
        .limit(limit)
        .select('publicId amount merchantName paymentMethod riskLevel status timestamp')
        .lean(),
      FraudAlertModel.find({ userId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .select('transactionId riskLevel status reasons createdAt')
        .populate('transactionId', 'publicId amount merchantName')
        .lean(),
      NotificationModel.find({ recipientId: userId, recipientRole: 'CUSTOMER', type: 'FRAUD_ALERT', title: { $in: OUTCOME_TITLE_LIST } })
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit)
        .select('title message relatedEntityId createdAt')
        .lean(),
    ]);

    // outcome notices point at the alert; one lookup gives their transaction (own alerts only)
    const outcomeAlerts = outcomes.length > 0
      ? await FraudAlertModel.find({ _id: { $in: outcomes.map((n) => n.relatedEntityId) }, userId })
        .select('transactionId riskLevel')
        .populate('transactionId', 'publicId amount')
        .lean()
      : [];
    const alertById = new Map(outcomeAlerts.map((a) => [String(a._id), a]));

    const events = [
      ...transactions.map((t) => ({
        id: `txn-${t._id}`,
        type: 'TRANSACTION',
        timestamp: t.timestamp,
        title: `Payment to ${t.merchantName}`,
        description: `₹${formatRupees(t.amount)} by ${t.paymentMethod.replace('_', ' ')} - ${STATUS_WORDS[t.status] ?? t.status.toLowerCase()}.`,
        riskLevel: t.riskLevel ?? null,
        status: t.status ?? null,
        amount: t.amount,
        transactionId: t.publicId ?? null,
      })),
      ...alerts.map((a) => ({
        id: `alert-${a._id}`,
        type: 'ALERT',
        timestamp: a.createdAt,
        title: `${a.riskLevel} risk alert`,
        description: a.reasons?.[0] ?? 'This payment was flagged for review.',
        riskLevel: a.riskLevel,
        status: a.status,
        amount: a.transactionId?.amount ?? null,
        transactionId: a.transactionId?.publicId ?? null,
      })),
      ...outcomes.map((n) => {
        const alert = alertById.get(String(n.relatedEntityId));
        return {
          id: `outcome-${n._id}`,
          type: 'CASE_OUTCOME',
          timestamp: n.createdAt,
          title: n.title,
          description: n.message,
          riskLevel: alert?.riskLevel ?? null,
          status: OUTCOME_STATUS_BY_TITLE[n.title] ?? null, // DISMISSED = cleared, RESOLVED = fraud confirmed
          amount: alert?.transactionId?.amount ?? null,
          transactionId: alert?.transactionId?.publicId ?? null,
        };
      }),
    ]
      .map((event) => ({ ...event, timestamp: new Date(event.timestamp) }))
      .sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map((event) => ({ ...event, timestamp: event.timestamp.toISOString() }));

    res.status(200).json({ success: true, data: events });
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
