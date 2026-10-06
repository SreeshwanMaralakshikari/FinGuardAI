import mongoose from 'mongoose';

const { Schema } = mongoose;

// ── Nested schema: transaction velocity limits ─────────────────────────────────
const velocityLimitSchema = new Schema(
  {
    maxPerHour: {
      type: Number,
      default: 5,
      min: [1, 'Max transactions per hour must be at least 1'],
    },
    maxPerDay: {
      type: Number,
      default: 20,
      min: [1, 'Max transactions per day must be at least 1'],
    },
  },
  { _id: false }
);

// ── Nested schema: score boundaries that map numeric score → riskLevel enum ───
const scoreThresholdsSchema = new Schema(
  {
    mediumMin: {
      type: Number,
      default: 25,            // scores [25–49] → MEDIUM
      min: [1, 'mediumMin must be at least 1'],
      max: [98, 'mediumMin must be less than highMin'],
    },
    highMin: {
      type: Number,
      default: 50,            // scores [50–74] → HIGH
      min: [2, 'highMin must be at least 2'],
      max: [99, 'highMin must be less than criticalMin'],
    },
    criticalMin: {
      type: Number,
      default: 75,            // scores [75–100] → CRITICAL
      min: [3, 'criticalMin must be at least 3'],
      max: [100, 'criticalMin must be at most 100'],
    },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────────────────────
const systemConfigSchema = new Schema(
  {
    // ── Singleton guard ────────────────────────────────────────────────────────
    // The unique index on `singleton` ensures the collection can never hold
    // more than one document. AdminAPI.js always upserts with filter { singleton: 'system' }.
    singleton: {
      type: String,
      default: 'system',
      enum: {
        values: ['system'],
        message: 'singleton field must equal "system"',
      },
      unique: true,
    },

    // ── Fraud detection thresholds ─────────────────────────────────────────────
    amountThreshold: {
      type: Number,
      default: 50000,         // ₹50,000 — transactions above this are flagged for amount anomaly
      min: [0, 'Amount threshold cannot be negative'],
    },
    velocityLimit: {
      type: velocityLimitSchema,
      default: () => ({}),
    },
    locationDeviationKm: {
      type: Number,
      default: 500,           // km — RESERVED: the rule-based locationCheck compares city names;
                              // distance-based scoring needs geocoding (Phase 10+). Stored and editable.
      min: [0, 'Location deviation cannot be negative'],
    },
    newDeviceWeight: {
      type: Number,
      default: 20,            // score points added when device is not in knownDeviceIds
      min: [0, 'New device weight cannot be negative'],
      max: [100, 'New device weight cannot exceed 100'],
    },
    highRiskMerchants: {
      type: [String],
      default: ['CASINO', 'GAMBLING', 'CRYPTO_EXCHANGE', 'ADULT', 'OFFSHORE_BETTING'],
                              // merchantCategory values that trigger _checkHighRiskMerchant
    },
    scoreThresholds: {
      type: scoreThresholdsSchema,
      default: () => ({}),    // fraudDetectionService maps fraudScore to riskLevel using these
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
// singleton is indexed automatically via unique: true — enforces single-document pattern.

const SystemConfigModel = mongoose.model('SystemConfig', systemConfigSchema);

export default SystemConfigModel;
