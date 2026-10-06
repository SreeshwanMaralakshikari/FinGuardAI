# FinGuardAI Frontend: Build Notes

## What was built

Everything Phase 7 specified that the zip was missing, on top of the existing Phase 6 foundation (store, api, hooks, utils).

| Area | Files |
|---|---|
| Pages (22) | `auth/` Login, Register · `shared/` NotFound, Unauthorized, Account · `customer/` Dashboard, TransactionHistory, FraudAlerts, SubmitTransaction, TrustScore, Profile · `analyst/` Dashboard, FlaggedTransactions, CaseManagement, CaseDetail, DeviceReputation, FraudPatterns · `admin/` Dashboard, Trends, UserManagement, SimulationPanel, ThresholdConfig, AuditLogs |
| Layouts (3) | CustomerLayout, AnalystLayout, AdminLayout (each starts the notification feed once and uses the shared AppShell) |
| Shared components | AppShell, Navbar, Sidebar, AuthShell, NotificationPanel, ChangePasswordForm |
| Common components | Icon, ErrorBoundary, Spinner, EmptyState, PageHeader, StatCard, Pagination, Badges, Modal, FormField, Alert, DetailRow, ScoreBar |
| Charts | BarCard, TrendChart (recharts, each with a "View as table" fallback) |
| Utils and hooks | `utils/forms.js`, `device.js`, `dates.js`, `navigation.js`, `hooks/useFetch.js` |
| Routing | `App.jsx` rewritten: layout routes per role, corrected import paths, routes for Profile, Account, FraudPatterns and Trends |
| Assets | `public/favicon.svg` (index.html referenced a missing file) |

## Verification

- `npx eslint src`: clean (0 errors, 0 warnings).
- `npx vitest run`: 33 files, 296 tests pass (see `FIX_LOG.md` for the later rounds).
- `vite build` (production mode): succeeds; every page is its own lazy chunk.
- Live run against the real backend (Express + Mongoose via FerretDB), driven with a headless browser:
  - All 19 role pages load without console errors, failed requests or error boundaries.
  - Flows exercised: transaction submit and validation, notifications panel, profile rename, logout, investigate and open case, assign, add note, start review, resolve (closed case becomes read-only), device lookup 404 state, thresholds save and invalid-order validation, user deactivate, simulation start and stop, audit logs, change-password validation.

## Deviations from Phase 7 (the real API wins)

1. **Transaction submit** sends the required `deviceId` (one stable id per browser, kept in localStorage) and strips blank optional fields (`merchantCategory`, `location.*`), because the validator rejects empty strings. The result is read as a flat object.
2. **Validation errors** use `errors[0].msg` (422) and then `message` (business errors); Phase 6's `errors.js` read the wrong field.
3. **Customer alerts** read the populated `transactionId` object and filter by `status` and `riskLevel`.
4. **Flagged transactions** omit `riskLevel` by default, so the backend returns HIGH and CRITICAL; the investigate view uses `{transaction, deviceReputation, fraudAlert, existingCase}`.
5. **Cases**: list and detail are populated; assign and note POSTs return bare ids, so the slice rebuilds the populated shape from the signed-in user; RESOLVED and DISMISSED require a `resolutionSummary` (modal); closed cases are read-only; the status buttons follow OPEN → ASSIGNED → UNDER_REVIEW → RESOLVED/DISMISSED on the client.
6. **Admin dashboard** uses the real analytics shape (`fraudRate` already a percent, sparse `fraudByHour`, `lossPrevented`, `openCases`, `openAlerts`) and a separate Trends page (31 zero-filled days plus `peakFraudHours`).
7. **User management** uses `PATCH /users/:id/status` with `{isActive}`; ADMIN rows are not deactivatable (the API returns 403).
8. **Simulation** only broadcasts start and stop over the socket. The UI says so and lists real alerts that arrive while it runs, instead of pretending to create transactions.
9. **Profile** is customer-only multipart (`profileImage`, `name`); analysts and admins get the shared Account page (change password).
10. **Notifications** are wired for CUSTOMER and ANALYST only.
11. **Date filters** send explicit Asia/Kolkata day bounds, because the backend parses `YYYY-MM-DD` as midnight UTC and uses `$lte`.
12. **Pages added beyond Phase 7's list**: FraudPatterns, AdminTrends, Profile, Account (routes existed in the API or navigation but had no page).
13. **Login and ThresholdConfig** keep the contracts of the existing page tests; the two tests themselves were rewritten (see below).

## Frontend defects fixed in this round

- `vitest.config.js`: added `esbuild: { jsx: 'automatic' }` (page tests failed with `React is not defined`).
- ESLint: added `eslint.config.js`, the missing devDependencies, and a working `lint` script.
- `errors.js`: reads `errors[0].msg`.
- `common.js`: `formatDate` and `formatDateShort` no longer throw on invalid dates.
- Slices: stale `selectedTransaction`, `selectedAlert`, `selectedFlagged` and `selectedCase` cleared on `pending`; `simulationSlice` no longer flips `isRunning` when start is rejected; `fraudCaseSlice` keeps populated shapes after assign and note and no longer inserts an unpopulated case into the list; `analyticsSlice` has its own `lossLoading`.
- `useSocket.js`: simulation events are recorded only while a simulation is running.
- `App.jsx`: wrong NotFound and Unauthorized import paths, missing layout routes, and a hand-rolled loader.
- `LoginPage.test.jsx` and `ThresholdConfig.test.jsx` rewritten: they used ambiguous regex queries and re-implemented `getNestedError` locally instead of testing the real helper.

## Status of the items listed here at build time

The lockfiles, `.gitignore`, `sourcemap: false`, the backend fixes and the axios/deployment items from the first review were handled in later rounds; see `FIX_LOG.md` (what was fixed, and what is still open on purpose). The analytics group-label question (`$_id` on FerretDB) was a FerretDB artefact; check the payment-method and city charts once on real MongoDB. The Flagged Transactions table still scrolls horizontally on screens narrower than about 1300 px.

## Run it

```
npm ci
npm run dev            # needs the backend on :5000 (or VITE_DEV_BACKEND_URL)
npm run lint && npm test
VITE_API_URL=https://your-api npm run build
```
