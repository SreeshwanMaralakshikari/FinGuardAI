/**
 * @file validators/queryValidators.js
 * @description E-14 / H-07: query-string filters are validated instead of being
 *   silently ignored (?isActive=banana used to filter to inactive users, ?status=garbage
 *   returned an empty list). Failures use the project's standard 422 shape
 *   (middleware/validate.js). An EMPTY value (?status=) still means "no filter", which is
 *   what the frontend's cleared filter dropdowns send. The shared lists live in utils/enums.js.
 */
import { query } from 'express-validator';
import {
  ALERT_STATUSES,
  CASE_STATUSES,
  FLAGGED_RISK_LEVELS,
  PAYMENT_METHODS,
  RISK_LEVELS,
  ROLES,
} from '../utils/enums.js';

const BOOLEAN_STRINGS = ['true', 'false'];

/** Optional filter that must be one of `values`. isString() first: ?x[]=a arrives as an array. */
const oneOf = (name, values) =>
  query(name)
    .optional({ values: 'falsy' })
    .isString().withMessage(`${name} must be one of: ${values.join(', ')}`).bail()
    .isIn(values).withMessage(`${name} must be one of: ${values.join(', ')}`);

export const adminUsersQueryRules = [
  oneOf('role', ROLES),
  oneOf('isActive', BOOLEAN_STRINGS),
];

export const auditLogsQueryRules = [oneOf('actorRole', ROLES)];

export const notificationsQueryRules = [oneOf('isRead', BOOLEAN_STRINGS)];

export const customerTransactionsQueryRules = [
  oneOf('riskLevel', RISK_LEVELS),
  oneOf('paymentMethod', PAYMENT_METHODS),
];

export const customerAlertsQueryRules = [
  oneOf('status', ALERT_STATUSES),
  oneOf('riskLevel', RISK_LEVELS),
];

/** A-02: ?limit=1..100 (default 50 in the handler); anything else is a 422, not a silent clamp. */
export const customerTimelineQueryRules = [
  query('limit')
    .optional({ values: 'falsy' })
    .custom((value) => typeof value === 'string').withMessage('limit must be a whole number between 1 and 100').bail() // ?limit[]=5 arrives as an array
    .isInt({ min: 1, max: 100 }).withMessage('limit must be a whole number between 1 and 100'),
];

export const flaggedTransactionsQueryRules = [oneOf('riskLevel', FLAGGED_RISK_LEVELS)];

export const analystCasesQueryRules = [
  oneOf('status', CASE_STATUSES),
  oneOf('assignedToMe', BOOLEAN_STRINGS),
];
