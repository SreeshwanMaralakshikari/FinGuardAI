import AuditLogModel from '../models/AuditLogModel.js';

/**
 * createAuditLog — writes one immutable audit entry.
 * Failure is non-fatal: logs to console but never throws (audit must not break business flow).
 *
 * @param {ObjectId|string} actorId    — User performing the action
 * @param {string}          actorRole  — 'CUSTOMER' | 'ANALYST' | 'ADMIN'
 * @param {string}          action     — e.g. 'TRANSACTION_SUBMITTED', 'CASE_STATUS_CHANGED'
 * @param {string}          entityType — e.g. 'Transaction', 'FraudCase', 'User', 'SystemConfig'
 * @param {string}          entityId   — ObjectId string or public ID (TXN-* / CASE-*)
 * @param {object}          metadata   — additional context key-value pairs
 * @param {string}          ipAddress  — req.ip from the route handler
 */
const createAuditLog = async (
  actorId,
  actorRole,
  action,
  entityType,
  entityId,
  metadata = {},
  ipAddress = ''
) => {
  try {
    await AuditLogModel.create({
      actorId,
      actorRole,
      action,
      entityType,
      entityId: String(entityId),
      metadata,
      ipAddress,
    });
  } catch (err) {
    // Per D-P4-06: audit failure is non-fatal
    console.error('[AuditLog] Failed to write audit entry:', err.message);
  }
};

export default createAuditLog;
