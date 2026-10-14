import express from 'express';
import { body, query } from 'express-validator';
import { verifyToken, authorizeRoles } from '../middleware/verifyToken.js';
import validate from '../middleware/validate.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { parsePagination, buildPagination } from '../utils/pagination.js';
import createAuditLog from '../utils/createAuditLog.js';
import { getIO, disconnectUser } from '../utils/socketManager.js';
import { buildDateRange } from '../utils/dateRange.js';
import { FLAGGED_RISK_LEVELS, RISK_LEVELS } from '../utils/enums.js';
import { adminUsersQueryRules, auditLogsQueryRules } from '../validators/queryValidators.js';
import { simulationLimiter } from '../middleware/rateLimiter.js';
import { buildForecast } from '../utils/forecast.js';
import { riskLevelForScore, defaultScoreThresholds } from '../services/fraudDetectionService.js';
import { getMlClient } from '../services/scoringService.js';
import { getModelInsights, DEFAULT_INSIGHT_DAYS } from '../services/modelInsightsService.js';
import { getMlSettings } from '../config/mlSettings.js';
import {
  generateSimulation, clearSimulation, SimulationError, DEFAULT_SIM_COUNT,
} from '../services/simulationService.js';
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
  adminUsersQueryRules, // E-14: ?isActive=banana / ?role=x → 422 instead of a silent wrong filter
  validate,
  asyncHandler(async (req, res) => {
    const { role, isActive, search } = req.query;
    const { page, limit, skip } = parsePagination(req.query, 50); // AUD-21

    const filter = {};
    if (role) filter.role = role;
    if (isActive) filter.isActive = isActive === 'true'; // validated: 'true' | 'false' ('' = no filter)
    if (search) {
      filter.$or = [
        { name: { $regex: escapeRegex(search), $options: 'i' } },  // AUD-22: "(" used to cause a 500
        { email: { $regex: escapeRegex(search), $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      UserModel.find(filter)
        .sort({ createdAt: -1, _id: -1 }) // C-06: stable paging when createdAt ties
        .skip(skip)
        .limit(Number(limit))
        .select('-password'),
      UserModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: users,
      pagination: buildPagination(page, limit, total),
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
    // C-09: tokens issued before a deactivation stay dead after re-activation
    // (verifyToken.isTokenRevoked compares the token's issue time with this instant).
    if (!isActive) user.sessionsRevokedAt = new Date();
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

    const highRiskMatch = { ...timestampMatch, riskLevel: { $in: FLAGGED_RISK_LEVELS } };

    const [
      totalTransactions,
      riskDistribution,
      fraudByHour,
      fraudByPaymentMethod,
      fraudByLocation,
      lossPreventedAgg,
      openCasesCount,
      openAlertsCount,
      fraudByDevice,
      scoreBuckets,
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
        // E-09: "Mumbai", "mumbai" and " MUMBAI " are one city (as in the fraud rule). Group on the
        // trimmed lower-case key; show the spelling of the NEWEST transaction (sorted first, then $first).
        { $sort: { timestamp: -1, _id: -1 } },
        {
          $group: {
            _id: { $toLower: { $trim: { input: { $ifNull: ['$location.city', ''] } } } },
            city: { $first: '$location.city' },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1, _id: 1 } }, // C-06: deterministic top-10 on equal counts
        { $limit: 10 },
        { $project: { _id: 0, city: 1, count: 1 } },
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
      FraudAlertModel.countDocuments({ status: 'OPEN', riskLevel: { $in: FLAGGED_RISK_LEVELS } }),
      // A-01: devices behind the most HIGH/CRITICAL payments; userCount > 1 = a device shared by several accounts.
      TransactionModel.aggregate([
        { $match: highRiskMatch },
        { $group: { _id: '$deviceId', count: { $sum: 1 }, users: { $addToSet: '$userId' } } },
        { $sort: { count: -1, _id: 1 } }, // C-06: deterministic top-10 on equal counts
        { $limit: 10 },
        { $project: { _id: 0, deviceId: '$_id', count: 1, userCount: { $size: '$users' } } },
      ]).allowDiskUse(true),
      // A-01: score histogram over ALL transactions in range, bucket = floor(score / 10) with 100 in the last bucket.
      TransactionModel.aggregate([
        { $match: timestampMatch },
        {
          $group: {
            _id: { $cond: [{ $gte: ['$fraudScore', 90] }, 9, { $floor: { $divide: ['$fraudScore', 10] } }] },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const bucketCounts = new Map(scoreBuckets.map((b) => [Number(b._id), b.count]));
    const scoreHistogram = Array.from({ length: 10 }, (_, i) => {
      const from = i * 10;
      const to = i === 9 ? 100 : from + 9;
      return { from, to, label: `${from}-${to}`, count: bucketCounts.get(i) ?? 0 };
    });

    const highCriticalCount = riskDistribution
      .filter((r) => FLAGGED_RISK_LEVELS.includes(r._id))
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
        fraudByDevice,
        scoreHistogram,
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
          riskLevel: { $in: FLAGGED_RISK_LEVELS },
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
      { $match: { timestamp: { $gte: windowStart }, riskLevel: { $in: FLAGGED_RISK_LEVELS } } },
      { $group: { _id: { $hour: { date: '$timestamp', timezone: APP_TIME_ZONE } }, count: { $sum: 1 } } }, // AUD-06: IST hours
      { $sort: { count: -1, _id: 1 } }, // C-06: ties on count resolve to the earlier hour
      { $limit: 5 },
      { $project: { _id: 0, hour: '$_id', count: 1 } },
    ]);

    // A-04: next 7 IST days by least squares on the last 14 days of every charted series.
    const nextDates = Array.from({ length: 7 }, (_, i) =>
      new Date(Date.UTC(today.year, today.month - 1, today.day + 1 + i)).toISOString().slice(0, 10)
    );
    const forecast = buildForecast(
      trendData,
      nextDates,
      {
        count: { decimals: 0 },
        totalAmount: { decimals: 2 },
        avgFraudScore: { decimals: 1, max: 100 },
        movingAvg: { decimals: 2 },
      },
      (day) => day.count > 0
    );

    res.status(200).json({
      success: true,
      data: { dailyTrend: trendData, peakFraudHours, forecast },
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
// E-16: the cross-field checks (mediumMin < highMin < criticalMin, maxPerDay ≥ maxPerHour)
// run against the values READ here, so the write must only succeed while those values are
// unchanged. The stored values go into the update filter (compare-and-set); when another
// admin changed them in between, re-read and re-validate once, then answer 409.
const THRESHOLD_GUARD_PATHS = [
  ['scoreThresholds', ['mediumMin', 'highMin', 'criticalMin']],
  ['velocityLimit', ['maxPerHour', 'maxPerDay']],
];

/**
 * The cross-field checks of a partial update, run against the values it would be merged into. Shared by
 * PATCH /thresholds and the B-07 preview so both accept and refuse exactly the same payloads.
 * @returns {string|null} the 422 message, or null when the merged result is consistent
 */
const findMergedThresholdProblem = (payload, currentConfig) => {
  // C-P4-02: Merged N-03 validation for partial scoreThresholds updates.
  if (payload.scoreThresholds) {
    const currentST = currentConfig?.scoreThresholds ?? { mediumMin: 25, highMin: 50, criticalMin: 75 };
    const mergedST = {
      mediumMin:   payload.scoreThresholds.mediumMin   ?? currentST.mediumMin,
      highMin:     payload.scoreThresholds.highMin     ?? currentST.highMin,
      criticalMin: payload.scoreThresholds.criticalMin ?? currentST.criticalMin,
    };
    if (!(mergedST.mediumMin < mergedST.highMin && mergedST.highMin < mergedST.criticalMin)) {
      return `scoreThresholds ordering violated after merge: mediumMin(${mergedST.mediumMin}) must be < highMin(${mergedST.highMin}) must be < criticalMin(${mergedST.criticalMin})`;
    }
  }

  // L-14: the daily limit can never be lower than the hourly one — compared
  // against the stored value when only one of the two is sent.
  if (payload.velocityLimit?.maxPerHour !== undefined || payload.velocityLimit?.maxPerDay !== undefined) {
    const maxPerHour = payload.velocityLimit.maxPerHour ?? currentConfig?.velocityLimit?.maxPerHour ?? 5;
    const maxPerDay  = payload.velocityLimit.maxPerDay  ?? currentConfig?.velocityLimit?.maxPerDay  ?? 20;
    if (maxPerDay < maxPerHour) {
      return `velocityLimit.maxPerDay (${maxPerDay}) must be greater than or equal to maxPerHour (${maxPerHour})`;
    }
  }
  return null;
};

/** One read → validate → guarded write round. @returns {Promise<{ outcome: 'ok'|'invalid'|'conflict'|'empty', ... }>} */
const attemptThresholdUpdate = async (payload) => {
  const currentConfig = await SystemConfigModel.findOne({ singleton: 'system' }).lean();

  const problem = findMergedThresholdProblem(payload, currentConfig);
  if (problem) return { outcome: 'invalid', message: problem };

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

  if (Object.keys(setOps).length === 0) return { outcome: 'empty' };

  // Compare-and-set filter: only for the groups this request validated. `null` matches
  // "missing or null", so a config without a stored value is guarded too.
  const filter = { singleton: 'system' };
  if (currentConfig) {
    for (const [parent, subKeys] of THRESHOLD_GUARD_PATHS) {
      if (!payload[parent]) continue;
      for (const subKey of subKeys) filter[`${parent}.${subKey}`] = currentConfig[parent]?.[subKey] ?? null;
    }
  }

  const config = await SystemConfigModel.findOneAndUpdate(
    filter,
    { $set: setOps },
    // Upsert only when no config exists yet; with a guard a miss must NOT insert a second document.
    { returnDocument: 'after', upsert: !currentConfig, runValidators: true }
  );
  if (!config) return { outcome: 'conflict' };
  return { outcome: 'ok', config, currentConfig, setOps };
};

router.patch(
  '/thresholds',
  thresholdRules,
  validate,
  asyncHandler(async (req, res) => {
    let result = await attemptThresholdUpdate(req.body);
    if (result.outcome === 'conflict') result = await attemptThresholdUpdate(req.body); // another admin saved first: one retry on fresh values

    if (result.outcome === 'invalid') return unprocessable(res, result.message);
    if (result.outcome === 'empty') {
      return res.status(400).json({ success: false, message: 'No valid threshold fields provided.' });
    }
    if (result.outcome === 'conflict') {
      return res.status(409).json({
        success: false,
        message: 'The thresholds were just changed by another admin. Reload the page and try again.',
      });
    }

    const { config, currentConfig, setOps } = result;

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

// ── POST /admin-api/thresholds/preview ─────────────────────────────────────────
// B-07: "what if" for the score bands. Same body, validators and merged-consistency check as PATCH
// /thresholds, but NOTHING is written. The last 30 days of STORED fraud scores are re-banded with the current
// and the proposed bands (the band rule is the engine's own riskLevelForScore); rule weights and velocity
// limits are not re-evaluated, which is why the response says so.
const PREVIEW_WINDOW_DAYS = 30;
const BAND_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

router.post(
  '/thresholds/preview',
  thresholdRules,
  validate,
  asyncHandler(async (req, res) => {
    if (!req.body.scoreThresholds || typeof req.body.scoreThresholds !== 'object') {
      return res.status(400).json({ success: false, message: 'scoreThresholds is required for a preview.' });
    }

    const currentConfig = await SystemConfigModel.findOne({ singleton: 'system' }).lean();
    const problem = findMergedThresholdProblem(req.body, currentConfig);
    if (problem) return unprocessable(res, problem);

    // the bands the engine uses today: stored value per field, built-in default otherwise (as in checkFraud)
    const defaults = defaultScoreThresholds();
    const stored = currentConfig?.scoreThresholds ?? {};
    const finite = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
    const current = {
      mediumMin: finite(stored.mediumMin, defaults.mediumMin),
      highMin: finite(stored.highMin, defaults.highMin),
      criticalMin: finite(stored.criticalMin, defaults.criticalMin),
    };
    const proposed = {
      mediumMin: req.body.scoreThresholds.mediumMin ?? current.mediumMin,
      highMin: req.body.scoreThresholds.highMin ?? current.highMin,
      criticalMin: req.body.scoreThresholds.criticalMin ?? current.criticalMin,
    };

    const since = new Date(Date.now() - PREVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const perScore = await TransactionModel.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: { _id: '$fraudScore', count: { $sum: 1 } } }, // ≤ 101 distinct scores, however many transactions
    ]);

    const currentCounts = Object.fromEntries(RISK_LEVELS.map((level) => [level, 0]));
    const proposedCounts = Object.fromEntries(RISK_LEVELS.map((level) => [level, 0]));
    const moved = { up: 0, down: 0, unchanged: 0 };
    let total = 0;
    for (const { _id: score, count } of perScore) {
      const before = riskLevelForScore(score, current);
      const after = riskLevelForScore(score, proposed);
      currentCounts[before] += count;
      proposedCounts[after] += count;
      total += count;
      const shift = BAND_ORDER.indexOf(after) - BAND_ORDER.indexOf(before);
      if (shift > 0) moved.up += count;
      else if (shift < 0) moved.down += count;
      else moved.unchanged += count;
    }

    res.status(200).json({
      success: true,
      data: {
        windowDays: PREVIEW_WINDOW_DAYS,
        total,
        current: currentCounts,
        proposed: proposedCounts,
        moved,
        note: 'Re-bands stored fraud scores; rule weights and velocity limits are not re-evaluated.',
      },
    });
  })
);

// ── POST /admin-api/simulation/generate ───────────────────────────────────────
// A-08: synthetic customers + payments through the real pipeline (services/simulationService.js).
// 10 requests / hour / admin; refuses to go beyond MAX_SIMULATED_TRANSACTIONS simulated payments in total.
const simulationErrorResponse = (err, res) => {
  if (err instanceof SimulationError) return res.status(err.status).json({ success: false, message: err.message });
  throw err;
};

router.post(
  '/simulation/generate',
  [
    body('count')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('count must be an integer between 1 and 100')
      .toInt(),
  ],
  validate,
  simulationLimiter,
  asyncHandler(async (req, res) => {
    const count = req.body.count ?? DEFAULT_SIM_COUNT;
    let result;
    try {
      result = await generateSimulation({ count });
    } catch (err) {
      return simulationErrorResponse(err, res);
    }

    await createAuditLog(
      req.user._id,
      'ADMIN',
      'SIMULATION_DATA_GENERATED',
      'SystemConfig',
      'simulation',
      { requested: count, ...result },
      req.ip
    );

    res.status(200).json({
      success: true,
      message: `Generated ${result.generated} simulated transactions.`,
      data: result,
    });
  })
);

// ── DELETE /admin-api/simulation/data ─────────────────────────────────────────
router.delete(
  '/simulation/data',
  asyncHandler(async (req, res) => {
    const deleted = await clearSimulation();

    await createAuditLog(
      req.user._id,
      'ADMIN',
      'SIMULATION_DATA_CLEARED',
      'SystemConfig',
      'simulation',
      { ...deleted },
      req.ip
    );

    res.status(200).json({ success: true, message: 'Simulation data cleared.', data: deleted });
  })
);

// ── GET /admin-api/ml-status ─────────────────────────────────────────────────
// Phase 10: which engine scores payments right now, and how the last 24 hours were scored.
// No secrets: the API key is never returned, only the service host.
router.get(
  '/ml-status',
  asyncHandler(async (req, res) => {
    const settings = getMlSettings();
    const client = getMlClient();
    // D-2: opening the dashboard also wakes a sleeping ML service (status() then reports `waking`).
    client?.wakeUpIfIdle();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const counts = await TransactionModel.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: { _id: '$scoring.engine', count: { $sum: 1 } } },
    ]);
    // A missing scoring.engine groups as null: transactions scored before Phase 10.
    const last24h = { ML: 0, RULES: 0, LEGACY: 0 };
    for (const { _id, count } of counts) last24h[_id ?? 'LEGACY'] += count;

    // The client reports its own settings; with ML off, the configured timeout / cool-down are shown.
    const state = client ? client.status() : {
      serviceHost: null,
      timeoutMs: settings.timeoutMs,
      cooldownMs: settings.cooldownMs,
      coolingDown: false,
      cooldownEndsAt: null,
      waking: false,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      modelVersion: null,
    };
    res.status(200).json({ success: true, data: { enabled: Boolean(client), ...state, last24h } });
  })
);

// ── GET /admin-api/model-insights ──────────────────────────────────────────────
// R4-08: how the ML model behaves in real use over the last `days` days (default 30, 1–365): engines and fallbacks,
// ML-vs-rules band agreement, the biggest disagreements, live feature influence (mean |SHAP|) and case outcomes.
router.get(
  '/model-insights',
  [query('days').optional().isInt({ min: 1, max: 365 }).withMessage('days must be a whole number from 1 to 365')],
  validate,
  asyncHandler(async (req, res) => {
    // Express 5: req.query is read-only, so a sanitizer cannot convert it in place — convert here.
    const data = await getModelInsights({ days: req.query.days === undefined ? DEFAULT_INSIGHT_DAYS : Number(req.query.days) });
    res.status(200).json({ success: true, data });
  })
);

// ── GET /admin-api/audit-logs ──────────────────────────────────────────────────
router.get(
  '/audit-logs',
  auditLogsQueryRules, // E-14
  validate,
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
        .sort({ timestamp: -1, _id: -1 }) // C-06
        .skip(skip)
        .limit(Number(limit))
        .populate('actorId', 'name email role'),
      AuditLogModel.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: logs,
      pagination: buildPagination(page, limit, total),
    });
  })
);

export default router;
