import mongoose from 'mongoose';
import { ALERT_STATUSES, RISK_LEVELS } from '../utils/enums.js';

const { Schema } = mongoose;

const fraudAlertSchema = new Schema(
  {
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: 'Transaction',
      required: [true, 'Transaction ID is required'],
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
    },
    alertType: {
      type: String,
      enum: {
        values: [
          'AMOUNT_ANOMALY',
          'VELOCITY_BREACH',
          'LOCATION_DEVIATION',
          'NEW_DEVICE',
          'UNUSUAL_HOUR',
          'HIGH_RISK_MERCHANT',
          'COMPOSITE',         // multiple rules fired simultaneously
        ],
        message: 'Invalid alert type',
      },
      required: [true, 'Alert type is required'],
    },
    riskLevel: {
      type: String,
      enum: {
        values: [...RISK_LEVELS],
        message: 'Risk level must be LOW, MEDIUM, HIGH, or CRITICAL',
      },
      required: [true, 'Risk level is required'],
    },
    fraudScore: {
      type: Number,
      required: [true, 'Fraud score is required'],
      min: [0, 'Fraud score cannot be below 0'],
      max: [100, 'Fraud score cannot exceed 100'],
    },
    reasons: {
      type: [String],
      default: [],            // mirrored from the parent transaction for alert context
    },
    status: {
      type: String,
      enum: {
        values: [...ALERT_STATUSES],
        message: 'Alert status must be OPEN, REVIEWED, DISMISSED, or ACKNOWLEDGED',
      },
      default: 'OPEN',
    },
  },
  {
    timestamps: true,         // createdAt used in the riskLevel+createdAt index below
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
fraudAlertSchema.index({ userId: 1, status: 1 });
fraudAlertSchema.index({ riskLevel: 1, createdAt: -1 });
// C-02: one alert per transaction (the only creation path is POST /customer-api/transactions, once per
// transaction). Also the lookup index of the analyst detail view (L-15) and what makes the insert retry idempotent.
fraudAlertSchema.index({ transactionId: 1 }, { unique: true });

const FraudAlertModel = mongoose.model('FraudAlert', fraudAlertSchema);

export default FraudAlertModel;
