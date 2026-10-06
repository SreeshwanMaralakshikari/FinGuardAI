import express from 'express';
import { body } from 'express-validator';
import { verifyToken, authorizeRoles } from '../middleware/verifyToken.js';
import validate from '../middleware/validate.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { parsePagination } from '../utils/pagination.js';
import createAuditLog from '../utils/createAuditLog.js';
import { getIO, disconnectUser } from '../utils/socketManager.js';
import { buildDateRange } from '../utils/dateRange.js';
import { normalizeCategory } from '../utils/normalize.js';
import UserModel from '../models/UserModel.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import SystemConfigModel from '../models/SystemConfigModel.js';
import { APP_TIME_ZONE, getZonedParts, zonedTimeToUtc } from '../config/timeZone.js';

const router = express.Router();

/** AUD-22: treat the admin search box as literal text, not a regular expression. */
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── RBAC: all routes under /admin-api require ADMIN role ──────────────────────
router.use(verifyToken, authorizeRoles('ADMIN'));

// ── GET /admin-api/users ───────────────────────────────────────────────────────
router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { role, isActive, search } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 50); // AUD-21

    const filter = {};
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (search) {
      filter.$or = [
        { name: { $regex: escapeRegex(search), $options: 'i' } },  // AUD-22: "(" used to cause a 500
        { email: { $regex: escapeRegex(search), $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      UserModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .select('-password'),
      UserModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: users,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  })
);

// ── PATCH /admin-api/users/:id/status ─────────────────────────────────────────
router.patch(
  '/users/:id/status',
  // AUD-20: .toBoolean(true) — the string "false" passed isBoolean() but was truthy in
  // the handler, so the response said "activated" and the audit log recorded USER_ACTIVATED.
  [body('isActive').isBoolean().withMessage('isActive must be a boolean value (true or false)').toBoolean(true)],
  validate,
  asyncHandler(async (req, res) => {
    const { isActive } = req.body;

    const user = await UserModel.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (user.role === 'ADMIN') {
      return res.status(403).json({ success: false, message: 'ADMIN accounts cannot be activated or deactivated via the API.' });
    }

    const previousStatus = user.isActive;
    user.isActive = isActive;
    await user.save();

    // L-06: a deactivated account must lose its live WebSocket too, not only
    // REST access (the socket handshake is the only place the JWT is checked).
    if (!isActive) await disconnectUser(user._id);

    await createAuditLog(
      req.user._id,
      'ADMIN',
      isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      'User',
      user._id.toString(),
      { targetEmail: user.email, targetRole: user.role, previousStatus, newStatus: isActive },
      req.ip
    );

    res.status(200).json({
      success: true,
      message: `User account ${isActive ? 'activated' : 'deactivated'}.`,
      data: { id: user._id, email: user.email, isActive: user.isActive },
    });
  })
);

// ── GET /admin-api/analytics ───────────────────────────────────────────────────
router.get(
  '/analytics',
  asyncHandler(async (req, res) => {
    // L-05: 'YYYY-MM-DD' = a whole Asia/Kolkata day; invalid → 400
    const dateFilter = buildDateRange(req.query);
    const timestampMatch = dateFilter ? { timestamp: dateFilter } : {};

    const highRiskMatch = { ...timestampMatch, riskLevel: { $in: ['HIGH', 'CRITICAL'] } };

    const [
      totalTransactions,
      riskDistribution,
      fraudByHour,
      fraudByPaymentMethod,
      fraudByLocation,
      lossPreventedAgg,
      openCasesCount,
      openAlertsCount,
    ] = await Promise.all([
      TransactionModel.countDocuments(timestampMatch),
      TransactionModel.aggregate([
        { $match: timestampMatch },
        { $group: { _id: '$riskLevel', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      TransactionModel.aggregate([
        { $match: highRiskMatch },
        { $group: { _id: { $hour: { date: '$timestamp', timezone: APP_TIME_ZONE } }, count: { $sum: 1 } } }, // AUD-06: IST hours
        { $sort: { _id: 1 } },
        { $project: { _id: 0, hour: '$_id', count: 1 } },
      ]),
      TransactionModel.aggregate([
        { $match: highRiskMatch },
        { $group: { _id: '$paymentMethod', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $project: { _id: 0, paymentMethod: '$_id', count: 1 } },
      ]),
      TransactionModel.aggregate([
        { $match: highRiskMatch },
        { $group: { _id: '$location.city', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
        { $project: { _id: 0, city: '$_id', count: 1 } },
      ]),
      TransactionModel.aggregate([
        { $match: { ...timestampMatch, status: { $in: ['HELD', 'BLOCKED'] } } },
        { $group: { _id: null, total: { $sum: '$estimatedLoss' } } },
      ]),
      FraudCaseModel.countDocuments({ status: { $in: ['OPEN', 'ASSIGNED', 'UNDER_REVIEW'] } }),
      // AUD-38: only alerts that need an analyst. MEDIUM alerts are customer
      // notifications for a purchase that was approved without an OTP step; they
      // never enter the analyst queue (HIGH/CRITICAL only), so counting them made
      // this number only grow.
      FraudAlertModel.countDocuments({ status: 'OPEN', riskLevel: { $in: ['HIGH', 'CRITICAL'] } }),
    ]);

    const highCriticalCount = riskDistribution
      .filter((r) => ['HIGH', 'CRITICAL'].includes(r._id))
      .reduce((sum, r) => sum + r.count, 0);

    const fraudRate = totalTransactions > 0
      ? parseFloat(((highCriticalCount / totalTransactions) * 100).toFixed(2))
      : 0;

    res.status(200).json({
      success: true,
      data: {
        totalTransactions,
        fraudRate,
        riskDistribution,
        fraudByHour,
        fraudByPaymentMethod,
        fraudByLocation,
        lossPrevented: lossPreventedAgg[0]?.total ?? 0,
        openCases: openCasesCount,
        openAlerts: openAlertsCount,
      },
    });
  })
);

// ── GET /admin-api/analytics/trends ───────────────────────────────────────────
router.get(
  '/analytics/trends',
  asyncHandler(async (req, res) => {
    // N-14 / AA-9: the window is whole IST days — it starts at 00:00 IST, 30
    // days before today (31 day buckets incl. today). It used to start at
    // "now − 30 d" as an instant, so the first bucket was only partly covered
    // and fed the moving average.
    const today = getZonedParts(new Date());
    const windowStart = zonedTimeToUtc(today.year, today.month, today.day - 30);

    const dailyFraud = await TransactionModel.aggregate([
      {
        $match: {
          timestamp: { $gte: windowStart },
          riskLevel: { $in: ['HIGH', 'CRITICAL'] },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: APP_TIME_ZONE },
          },
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' },
          avgFraudScore: { $avg: '$fraudScore' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // AUD-26: days without HIGH/CRITICAL transactions are missing from the
    // aggregation. Fill every IST calendar day of the window with zeros, so the
    // chart has no gaps and the 7-day moving average covers 7 DAYS, not 7 rows.
    const byDay = new Map(dailyFraud.map((d) => [d._id, d]));
    // Calendar arithmetic on the IST date (not "+ 24 h"), YYYY-MM-DD like $dateToString above.
    const windowDays = Array.from({ length: 31 }, (_, i) =>
      new Date(Date.UTC(today.year, today.month - 1, today.day - 30 + i)).toISOString().slice(0, 10)
    );
    const dailySeries = windowDays.map(
      (date) => byDay.get(date) ?? { _id: date, count: 0, totalAmount: 0, avgFraudScore: 0 }
    );

    const trendData = dailySeries.map((day, index, arr) => {
      const window = arr.slice(Math.max(0, index - 6), index + 1);
      const movingAvg = window.reduce((sum, d) => sum + d.count, 0) / window.length;
      return {
        date: day._id,
        count: day.count,
        totalAmount: day.totalAmount,
        avgFraudScore: parseFloat(day.avgFraudScore.toFixed(1)),
        movingAvg: parseFloat(movingAvg.toFixed(2)),
      };
    });

    const peakFraudHours = await TransactionModel.aggregate([
      // N-14: same window as the daily chart (it used to be all-time)
      { $match: { timestamp: { $gte: windowStart }, riskLevel: { $in: ['HIGH', 'CRITICAL'] } } },
      { $group: { _id: { $hour: { date: '$timestamp', timezone: APP_TIME_ZONE } }, count: { $sum: 1 } } }, // AUD-06: IST hours
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $project: { _id: 0, hour: '$_id', count: 1 } },
    ]);

    res.status(200).json({
      success: true,
      data: { dailyTrend: trendData, peakFraudHours },
    });
  })
);

// ── POST /admin-api/simulation/start ──────────────────────────────────────────
router.post(
  '/simulation/start',
  [
    body('transactionCount')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('transactionCount must be an integer between 1 and 100'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const transactionCount = Number(req.body.transactionCount ?? 10);

    try {
      getIO().emit('simulation_start', {
        initiatedBy: req.user._id,
        transactionCount,
        timestamp: new Date(),
      });
    } catch (_) { /* socket not yet initialized — non-fatal */ }

    await createAuditLog(
      req.user._id,
      'ADMIN',
      'SIMULATION_STARTED',
      'SystemConfig',
      'simulation',
      { transactionCount },
      req.ip
    );

    res.status(200).json({
      success: true,
      message: 'Fraud simulation started.',
      data: { transactionCount },
    });
  })
);

// ── POST /admin-api/simulation/stop ───────────────────────────────────────────
router.post(
  '/simulation/stop',
  asyncHandler(async (req, res) => {
    try {
      getIO().emit('simulation_stop', {
        stoppedBy: req.user._id,
        timestamp: new Date(),
      });
    } catch (_) { /* socket not yet initialized — non-fatal */ }

    await createAuditLog(
      req.user._id,
      'ADMIN',
      'SIMULATION_STOPPED',
      'SystemConfig',
      'simulation',
      {},
      req.ip
    );

    res.status(200).json({ success: true, message: 'Fraud simulation stopped.' });
  })
);

// ── GET /admin-api/thresholds ──────────────────────────────────────────────────
router.get(
  '/thresholds',
  asyncHandler(async (req, res) => {
    const config = await SystemConfigModel.findOne({ singleton: 'system' });
    if (!config) {
      return res.status(404).json({ success: false, message: 'System configuration has not been seeded.' });
    }
    res.status(200).json({ success: true, data: config });
  })
);

// ── Threshold validation rules ─────────────────────────────────────────────────
// L-14: strict types and ranges. Nested groups must be real objects (null / arrays
// used to crash the handler → 500), counters are integers, and every number is
// finite and bounded ("1e400" became Infinity and silently disabled the rule).
const isNumberOrString = (value) => typeof value === 'number' || typeof value === 'string';
const MAX_HIGH_RISK_MERCHANTS = 50;

const thresholdRules = [
  body('amountThreshold')
    .optional()
    .custom(isNumberOrString).withMessage('amountThreshold must be a number').bail()
    .isFloat({ min: 0, max: 1_000_000_000 }).withMessage('amountThreshold must be between 0 and 1,000,000,000').toFloat(), // AUD-19: numbers, not strings
  body('velocityLimit')
    .optional()
    .isObject().withMessage('velocityLimit must be an object with maxPerHour and/or maxPerDay'),
  body('velocityLimit.maxPerHour')
    .optional()
    .custom(isNumberOrString).withMessage('velocityLimit.maxPerHour must be a whole number ≥ 1').bail()
    .isInt({ min: 1, max: 100_000 }).withMessage('velocityLimit.maxPerHour must be a whole number between 1 and 100000').toInt(),
  body('velocityLimit.maxPerDay')
    .optional()
    .custom(isNumberOrString).withMessage('velocityLimit.maxPerDay must be a whole number ≥ 1').bail()
    .isInt({ min: 1, max: 100_000 }).withMessage('velocityLimit.maxPerDay must be a whole number between 1 and 100000').toInt(),
  body('locationDeviationKm')
    .optional()
    .custom(isNumberOrString).withMessage('locationDeviationKm must be a number').bail()
    .isFloat({ min: 0, max: 1_000_000 }).withMessage('locationDeviationKm must be between 0 and 1,000,000').toFloat(),
  body('newDeviceWeight')
    .optional()
    .custom(isNumberOrString).withMessage('newDeviceWeight must be a whole number between 0 and 100').bail()
    .isInt({ min: 0, max: 100 }).withMessage('newDeviceWeight must be a whole number between 0 and 100').toInt(),
  body('highRiskMerchants')
    .optional()
    .isArray({ max: MAX_HIGH_RISK_MERCHANTS })
    .withMessage(`highRiskMerchants must be an array of at most ${MAX_HIGH_RISK_MERCHANTS} strings`),
  body('highRiskMerchants.*')
    .optional()
    .isString().withMessage('Each highRiskMerchants entry must be a non-empty string').bail()
    // AUD-19 / L-15: the same normalisation the fraud rule applies to the transaction's
    // category (upper-case, only A–Z 0–9 _ kept), so stored entries always match.
    .customSanitizer(normalizeCategory)
    .notEmpty().withMessage('Each highRiskMerchants entry must be a non-empty string')
    .isLength({ max: 50 }).withMessage('Each highRiskMerchants entry cannot exceed 50 characters'),
  body('scoreThresholds')
    .optional()
    .isObject().withMessage('scoreThresholds must be an object with mediumMin, highMin and/or criticalMin'),
  body('scoreThresholds.mediumMin')
    .optional()
    .custom(isNumberOrString).withMessage('scoreThresholds.mediumMin must be between 1 and 98').bail()
    .isInt({ min: 1, max: 98 }).withMessage('scoreThresholds.mediumMin must be between 1 and 98').toInt(),
  body('scoreThresholds.highMin')
    .optional()
    .custom(isNumberOrString).withMessage('scoreThresholds.highMin must be between 2 and 99').bail()
    .isInt({ min: 2, max: 99 }).withMessage('scoreThresholds.highMin must be between 2 and 99').toInt(),
  body('scoreThresholds.criticalMin')
    .optional()
    .custom(isNumberOrString).withMessage('scoreThresholds.criticalMin must be between 3 and 100').bail()
    .isInt({ min: 3, max: 100 }).withMessage('scoreThresholds.criticalMin must be between 3 and 100').toInt(),
  // AUD-19: the .toInt() / .toFloat() sanitizers above run before the ordering checks below.
  // Without them, form values arrive as strings and compare alphabetically:
  // "30" < "4" is true, so mediumMin 30 / highMin 4 was accepted and stored.
  body('scoreThresholds')
    .optional()
    .custom((val) => {
      if (val && val.mediumMin !== undefined && val.highMin !== undefined && val.criticalMin !== undefined) {
        if (!(val.mediumMin < val.highMin && val.highMin < val.criticalMin)) {
          throw new Error('scoreThresholds ordering violated: must satisfy mediumMin < highMin < criticalMin');
        }
      }
      return true;
    }),
];

/** Only these sub-keys can be written; anything else in a nested object is ignored (no dotted/operator keys reach MongoDB). */
const NESTED_THRESHOLD_KEYS = {
  velocityLimit: ['maxPerHour', 'maxPerDay'],
  scoreThresholds: ['mediumMin', 'highMin', 'criticalMin'],
};
const SCALAR_THRESHOLD_KEYS = ['amountThreshold', 'locationDeviationKm', 'newDeviceWeight'];

const getPath = (obj, path) => path.split('.').reduce((node, key) => node?.[key], obj);
const setPath = (obj, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((node, key) => (node[key] ??= {}), obj);
  parent[last] = value;
};

const unprocessable = (res, message) =>
  res.status(422).json({ success: false, message, errors: [{ msg: message }] });

// ── PATCH /admin-api/thresholds ────────────────────────────────────────────────
router.patch(
  '/thresholds',
  thresholdRules,
  validate,
  asyncHandler(async (req, res) => {
    const payload = req.body;
    const currentConfig = await SystemConfigModel.findOne({ singleton: 'system' }).lean();

    // C-P4-02: Merged N-03 validation for partial scoreThresholds updates.
    if (payload.scoreThresholds) {
      const currentST = currentConfig?.scoreThresholds ?? { mediumMin: 25, highMin: 50, criticalMin: 75 };
      const mergedST = {
        mediumMin:   payload.scoreThresholds.mediumMin   ?? currentST.mediumMin,
        highMin:     payload.scoreThresholds.highMin     ?? currentST.highMin,
        criticalMin: payload.scoreThresholds.criticalMin ?? currentST.criticalMin,
      };
      if (!(mergedST.mediumMin < mergedST.highMin && mergedST.highMin < mergedST.criticalMin)) {
        return unprocessable(res,
          `scoreThresholds ordering violated after merge: mediumMin(${mergedST.mediumMin}) must be < highMin(${mergedST.highMin}) must be < criticalMin(${mergedST.criticalMin})`);
      }
    }

    // L-14: the daily limit can never be lower than the hourly one — compared
    // against the stored value when only one of the two is sent.
    if (payload.velocityLimit?.maxPerHour !== undefined || payload.velocityLimit?.maxPerDay !== undefined) {
      const maxPerHour = payload.velocityLimit.maxPerHour ?? currentConfig?.velocityLimit?.maxPerHour ?? 5;
      const maxPerDay  = payload.velocityLimit.maxPerDay  ?? currentConfig?.velocityLimit?.maxPerDay  ?? 20;
      if (maxPerDay < maxPerHour) {
        return unprocessable(res,
          `velocityLimit.maxPerDay (${maxPerDay}) must be greater than or equal to maxPerHour (${maxPerHour})`);
      }
    }

    const setOps = {};
    for (const field of SCALAR_THRESHOLD_KEYS) {
      if (payload[field] !== undefined) setOps[field] = payload[field];
    }
    if (payload.highRiskMerchants !== undefined) {
      setOps.highRiskMerchants = [...new Set(payload.highRiskMerchants)]; // already normalised by the validator
    }
    for (const [parent, subKeys] of Object.entries(NESTED_THRESHOLD_KEYS)) {
      if (!payload[parent]) continue;
      for (const subKey of subKeys) {
        if (payload[parent][subKey] !== undefined) setOps[`${parent}.${subKey}`] = payload[parent][subKey];
      }
    }

    if (Object.keys(setOps).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid threshold fields provided.' });
    }

    const config = await SystemConfigModel.findOneAndUpdate(
      { singleton: 'system' },
      { $set: setOps },
      { returnDocument: 'after', upsert: true, runValidators: true }
    );

    // AUD-36 / L-14: the audit entry is a real diff — {before, after} of the keys
    // that changed, as nested objects (not dotted $set keys: field NAMES containing
    // '.' are rejected by some MongoDB-compatible stores and are awkward to query).
    const before = {};
    const after = {};
    const updatedFields = [];
    for (const [path, value] of Object.entries(setOps)) {
      const previous = getPath(currentConfig, path);
      if (JSON.stringify(previous) === JSON.stringify(value)) continue;
      setPath(before, path, previous ?? null);
      setPath(after, path, value);
      updatedFields.push(path);
    }
    if (updatedFields.length > 0) {
      await createAuditLog(
        req.user._id,
        'ADMIN',
        'THRESHOLDS_UPDATED',
        'SystemConfig',
        'system',
        { updatedFields, before, after },
        req.ip
      );
    }

    res.status(200).json({ success: true, message: 'Fraud detection thresholds updated.', data: config });
  })
);

// ── GET /admin-api/audit-logs ──────────────────────────────────────────────────
router.get(
  '/audit-logs',
  asyncHandler(async (req, res) => {
    const { actorRole, entityType, actorId } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 50); // AUD-21

    const filter = {};
    if (actorRole) filter.actorRole = actorRole;
    if (entityType) filter.entityType = entityType;
    if (actorId) filter.actorId = actorId;
    const dateFilter = buildDateRange(req.query); // L-05
    if (dateFilter) filter.timestamp = dateFilter;

    const [logs, total] = await Promise.all([
      AuditLogModel.find(filter)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate('actorId', 'name email role'),
      AuditLogModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: logs,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  })
);

export default router;
