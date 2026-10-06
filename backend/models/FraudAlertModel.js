import mongoose from 'mongoose';

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
        values: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
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
        values: ['OPEN', 'REVIEWED', 'DISMISSED'],
        message: 'Alert status must be OPEN, REVIEWED, or DISMISSED',
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
fraudAlertSchema.index({ transactionId: 1 }); // analyst detail view looks the alert up by transaction (L-15)

const FraudAlertModel = mongoose.model('FraudAlert', fraudAlertSchema);

export default FraudAlertModel;
