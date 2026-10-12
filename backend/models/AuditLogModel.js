import mongoose from 'mongoose';
import { ROLES, AUDIT_ACTIONS } from '../utils/enums.js';
import { getAuditLogTtlSeconds } from '../config/opsSettings.js';

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
        values: [...ROLES],
        message: 'Actor role must be CUSTOMER, ANALYST, or ADMIN',
      },
      required: [true, 'Actor role is required'],
    },
    action: {
      type: String,
      required: [true, 'Action is required'],
      enum: {
        values: [...AUDIT_ACTIONS],
        message: 'Unknown audit action',
      },
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
// C-04: audit entries are kept FOREVER unless AUDIT_LOG_TTL_DAYS is set. The expiry is done by the database's TTL monitor
// (not through the model), so the append-only guards below are unaffected; it uses createdAt because a TTL index on
// `timestamp` would clash with the plain {timestamp:-1} index above (same key, different options).
const auditLogTtlSeconds = getAuditLogTtlSeconds();
if (auditLogTtlSeconds !== null) {
  auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: auditLogTtlSeconds });
}

// ── D-09: append-only guards ──────────────────────────────────────────────────
// Audit entries are written once and never changed. Every Mongoose write path that
// could modify or remove one is refused here, so a future bug (or a careless admin
// route) cannot rewrite history through the model. This is an application-level guard:
// collection-level access (`Model.collection.*`, used by the test cleanup) and the
// database itself are not covered — for that, use a database role without update/delete.
export const AUDIT_LOG_IMMUTABLE_MESSAGE = 'Audit log entries are immutable and cannot be modified or deleted.';
const refuse = () => { throw new Error(AUDIT_LOG_IMMUTABLE_MESSAGE); };

// Query middleware (Model.updateOne(), findByIdAndUpdate() → findOneAndUpdate, findByIdAndDelete() → findOneAndDelete, …)
auditLogSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  { document: false, query: true },
  refuse
);
// Document middleware: doc.deleteOne() and doc.save() on an entry that already exists.
auditLogSchema.pre('deleteOne', { document: true, query: false }, refuse);
auditLogSchema.pre('save', function () {
  if (!this.isNew) refuse();
});
// Model.bulkWrite(): inserts are fine, anything else is not.
auditLogSchema.pre('bulkWrite', function (ops) {
  if ((ops ?? []).some((op) => !('insertOne' in op))) refuse();
});

const AuditLogModel = mongoose.model('AuditLog', auditLogSchema);

export default AuditLogModel;
