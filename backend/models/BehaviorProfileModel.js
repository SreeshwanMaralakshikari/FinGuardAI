import mongoose from 'mongoose';

const { Schema } = mongoose;

const transactionVelocitySchema = new Schema(
  {
    perHour: {
      type: Number,
      default: 0,
      min: [0, 'Per-hour velocity cannot be negative'],
    },
    perDay: {
      type: Number,
      default: 0,
      min: [0, 'Per-day velocity cannot be negative'],
    },
  },
  { _id: false }
);

const behaviorProfileSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      unique: true,           // one behavior profile per customer — enforced at DB level
    },
    avgTransactionAmount: {
      type: Number,
      default: 0,
      min: [0, 'Average amount cannot be negative'],
    },
    maxTransactionAmount: {
      type: Number,
      default: 0,
      min: [0, 'Max amount cannot be negative'],
    },
    usualLocations: {
      type: [String],
      default: [],            // city names; e.g. ['Mumbai', 'Pune']; updated by calcBehaviorProfile.js
    },
    usualHours: {
      type: [Number],
      default: [],            // hours 0–23; e.g. [9, 10, 11, 14, 15]
      validate: {
        validator: (arr) => arr.every((h) => h >= 0 && h <= 23),
        message: 'All hour values must be between 0 and 23',
      },
    },
    usualPaymentMethods: {
      type: [String],
      default: [],            // e.g. ['UPI', 'CARD']; from the locked paymentMethod enum
    },
    transactionVelocity: {
      type: transactionVelocitySchema,
      default: () => ({}),    // rolling-window averages; recalculated by calcBehaviorProfile.js
    },
    knownDeviceIds: {
      type: [String],
      default: [],            // device fingerprints seen for this user
    },
    lastUpdated: {
      type: Date,
      default: Date.now,      // explicitly set by calcBehaviorProfile.js on each recalculation
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
// userId is indexed automatically via unique: true — no additional index required.

const BehaviorProfileModel = mongoose.model('BehaviorProfile', behaviorProfileSchema);

export default BehaviorProfileModel;
