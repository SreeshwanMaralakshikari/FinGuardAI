# FinGuardAI: Architecture, API and demo script

## Data model (MongoDB, Mongoose)

```mermaid
erDiagram
    USER ||--o{ TRANSACTION : "makes (userId)"
    TRANSACTION ||--o| FRAUD_ALERT : "raises (transactionId, unique)"
    FRAUD_ALERT ||--o| FRAUD_CASE : "is investigated in (fraudAlertId, unique)"
    USER ||--o{ FRAUD_CASE : "is assigned (assignedAnalystId)"
    USER ||--o| BEHAVIOR_PROFILE : "has (userId)"
    DEVICE_REPUTATION }o--o{ USER : "seen with (associatedUserIds)"
    TRANSACTION }o--|| DEVICE_REPUTATION : "uses (deviceId)"
    USER ||--o{ NOTIFICATION : "receives (recipientId)"
    USER ||--o{ AUDIT_LOG : "acts (actorId)"
    SYSTEM_CONFIG ||--|| SYSTEM_CONFIG : "singleton"
```

| Collection | Purpose | Notes |
|---|---|---|
| User | Account, role (CUSTOMER / ANALYST / ADMIN), trust score | `password` is `select:false` and stripped by `toJSON`; `sessionsRevokedAt` ends sessions on deactivation; `isSimulated` marks demo users |
| Transaction | One payment with its fraud score, reasons and per-rule `scoreBreakdown` | Public id `TXN-YYYY-NNNNN`; status APPROVED / HELD / BLOCKED; optional `idempotencyKey` (hidden) |
| FraudAlert | Raised for MEDIUM, HIGH, CRITICAL | One per transaction (unique); status OPEN / REVIEWED / DISMISSED / ACKNOWLEDGED |
| FraudCase | Analyst investigation | Public id `CASE-YYYY-NNNNN`; OPEN → ASSIGNED → UNDER_REVIEW → RESOLVED (fraud confirmed) or DISMISSED (false positive) |
| BehaviorProfile | Learned usual amounts, cities, hours, devices of a customer | Built from the newest 500 trusted transactions |
| DeviceReputation | Score and flags per device id | Shared across users; created only while a user is below `MAX_DEVICES_PER_USER` |
| Notification | In-app messages (live over Socket.io) | TTL `NOTIFICATION_TTL_DAYS` (default 90) |
| AuditLog | Who did what | Append-only (update/delete hooks reject changes); optional TTL via `AUDIT_LOG_TTL_DAYS` |
| SystemConfig | Thresholds, velocity limits, high-risk merchants | Singleton; compare-and-set updates |

## Request flow for a payment

`POST /customer-api/transactions` → validators → per-user lock → `services/transactionService.processTransaction`: idempotency replay check → load profile, device reputation and live velocity counts → `checkFraud` (pure function, no database) → create transaction with sequential id → alert (HIGH/CRITICAL/MEDIUM) → device reputation, trust score, behaviour profile → audit + notifications + Socket.io events. The admin demo-data generator calls the same service.

## API summary (all JSON, cookie auth; `/health` is public)

| Area | Method and path | Role |
|---|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/check-auth`, `PATCH /auth/change-password` | public / any |
| Customer | `POST /customer-api/transactions` (optional `Idempotency-Key`), `GET /customer-api/transactions`, `GET /customer-api/transactions/:id` | CUSTOMER |
| | `GET /customer-api/fraud-alerts`, `GET /customer-api/fraud-alerts/:id`, `PATCH /customer-api/fraud-alerts/:id/acknowledge` (MEDIUM only) | CUSTOMER |
| | `GET /customer-api/timeline`, `GET /customer-api/trust-score`, `GET/PATCH /customer-api/profile` | CUSTOMER |
| Notifications | `GET /notification-api/notifications`, `PATCH .../read-all`, `GET .../unread-count`, `PATCH .../:id/read` | CUSTOMER, ANALYST |
| Analyst | `GET /analyst-api/flagged-transactions`, `GET .../flagged-transactions/:id` (HIGH/CRITICAL only) | ANALYST |
| | `POST /analyst-api/cases`, `GET /analyst-api/cases`, `GET .../cases/:id`, `PATCH .../cases/:id/assign`, `PATCH .../cases/:id/status`, `POST .../cases/:id/notes` | ANALYST |
| | `GET /analyst-api/devices/:deviceId`, `GET /analyst-api/fraud-patterns` | ANALYST |
| Admin | `GET /admin-api/users`, `PATCH /admin-api/users/:id/status` | ADMIN |
| | `GET /admin-api/analytics`, `GET /admin-api/analytics/trends` (with 7-day forecast) | ADMIN |
| | `GET/PATCH /admin-api/thresholds`, `POST /admin-api/thresholds/preview` | ADMIN |
| | `POST /admin-api/simulation/start`, `.../stop`, `.../generate`, `DELETE .../simulation/data` | ADMIN |
| | `GET /admin-api/audit-logs` | ADMIN |

Errors use `{ success:false, message, errors? }`. Validation errors are HTTP 422; a dead (deactivated) session is 401 with `code:'ACCOUNT_DEACTIVATED'`.

## Three-minute demo script
1. **Admin** logs in (seeded account) → Simulation → *Generate demo transactions* (30) → Dashboard: KPIs, risk distribution, score histogram, top devices, high-risk by city and payment method; set a date range.
2. **Customer** (`npm run seed:demo` accounts or register) → Submit a normal payment (approved, score 0) then a risky one (new city, large amount, new device) → see the score breakdown, the HELD/BLOCKED status, then *Fraud alerts → Timeline*. Acknowledge a MEDIUM alert.
3. **Analyst** → Flagged transactions → Investigate (device reputation, breakdown) → Open case → Assign to me → Start review → Resolve (fraud confirmed: payment becomes BLOCKED) or Dismiss (released). Export CSV.
4. **Admin** → Trends (forecast), Thresholds → *Preview impact*, Audit logs, User management (deactivate a user: their open tab is signed out with a clear message) → Simulation → *Clear demo data*.
