import mongoose from 'mongoose';

const { Schema } = mongoose;

const locationSchema = new Schema(
  {
    city:    { type: String, trim: true, default: 'Unknown' },
    country: { type: String, trim: true, default: 'IN' },
  },
  { _id: false }   // embedded sub-document; no separate _id needed
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
        values: ['UPI', 'CARD', 'NET_BANKING', 'WALLET'],
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
        values: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
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
    status: {
      type: String,
      enum: {
        values: ['APPROVED', 'HELD', 'BLOCKED'],
        message: 'Status must be APPROVED, HELD, or BLOCKED',
      },
      required: [true, 'Transaction status is required'],
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
transactionSchema.index({ userId: 1, timestamp: -1 });
transactionSchema.index({ riskLevel: 1, status: 1 });
// L-15: submit scores/updates by deviceId three times per request (reputation
// counts, device lookups) and the analyst device page filters on it.
transactionSchema.index({ deviceId: 1 });
// Analyst flagged list / fraud patterns and admin analytics filter by risk level and date.
transactionSchema.index({ riskLevel: 1, timestamp: -1 });

const TransactionModel = mongoose.model('Transaction', transactionSchema);

export default TransactionModel;
