import mongoose from 'mongoose';
import {
  PAYMENT_METHODS, RISK_LEVELS, TRANSACTION_STATUSES,
  SCORING_ENGINES, ML_FEATURE_KEYS, ML_FALLBACK_REASONS, ML_SIGNAL_TYPES,
} from '../utils/enums.js';

const { Schema } = mongoose;

const locationSchema = new Schema(
  {
    city:    { type: String, trim: true, default: 'Unknown' },
    country: { type: String, trim: true, default: 'IN' },
  },
  { _id: false }   // embedded sub-document; no separate _id needed
);

// B-01: one entry per scoring rule (see fraudDetectionService.breakdown)
const scoreBreakdownSchema = new Schema(
  {
    rule:   { type: String, enum: ['velocity', 'amount', 'location', 'device', 'time', 'merchant'], required: true },
    label:  { type: String, required: true },
    points: { type: Number, required: true, min: 0 },
    max:    { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// Phase 10: one SHAP value per ML feature (see services/scoringService.js)
const shapValueSchema = new Schema(
  {
    feature: { type: String, enum: [...ML_FEATURE_KEYS], required: true },
    label:   { type: String, required: true, maxlength: 80 },
    value:   { type: String, required: true, maxlength: 40 },   // readable value, e.g. "10.0×" or "Yes"
    shap:    { type: Number, required: true },                  // log-odds push: > 0 raises the risk
  },
  { _id: false }
);

// Phase 10: which engine produced the score, and the ML explanation when the model scored it.
const scoringSchema = new Schema(
  {
    engine:           { type: String, enum: [...SCORING_ENGINES], required: true },
    ruleScore:        { type: Number, min: 0, max: 100, required: true },  // the rule engine's score, for comparison
    modelVersion:     { type: String, maxlength: 64 },
    fraudProbability: { type: Number, min: 0, max: 1 },
    fallbackReason:   { type: String, enum: [...ML_FALLBACK_REASONS] },     // only when ML was enabled but not used
    signals:          { type: [{ type: String, enum: [...ML_SIGNAL_TYPES] }], default: undefined },
    shapBaseValue:    { type: Number },
    shapValues:       { type: [shapValueSchema], default: undefined },
  },
  { _id: false }
);

const transactionSchema = new Schema(
  {
    publicId: {
      type: String,
      unique: true,
      sparse: true,           // publicId is always set at insert (AUD-05); sparse kept for legacy documents
      match: [/^TXN-\d{4}-\d{5,}$/, 'Invalid TXN public ID format'], // 5 digits, more once a year passes 99,999 (L-15)
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
    },
    amount: {
      type: Number,
      required: [true, 'Amount is required'],
      min: [0.01, 'Amount must be greater than 0'],
    },
    merchantName: {
      type: String,
      required: [true, 'Merchant name is required'],
      trim: true,
      maxlength: [200, 'Merchant name cannot exceed 200 characters'],
    },
    merchantCategory: {
      type: String,
      trim: true,
      default: 'GENERAL',    // used by _checkHighRiskMerchant rule in fraudDetectionService
    },
    paymentMethod: {
      type: String,
      enum: {
        values: [...PAYMENT_METHODS],
        message: 'Payment method must be UPI, CARD, NET_BANKING, or WALLET',
      },
      required: [true, 'Payment method is required'],
    },
    location: {
      type: locationSchema,
      default: () => ({}),
    },
    deviceId: {
      type: String,
      required: [true, 'Device ID is required'],
      trim: true,             // device fingerprint string (e.g. UUID from frontend)
    },
    ipAddress: {
      type: String,
      trim: true,             // captured from req.ip in the route handler
    },
    timestamp: {
      type: Date,
      default: Date.now,      // transaction submission time; separate from createdAt
    },
    fraudScore: {
      type: Number,
      required: [true, 'Fraud score is required'],
      min: [0, 'Fraud score cannot be below 0'],
      max: [100, 'Fraud score cannot exceed 100'],
    },
    riskLevel: {
      type: String,
      enum: {
        values: [...RISK_LEVELS],
        message: 'Risk level must be LOW, MEDIUM, HIGH, or CRITICAL',
      },
      required: [true, 'Risk level is required'],
    },
    reasons: {
      type: [String],
      default: [],            // human-readable strings from fraudDetectionService
    },
    recommendedAction: {
      type: String,
      enum: {
        values: ['APPROVE', 'OTP', 'HOLD', 'BLOCK'],
        message: 'Recommended action must be APPROVE, OTP, HOLD, or BLOCK',
      },
      required: [true, 'Recommended action is required'],
    },
    estimatedLoss: {
      type: Number,
      min: [0, 'Estimated loss cannot be negative'],
      default: 0,             // ₹ amount at risk; 0 for APPROVE/LOW-risk
    },
    // B-01: why the score is what it is — all six rules, points 0 included. [] on legacy documents.
    scoreBreakdown: {
      type: [scoreBreakdownSchema],
      default: [],
    },
    // Phase 10: absent on transactions scored before Phase 10 (the UI then shows the rule breakdown only).
    scoring: {
      type: scoringSchema,
    },
    status: {
      type: String,
      enum: {
        values: [...TRANSACTION_STATUSES],
        message: 'Status must be APPROVED, HELD, or BLOCKED',
      },
      required: [true, 'Transaction status is required'],
    },
    // B-03: set when an analyst DISMISSES the case and the HELD / BLOCKED payment is released to
    // APPROVED. calcBehaviorProfile treats such a transaction as trusted (an APPROVED MEDIUM one,
    // never reviewed, still is not). Absent on every other transaction.
    releasedByCaseAt: {
      type: Date,
    },
    // A-08: true only for transactions created by the admin simulation generator (never set from a request body).
    // Absent (not false) on real transactions, so the sparse index below stays tiny.
    isSimulated: {
      type: Boolean,
    },
    // C-01: the client's Idempotency-Key (never returned by the API). Unique per user, see index below.
    idempotencyKey: {
      type: String,
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
transactionSchema.index({ userId: 1, timestamp: -1 });
// C-05: {riskLevel, status} was dropped (no query filters on that pair); {status, timestamp} serves the loss-prevented aggregation.
transactionSchema.index({ status: 1, timestamp: -1 });
// L-15: submit scores/updates by deviceId three times per request (reputation
// counts, device lookups) and the analyst device page filters on it.
transactionSchema.index({ deviceId: 1 });
// Analyst flagged list / fraud patterns and admin analytics filter by risk level and date.
transactionSchema.index({ riskLevel: 1, timestamp: -1 });
// C-08: "which devices has this user used" (distinct device count + known-device check) is served by this index.
transactionSchema.index({ userId: 1, deviceId: 1 });
// A-08: counting / clearing simulated data; sparse = only the (few) simulated documents are indexed.
transactionSchema.index({ isSimulated: 1 }, { sparse: true });

// C-01: a retried POST with the same Idempotency-Key must not create a second payment. Partial, so the many
// transactions without a key (seeds, legacy, header omitted) are not indexed and never collide.
transactionSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true, $type: 'string' } } }
);

const TransactionModel = mongoose.model('Transaction', transactionSchema);

export default TransactionModel;
