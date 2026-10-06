import mongoose from 'mongoose';

const { Schema } = mongoose;

const auditLogSchema = new Schema(
  {
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Actor ID is required'],
    },
    actorRole: {
      type: String,
      enum: {
        values: ['CUSTOMER', 'ANALYST', 'ADMIN'],
        message: 'Actor role must be CUSTOMER, ANALYST, or ADMIN',
      },
      required: [true, 'Actor role is required'],
    },
    action: {
      type: String,
      required: [true, 'Action is required'],
      trim: true,
      maxlength: [100, 'Action string cannot exceed 100 characters'],
                        // e.g. 'TRANSACTION_SUBMITTED', 'CASE_STATUS_CHANGED', 'USER_DEACTIVATED'
    },
    entityType: {
      type: String,
      required: [true, 'Entity type is required'],
      trim: true,
      maxlength: [50, 'Entity type cannot exceed 50 characters'],
                        // e.g. 'Transaction', 'FraudCase', 'User', 'SystemConfig'
    },
    entityId: {
      type: String,
      required: [true, 'Entity ID is required'],
      trim: true,
                        // String (not ObjectId) to accommodate both ObjectId and public IDs
                        // e.g. '686dca2f...' or 'TXN-2026-00042' or 'CASE-2026-00007'
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},              // flexible bag: previous value, new value, additional context
    },
    ipAddress: {
      type: String,
      trim: true,               // req.ip captured by the route handler
    },
    timestamp: {
      type: Date,
      default: Date.now,        // explicit event time; separate from Mongoose createdAt
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
auditLogSchema.index({ actorId: 1, timestamp: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1 });
auditLogSchema.index({ timestamp: -1 }); // GET /admin-api/audit-logs sorts and range-filters on timestamp (L-15)

const AuditLogModel = mongoose.model('AuditLog', auditLogSchema);

export default AuditLogModel;
