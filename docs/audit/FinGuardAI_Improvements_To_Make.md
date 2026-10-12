# FinGuardAI — Improvements To Make (Audit of the Current Zip)

**Audited file:** `FinGuardAI_Complete_Phase_1-9_Files_Current_Version.zip` · **Date:** 7 Oct 2026
**Companion file:** `FinGuardAI_Errors_Found.md` (the 23 errors, E-01 … E-23).

These are changes that are **not bugs** but would make the project safer, more complete against your Phase 1 plan, easier to demo and easier to maintain. Nothing has been changed yet. Each item has a priority (High / Medium / Low) and an effort (S = under an hour, M = a few hours, L = a day or more). Items were collected in passes 1 and 2 and checked against the code in pass 3.

## Quick view

| Group | Items |
|---|---|
| A. Phase 1 spec gaps (what the plan promised) | A-01 … A-09 |
| B. Fraud engine and case workflow | B-01 … B-08 |
| C. Reliability and data | C-01 … C-09 |
| D. Security hardening | D-01 … D-10 |
| Frontend UX, accessibility, performance | F-01 … F-12 |
| Tests | T-01 … T-06 |
| Docs and developer experience | G-01 … G-08 |
| Code cleanup and dependencies | H-01 … H-12 |

**Suggested order if you want the best demo and viva value for the least work:** A-01 (by-device chart), A-02 (timeline), B-01 (explainability bars), A-08/B-07 (real simulation or demo generator), A-03 (case-status notifications), B-02 (confirmed-fraud outcome), G-01 (docs), then the reliability and security items.

Things already accepted by you and **not** listed as improvements: MEDIUM risk stays APPROVED and does not train the baseline; ANALYST registration needs `ANALYST_INVITE_CODE`; the cookie modes.

---

## A. Phase 1 spec gaps (plan vs. implementation)

I went through every objective, requirement, NFR and the service contract in the Phase 1 plan. Implemented and correct: real-time detection on submit (O-01), score 0–100 with four levels and reasons (O-02), the case lifecycle (O-04), all six rules, zero side effects in the service, auth, history, alerts, trust score, notifications, device reputation, pattern links, user management, audit logs, thresholds, the eight collections and the public ids.

### A-01 — By-device analytics is missing (O-05) · Priority High · Effort S–M
`/admin-api/analytics` has hour, payment method and city, but no device aggregate. The frontend also names the payment-method data `fraudByDevice` (`analyticsSlice.js:99`, `AdminDashboard.jsx:42`), which is misleading.
**Do:** add an aggregate of HIGH/CRITICAL transactions grouped by `deviceId` (top 10 with `userCount`) and a `BarCard` on the dashboard; rename the slice field to `fraudByPaymentMethod`. Also add the analytics date-range filter the API already supports (`startDate`/`endDate`) and a risk-score histogram.

### A-02 — Customer "fraud event timeline" is missing · Priority High · Effort M
Phase 1 lists a fraud event timeline for customers (and "Fraud Timeline Visualization" in scope). `FraudAlerts.jsx` is a flat list.
**Do:** `GET /customer-api/timeline` merging transactions, alerts and case-outcome notifications by time; render a vertical timeline on the alerts page or dashboard.

### A-03 — "Case status changed" notification to analysts is partial · Priority Medium · Effort S
`CASE_STATUS_CHANGED` is sent only to the previous analyst on reassignment (`AnalystAPI.js:~311`). Moves to UNDER_REVIEW / RESOLVED / DISMISSED notify only the customer (`caseWorkflow.js:~133`).
**Do:** after the guarded update at `AnalystAPI.js:~384`, notify the assigned analyst (and optionally all analysts when a case closes or opens).

### A-04 — "Fraud trend predictions" is only a 7-day moving average · Priority Medium · Effort M
`AdminAPI.js:~236-246` computes a moving average; `AdminTrends.jsx:7` admits there is no forecasting model.
**Do:** add a simple 7-day projection (least-squares or exponential smoothing) to `/analytics/trends` and draw it as a dashed series in `TrendChart`, with the method named.

### A-05 — `locationDeviationKm` is a dead setting · Priority Medium · Effort S (remove) or M (use)
The admin can edit "Location deviation (km)" (`ThresholdConfig.jsx`, `AdminAPI.js:363`) but the engine compares city names only. The hint says "stored for later", but an editable control with no effect confuses users.
**Do:** either hide it until used, or add a small city → latitude/longitude table and use distance in `locationCheck`.

### A-06 — Payment-method deviation is stored but never scored (O-03) · Priority Low · Effort S–M
`usualPaymentMethods` is built into the behaviour profile but no rule reads it.
**Do:** add a seventh rule (about +10) with a new signal type in the `FraudAlert.alertType` enum, or stop storing it.

### A-07 — Performance NFR (< 200 ms) is not measured · Priority Low · Effort S
**Do:** a unit test that runs 1,000 `checkFraud` calls and asserts a small average; an integration test that checks `POST /transactions` stays under 200 ms on the test DB (generous bound to avoid flakiness).

### A-08 — Simulation mode is a flag only (accepted gap) · Priority High for demos · Effort M
The panel only broadcasts `simulation_start`/`stop` and creates nothing, so the dashboard stays empty during a viva.
**Do:** an admin "generate N synthetic transactions" action that runs the real `checkFraud` path with seeded customers and mixed scenarios, emits real alerts over the socket, and can be cleaned up. (Your `seedDemoData.mjs` script already covers the data side; this would make it live and repeatable from the UI.)

### A-09 — Smaller spec deviations to document or close · Priority Low · Effort S
- The service output has an extra `signals` field (compatible, but document it so a future ML replacement also returns it).
- Individual read is `PATCH /notifications/:id/read`, not `PATCH /notifications` as the plan phrased it. Update the plan or the docs.
- "No business logic in routes": `CustomerAPI.js:68-262` holds the whole submit orchestration. Moving it to a `transactionService` would also make it unit-testable.
- "No hardcoded values": rule weights, `LOSS_MULTIPLIER`, `BLACKLIST_BELOW=30` and trust/reputation priors are constants in code (move to `config/fraudWeights.js` or `SystemConfig`).
- "All Tailwind in `common.js`": `Sidebar.jsx:13-14` defines its own class constants.
- Observability: analyst reads of another customer's transaction (`AnalystAPI.js:101`, `:471`) and logins with an unknown email are not audited.

---

## B. Fraud engine and case workflow

### B-01 — Show *why* a score is what it is · Priority High (demo) · Effort S–M
Return per-rule `{rule, points, max}` from the service and render a stacked bar or waterfall ("why 62/100") on the customer, analyst and case pages. The data is already computed inside each rule.

### B-02 — Give "confirmed fraud" a final state · Priority Medium · Effort S–M
`RESOLVED` leaves the transaction `HELD` forever (`caseWorkflow.js:~49-69`), so the customer never sees a final outcome. Add a confirmed-fraud outcome that moves the payment to `BLOCKED` and bumps the device flag, or a new `CONFIRMED_FRAUD` status.

### B-03 — Teach the baseline when an analyst dismisses a false positive · Priority Medium · Effort M
Only APPROVED+LOW transactions train the profile (`calcBehaviorProfile.js:62`), so a legitimate customer is flagged again for the same new city/device after a DISMISSED release. Probe confirmed: the same odd transaction is HIGH again after dismissal. Include DISMISSED-alert transactions when rebuilding the profile.

### B-04 — Alert status "REVIEWED" is set too early · Priority Low · Effort S
`POST /cases` sets the alert to REVIEWED (`AnalystAPI.js:~178`) while the case is only OPEN. Keep it OPEN until the case is assigned or closed.

### B-05 — Real OTP step for MEDIUM · Priority Low · Effort M
The recommended action "OTP" does nothing today. A demo OTP screen (code shown in a toast or notification) would make the action ladder real. Also "Was this you?" confirm/dispute buttons for HELD payments (customers currently have no action).

### B-06 — Harden the engine · Priority Low · Effort S
- `fraudDetectionService.js:~241-254`: an explicit `null` in stored thresholds overrides the defaults (a stored `maxPerHour: null` flags every payment with "limit: null"). Merge per field with `??`.
- Add model-level checks that `mediumMin < highMin < criticalMin` and `maxPerDay >= maxPerHour` (this also closes E-16).
- A blacklisted device with reputation 10 and a clean first transaction scores 46 (MEDIUM, approved): a blacklist never blocks on its own (`fraudDetectionService.js:162-171`). Decide whether a blacklisted device should be an automatic BLOCK.
- "Usual hours = top 3" is noisy: any other hour scores +10, so ordinary evening payments drift toward MEDIUM. Consider a wider window or a decay.
- Add rules for the sub-problems named in Phase 1 (UPI first-time-payee / collect-request, card-not-present and small test charges).

### B-07 — What-if threshold preview · Priority Low · Effort M
On the Thresholds page, re-score the last N transactions with the proposed values and show how many would move up or down before saving.

### B-08 — Money precision · Priority Low · Effort M
Amounts and loss totals are doubles, so `$sum` can show float noise. Store paise as integers or use Decimal128 (touches validators, model, UI formatting).

---

## C. Reliability and data

### C-01 — Idempotency for payments · Priority High · Effort M
A Render cold-start timeout followed by a client retry can create a duplicate payment (the server may have saved the first). Frontend: generate a UUID when the form is shown and send it as `Idempotency-Key`, reuse on retry. Backend: store it on the transaction with a unique `(userId, key)` index and return the original result on replay. At minimum, on an error without `err.response`, tell the user to check Transaction history before retrying.

### C-02 — Log index-build failures and make the alert unique · Priority Medium · Effort S
See E-17. Also make `{transactionId:1}` unique on `FraudAlert`: the insert retry in `CustomerAPI.js:~169` can create two alerts if the first insert succeeded but threw (the index is non-unique).

### C-03 — `unhandledRejection` kills the server · Priority Medium · Effort S
`server.js:140-156` exits on a single unhandled rejection. On Render free that means a cold restart of about a minute for every user. No unhandled promises exist today, but one future one would take the service down. Log and keep running; keep exit on `uncaughtException`.

### C-04 — Retention for audit logs and notifications · Priority Medium · Effort S
Each payment writes 2–4 audit documents; the Atlas free tier is 512 MB. Add TTL indexes (for example notifications 90 days). If audit logs must be kept, archive instead.

### C-05 — Index clean-up · Priority Low · Effort S
Drop unused indexes: `User {email:1, role:1}`, `DeviceReputation {reputationScore:1}`, `Transaction {riskLevel:1, status:1}`. Add `User {createdAt:-1}` (the admin users list sorts on it) and `Transaction {status:1, timestamp:-1}` (the loss-prevented aggregation).

### C-06 — Pagination stability · Priority Low · Effort S
Sorts on `timestamp`, `createdAt`, `openedAt` and `peakFraudHours` have no tie-break. Add `_id: -1` so skip/limit paging cannot repeat or drop rows on ties.

### C-07 — Per-submit cost · Priority Low · Effort M
`calcBehaviorProfile` loads the user's whole trusted history on every LOW submit; `updateTrustScore` and `updateDeviceReputation` each run three `countDocuments`. Use one `$group` aggregation and bound the profile window (last N days or N transactions). `generateSequentialId` runs two regex lookups and two writes per id: do the counter catch-up once at startup or only after a duplicate-key error.

### C-08 — Unbounded growth from client-chosen device ids · Priority Low · Effort S–M
Each new `deviceId` creates a `DeviceReputation` document and registration is open, so a script can grow the collection (30/min per account). Cap distinct devices per user, or create the reputation row only after N sightings.

### C-09 — Re-activation revives old sessions · Priority Medium · Effort S
Only `isActive` is checked, so after reactivation a stolen cookie issued before the deactivation works again (`AdminAPI.js:87`, `verifyToken.js`). Store `sessionsRevokedAt` on deactivation and feed it into `isTokenRevoked`. (Pairs naturally with E-01.)

---

## D. Security hardening

### D-01 — Content-Security-Policy and Permissions-Policy · Priority Medium · Effort S
`vercel.json` has no CSP. Because the API uses cookie auth, a CSP is a cheap XSS defence. Suggested: `default-src 'self'; connect-src 'self' https://<api> wss://<api>; img-src 'self' data: https://res.cloudinary.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`. The API host is baked in at build time, so generate the header or document the edit.

### D-02 — Per-account login throttling · Priority Medium · Effort M
The login limiter is per IP only; distributed guessing against one account is unthrottled, and each attempt costs a bcrypt-12 hash (~250 ms). Add a per-email failed-login counter with a temporary lockout or delay.

### D-03 — Secure-by-default environment · Priority Low · Effort S
Anything other than `NODE_ENV=production` gives insecure cookies, localhost CORS origins and raw `err.message` in 500s (only `RENDER` is guarded). Invert the default so secure applies unless `NODE_ENV` is `development` or `test`.

### D-04 — Strip secrets in `toJSON` · Priority Low · Effort S
User safety rests on `select:false` alone. Add `toJSON/toObject` transforms that delete `password`, `passwordChangedAt` and `__v`, so a future `create()`/`save()` response cannot leak the hash.

### D-05 — Whitespace-only passwords · Priority Low · Effort S
`"        "` (8 spaces) registers (201). Require at least one non-whitespace character in `authValidators.js:~21` and the forms.

### D-06 — Expose rate-limit headers to the browser · Priority Low · Effort S
`corsOptions.js` has no `exposedHeaders`, so the frontend cannot read `RateLimit-*` or `Retry-After` on 429. Add them, and show "try again in N seconds".

### D-07 — `Cache-Control: no-store` on authenticated JSON · Priority Low · Effort S
Add it for `/auth`, `/customer-api`, `/analyst-api`, `/admin-api`, `/notification-api` in `app.js`.

### D-08 — Cloudinary upload limits · Priority Low · Effort S
In `utils/imageUpload.js:~55` add `allowed_formats`, a size-limiting transformation (for example 512 px) and `unique_filename` to `upload_stream`.

### D-09 — Make the audit log tamper-resistant · Priority Low · Effort S
It is described as immutable, but nothing prevents updates. Add `pre('updateOne' / 'findOneAndUpdate' / 'deleteMany')` guards, or use a collection-level DB role.

### D-10 — `PORT` and invite-code validation · Priority Low · Effort S
`validateEnv.js`: `PORT=abc` silently becomes 5000 (`Number(x) || 5000`); `ANALYST_INVITE_CODE` minimum length is enforced only in production although the README states it unconditionally. Reject a set but non-numeric `PORT`; enforce the length in every mode.

---

## Frontend UX, accessibility and performance (IDs F-xx)

### F-01 — Refetch notifications after a socket reconnect · Priority Medium · Effort S
After a reconnect (Render restart, network blip) the unread badge stays stale until reload (`useNotifications.js`). On the second and later `connect` events dispatch `fetchUnreadCountThunk()` (and a list refetch if the panel is open). Also stop retrying on an auth `connect_error` after the JWT expires.

### F-02 — MEDIUM alerts accumulate forever on the customer dashboard · Priority Medium · Effort S–M
MEDIUM alerts stay `OPEN` and analysts never see them, so "Open fraud alerts" only grows. Let the customer acknowledge a MEDIUM alert (new route), or count only HIGH and CRITICAL.

### F-03 — Better error messages when the server is unreachable · Priority Low · Effort S
`api/errors.js:18-24`: timeouts, network and CORS failures all fall back to per-thunk text ("Login failed", "Failed to fetch transactions"). When `!err.response`, return "Cannot reach the server — check your connection and try again."

### F-04 — Cold-visit console noise and bundle size · Priority Low · Effort S–M
Every logged-out visit logs a red `401` from `check-auth` (twice in dev under StrictMode). Return 200 with `data: null` for the session probe, or skip the call when no session-hint flag is set. `socket.io-client` (~40 kB) is in the entry bundle even for logged-out pages; lazy-import it inside the layouts.

### F-05 — Accessibility polish · Priority Low · Effort S
Skip-to-content link; move focus to the `h1` on route change; Modal should use `aria-labelledby` (visible `h2` exists); spinners should respect `prefers-reduced-motion` (`motion-reduce:animate-none`). Show a skeleton loader on tables instead of a bare spinner.

### F-06 — `ScoreBar` ignores custom thresholds · Priority Low · Effort S
Bar colours use fixed 25/50/75 bands, but admins can change `scoreThresholds`: a score of 45 can show a HIGH badge over a yellow bar. Pass the risk level (or live thresholds) into `ScoreBar.jsx`.

### F-07 — Abort stale requests, cap live notifications · Priority Low · Effort S
`useFetch` ignores a stale result but does not abort the HTTP request; pass an `AbortSignal`. `notificationSlice.addLiveNotification` grows unbounded while the panel is closed: cap at ~50 like the alerts list.

### F-08 — Admin dashboard does not refresh on live alerts · Priority Low · Effort S
KPIs stay static when a `fraud_alert` arrives. Debounce `fetchAnalyticsThunk` on that event.

### F-09 — Trust-score explainer · Priority Low · Effort S
Show the formula and contributing counts on `TrustScore.jsx`; the API returns only some of the inputs (known devices, usual hours).

### F-10 — Show "Unknown location" clearly · Priority Low · Effort S
Label missing cities in charts and tables (relates to E-06).

### F-11 — Analyst productivity · Priority Low · Effort S–M
SLA age on open cases, a "my queue" sort, bulk assign, CSV export of flagged transactions and cases.

### F-12 — Wide table on narrow screens · Priority Low · Effort S
The Flagged Transactions table scrolls horizontally below ~1300 px (already noted in your build notes). Consider a card layout on small screens.

---

## Tests (IDs T-xx)

### T-01 — Contract tests shared by backend and frontend · Priority Medium · Effort M
Every frontend page test mocks `api/axios.js` with hand-written fixtures, so no test checks real response shapes. Share fixtures between the suites, or add a few supertest-backed contract tests.

### T-02 — Raise frontend coverage where it matters · Priority Medium · Effort M
0 % coverage today for `ServerWakeGate`, `useNotifications`, `useSocket`, `ChangePasswordForm`, `Profile`, `TrustScore`, `FraudAlerts`, `AuditLogs`, `AdminTrends`, `FraudPatterns`, `Account`, `TrendChart`; `serverHealth` 56 %; `axios.js` branches 33 %. The enforced 80 % gate covers only `store/slices`, so overall coverage (~78 %) is invisible. Widen the threshold to `pages/**` once tests exist.

### T-03 — Tests for the errors in this audit · Priority Medium · Effort S–M
Add tests for: array `fraudAlertId`, the 0.01 boundary, deactivated-session handling (401 and the Navbar toast), an analyst reading a LOW transaction, reactivation after deactivation, newest-first cluster contents, case-insensitive grouping, impossible date-times, missing `location`.

### T-04 — Make time-dependent tests deterministic · Priority Medium · Effort S
Use fake timers/frozen clock for the IST-hour, `todayIST` and trend-window assertions (see E-20).

### T-05 — Fix the `MaxListenersExceededWarning` and speed up the suite · Priority Low · Effort S
Bind supertest to one server per file; find the leaking suite with `--trace-warnings`. The full backend suite takes ~5 minutes on FerretDB.

### T-06 — Backend lint · Priority Low · Effort S
The backend has no ESLint config or `lint` script. With strict rules only `no-unused-vars` and `no-implicit-coercion` hit real code. Add a small config and a `lint` script; in the frontend add `eslint-plugin-react`'s `jsx-uses-vars` and narrow `varsIgnorePattern` from `^[A-Z_]` to `^_`.

---

## G. Docs and developer experience (IDs G-xx)

- **G-01 (Medium, S)** Ship both `.env.example` files and fix the folder names (see E-02/E-03). Restore `FIX_LOG.md` (what was fixed, what is open on purpose).
- **G-02 (Low, S)** Add an API route table and an ER diagram to the README, plus a 3-minute demo script with seed accounts and the order of screens to show.
- **G-03 (Low, S)** Document every variable the code reads: `SKIP_ATOMICITY_TESTS` (test-only), `RENDER` (set by the platform), and that `TZ` is forced by `loadEnv.js`.
- **G-04 (Low, S)** Add a Vercel note: use one canonical production domain; preview and alias URLs are CORS-blocked by design. Optionally support a strict `FRONTEND_URL_PATTERN` for `*.vercel.app`.
- **G-05 (Low, S)** Troubleshooting lines for macOS port 5000 and `vite preview` (see E-21).
- **G-06 (Low, S)** Note in Phase 1/README that rate limiter and device reputation are per-instance in-process state (the per-user and per-device locks do not span multiple server instances): fine for one Render instance, a limit if scaled out.
- **G-07 (Low, S)** Add a README note to check for duplicate `fraudAlertId` cases before building the unique index on an existing database (E-17).
- **G-08 (Low, S)** Add `description`, `license`, `repository` to both `package.json` files.

---

## H. Code cleanup and dependencies (IDs H-xx)

### H-01 — Pagination block copied 7 times · Low · S
`{ page, limit, total, pages: Math.ceil(total / Number(limit)) }` at `AdminAPI.js:60,548`, `AnalystAPI.js:94,227`, `CustomerAPI.js:294,351`, `NotificationAPI.js:37`. Add `buildPagination(page, limit, total)` to `utils/pagination.js`.

### H-02 — Dead code, frontend · Low · S
Remove `truncate()` (`utils/common.js:223`, and its header comment at line 21), `TX_STATUSES` and `NOTIFICATION_TYPES` (`utils/constants.js:54,64`); drop `export` from `BADGE` (`common.js:163`), `NAME_MIN`, `NAME_MAX` (`forms.js:22-23`) and `PASSWORD_MAX_BYTES` (`forms.js:38`). Delete the empty `new-notification` listener in `hooks/useSocket.js:62-64` (and its mention in the header comment at line 6).

### H-03 — Dead code, backend · Low · S
The `transaction` parameter of `calcBehaviorProfile` (`utils/calcBehaviorProfile.js:54`) is never read; remove it and its three call sites (`CustomerAPI.js:221`, `tests/transactions.test.js:279,291`). Drop the unused `export default checkFraud` (`fraudDetectionService.js:321`). The stored `transactionVelocity` in the behaviour profile is never read (live counts replace it): drop it or document it as legacy.

### H-04 — Unneeded exports, backend · Very low · S
Only used inside their own file: `getCookieMode`, `getAllowedOrigins`, `OPEN_STATUSES`, `ALLOWED_TRANSITIONS`, `PROFILE_FOLDER`, `MAX_PAGE_LIMIT`, `MAX_PAGE`, `ADMIN_ONLY_EVENTS`, and the test helpers `nextIp`, `isEmulatedDb`.

### H-05 — Use `Number()` instead of unary `+` · Very low · S
`utils/dateRange.js:58-59` (7 `no-implicit-coercion` hits).

### H-06 — Split the biggest functions · Low · M
`CaseDetail.jsx:40` (242 lines, complexity 41), `SubmitTransaction.jsx:42` (183 lines), `FlaggedTransactions.jsx:37` (179 lines, complexity 39), `DeviceReputation.jsx:24` (complexity 29), `routes/AdminAPI.js:436` (complexity 34), `config/validateEnv.js:36` (complexity 35).

### H-07 — Validate query/body enums in one place · Low · S
Create shared `isIn` validators for statuses and risk levels so routes and validators stop duplicating the lists (supports E-14).

### H-08 — Zip packaging · Very low · S
Re-zip with file mode 644 / directory 755 and without `frontend/.env`.

### H-09 — Dependency upgrades (only when convenient) · Info
Dev-only: `vitest`/`@vitest/coverage-v8` (advisories, E-22). Majors available but **not needed**: `dotenv` 18, `express-rate-limit` 8 (its docs mention changes to `keyGenerator` and IPv6 options, so upgrade deliberately), `recharts` 3, `eslint` 10. `vite` has a patch release (8.3.3).

### H-10 — Duplicate UI markup · Very low · S
`NotFound` and `Unauthorized` share almost identical layout; a small shared component removes ~0.5 % duplication (jscpd found only 5 clones in total, so this is optional).

### H-11 — Remove an unused ESLint-disable comment · Very low · S
An unused `eslint-disable` comment at `errorHandler.js:24` is harmless; remove it.

### H-12 — `check-auth` handler wrapper · Very low · S
`routes/CommonAPI.js:192` wraps a synchronous handler in `asyncHandler`; harmless, but the wrapper can go.

---

## What is already good (so you can say so in the viva)

Layered security (helmet, origin guard, CORS allowlist, HttpOnly Partitioned cookies, rate limits, strict schemas, bcrypt 12, password-change revocation), no injection or mass-assignment paths, atomic case updates with an idempotent audit trail, per-user and per-device locks, a side-effect-free pure fraud engine with a clear contract, IST-correct date handling, 231 backend and 297 frontend tests passing, a clean production build, a build guard on `VITE_API_URL`, and a frontend/backend contract that matches field for field.
