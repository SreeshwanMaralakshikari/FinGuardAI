import mongoose from 'mongoose';

const { Schema } = mongoose;

const deviceReputationSchema = new Schema(
  {
    deviceId: {
      type: String,
      required: [true, 'Device ID is required'],
      unique: true,
      trim: true,             // device fingerprint string (UUID or browser fingerprint hash)
    },
    reputationScore: {
      type: Number,
      min: [0, 'Reputation score cannot be below 0'],
      max: [100, 'Reputation score cannot exceed 100'],
      default: 100,           // starts fully trusted; decremented by updateDeviceReputation.js on fraud
    },
    firstSeenAt: {
      type: Date,
      default: Date.now,      // set once when the deviceId is first encountered
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,      // updated on every transaction from this device
    },
    associatedUserIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      default: [],            // all User accounts that have transacted from this device
    },
    flagCount: {
      type: Number,
      default: 0,
      min: [0, 'Flag count cannot be negative'],
                              // incremented on every MEDIUM+ risk transaction
    },
    fraudTransactionCount: {
      type: Number,
      default: 0,
      min: [0, 'Fraud transaction count cannot be negative'],
                              // incremented on HIGH/CRITICAL transactions
    },
    isBlacklisted: {
      type: Boolean,
      default: false,         // set true by updateDeviceReputation.js when reputationScore < threshold
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
// deviceId is indexed automatically via unique: true.
deviceReputationSchema.index({ reputationScore: 1 });

const DeviceReputationModel = mongoose.model('DeviceReputation', deviceReputationSchema);

export default DeviceReputationModel;
