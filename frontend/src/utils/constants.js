/**
 * @file src/utils/constants.js
 * @description Application-wide constants and API path registry.
 *   - API_PATHS: frozen object — single source of truth for all endpoint strings
 *     Dynamic segments (:id, :deviceId) are appended at thunk call site.
 *   - Role, status, and risk level enums
 * @phase Phase 6 — Frontend Foundation
 * @decision D-P6-04, D-P6-15, D-P6-16, D-P6-21
 */

// ─── Role Enum ────────────────────────────────────────────────────────────────

export const ROLES = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  ANALYST:  'ANALYST',
  ADMIN:    'ADMIN',
});

// ─── Role → home route ────────────────────────────────────────────────────────
export const ROLE_HOME = Object.freeze({
  CUSTOMER: '/customer',
  ANALYST:  '/analyst',
  ADMIN:    '/admin',
});

// ─── Payment methods (TransactionModel.paymentMethod enum) ────────────────────
export const PAYMENT_METHODS = Object.freeze(['UPI', 'CARD', 'NET_BANKING', 'WALLET']);

// ─── Risk Level Enum ──────────────────────────────────────────────────────────
// Matches fraudDetectionService.js output (Phase 5 D-P5-06)

export const RISK_LEVELS = Object.freeze({
  LOW:      'LOW',
  MEDIUM:   'MEDIUM',
  HIGH:     'HIGH',
  CRITICAL: 'CRITICAL',
});

// ─── Case Status Enum ─────────────────────────────────────────────────────────
// Matches Phase 3 FraudCase schema

export const CASE_STATUSES = Object.freeze({
  OPEN:          'OPEN',
  ASSIGNED:      'ASSIGNED',
  UNDER_REVIEW:  'UNDER_REVIEW',
  RESOLVED:      'RESOLVED',
  DISMISSED:     'DISMISSED',
});

// ─── Transaction Status Enum ──────────────────────────────────────────────────
// Matches Phase 3 TransactionModel.status enum: ['APPROVED', 'HELD', 'BLOCKED']
// C-P6-07: corrected from incorrect PENDING/COMPLETED/FLAGGED/REVERSED

export const TX_STATUSES = Object.freeze({
  APPROVED: 'APPROVED',
  HELD:     'HELD',
  BLOCKED:  'BLOCKED',
});

// ─── Notification Type Enum ───────────────────────────────────────────────────
// Matches Phase 3 NotificationModel.type enum: ['FRAUD_ALERT', 'CASE_ASSIGNED', 'CASE_STATUS_CHANGED']
// C-P6-09: corrected from incorrect FRAUD_ALERT/TRANSACTION_UPDATE/CASE_UPDATE/SYSTEM

export const NOTIFICATION_TYPES = Object.freeze({
  FRAUD_ALERT:          'FRAUD_ALERT',
  CASE_ASSIGNED:        'CASE_ASSIGNED',
  CASE_STATUS_CHANGED:  'CASE_STATUS_CHANGED',
});

// ─── API Paths ────────────────────────────────────────────────────────────────
// Frozen object — single source of truth for all endpoint strings.
// Dynamic segments (:id) are appended at thunk call site:
//   e.g. `${API_PATHS.CUSTOMER.TRANSACTION_BY_ID}/${id}`

export const API_PATHS = Object.freeze({
  AUTH: Object.freeze({
    LOGIN:            '/auth/login',
    LOGOUT:           '/auth/logout',
    REGISTER:         '/auth/register',
    CHECK_AUTH:       '/auth/check-auth',
    CHANGE_PASSWORD:  '/auth/change-password',
  }),

  CUSTOMER: Object.freeze({
    SUBMIT_TRANSACTION: '/customer-api/transactions',
    TRANSACTIONS:       '/customer-api/transactions',
    TRANSACTION_BY_ID:  '/customer-api/transactions',  // append /:id
    FRAUD_ALERTS:       '/customer-api/fraud-alerts',
    ALERT_BY_ID:        '/customer-api/fraud-alerts',  // append /:id
    TRUST_SCORE:        '/customer-api/trust-score',
    PROFILE:            '/customer-api/profile',
  }),

  ANALYST: Object.freeze({
    FLAGGED_TRANSACTIONS: '/analyst-api/flagged-transactions',
    TRANSACTION_DETAIL:   '/analyst-api/flagged-transactions', // append /:id
    CREATE_CASE:          '/analyst-api/cases',
    CASES:                '/analyst-api/cases',
    CASE_BY_ID:           '/analyst-api/cases',           // append /:id
    UPDATE_CASE_STATUS:   '/analyst-api/cases',           // append /:id/status
    ASSIGN_CASE:          '/analyst-api/cases',           // append /:id/assign
    ADD_CASE_NOTE:        '/analyst-api/cases',           // append /:id/notes
    DEVICE_REPUTATION:    '/analyst-api/devices',
    FRAUD_PATTERNS:       '/analyst-api/fraud-patterns',
  }),

  ADMIN: Object.freeze({
    USERS:          '/admin-api/users',
    USER_BY_ID:     '/admin-api/users',             // ⚠️ no GET /admin-api/users/:id route exists — use USERS (list) or TOGGLE_USER
    TOGGLE_USER:    '/admin-api/users',             // append /:id/status (PATCH — C-P6-01)
    ANALYTICS:      '/admin-api/analytics',
    LOSS_STATS:     '/admin-api/analytics/trends',
    SIMULATE_START: '/admin-api/simulation/start',
    SIMULATE_STOP:  '/admin-api/simulation/stop',
    THRESHOLDS:     '/admin-api/thresholds',
    AUDIT_LOGS:     '/admin-api/audit-logs',
  }),

  NOTIFICATIONS: Object.freeze({
    LIST:           '/notification-api/notifications',
    MARK_READ:      '/notification-api/notifications',           // append /:id/read (PATCH — C-P6-02)
    MARK_ALL_READ:  '/notification-api/notifications/read-all',  // PATCH (declared before /:id/read — Phase 4 D-P4-13)
    UNREAD_COUNT:   '/notification-api/notifications/unread-count',
  }),
});

// ─── Pagination Defaults ──────────────────────────────────────────────────────
// Phase 4 D-P4-12: three-tier pagination strategy
// C-P6-06: added DEFAULT_LIMIT_ADMIN

export const PAGINATION = Object.freeze({
  DEFAULT_PAGE:           1,
  DEFAULT_LIMIT_STANDARD: 10,   // customer endpoints
  DEFAULT_LIMIT_CASES:    20,   // analyst + notification endpoints
  DEFAULT_LIMIT_ADMIN:    50,   // admin endpoints (D-P4-12)
});

// ─── Case workflow (mirrors the server, which enforces it and answers 400 otherwise) ──
export const STATUS_TRANSITIONS = Object.freeze({
  OPEN:         [],
  ASSIGNED:     ['UNDER_REVIEW', 'DISMISSED'],
  UNDER_REVIEW: ['RESOLVED', 'DISMISSED'],
  RESOLVED:     [],
  DISMISSED:    [],
});
