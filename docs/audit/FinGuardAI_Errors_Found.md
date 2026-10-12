# FinGuardAI — Errors Found (Audit of the Current Zip)

**Audited file:** `FinGuardAI_Complete_Phase_1-9_Files_Current_Version.zip`
**Audit date:** 7 Oct 2026 · **Mode:** find-only (nothing was changed in your code)

## How this audit was done

Three passes, each with different reviewers and a different angle:

1. **Pass 1 — four independent reviewers:** (a) backend security and API surface, (b) fraud engine, models, aggregations and utilities, (c) the whole frontend plus a real browser run of all three roles, (d) packaging, deployment and cross-module wiring.
2. **Pass 2 — three more reviewers:** (a) an adversarial verifier that tried to refute every pass-1 error and hunted for misses, (b) a spec-conformance review against your Phase 1 plan, (c) static-analysis tooling (knip, madge, depcheck, strict ESLint, jscpd, import-resolution script, `npm audit`/`outdated`).
3. **Pass 3 — my own verification:** I re-read the code for every item below and re-ran the key probes. Items marked **Confirmed (ran)** were reproduced against the running code; **Confirmed (read)** were confirmed by reading the code; **Plausible** were reported by a reviewer who ran it, but I only read the code.

Baseline results on your zip: backend tests **231/231 pass**, frontend tests **297/297 pass**, ESLint clean, `vite build` OK, `node --check` on all 68 backend files OK, **no circular imports**, **every import resolves**, `npm audit --omit=dev` reports **0 vulnerabilities** in both apps. In other words: there are **no crashing or syntax errors**. What follows are logic, contract, security-hardening and documentation defects.

Note: the backend tests were run on FerretDB (a MongoDB-compatible engine), because a real MongoDB binary could not be downloaded in my environment. Two items are flagged where real MongoDB behaviour should be re-checked once.

## Summary

| Severity | Count | IDs |
|---|---|---|
| Medium | 4 | E-01, E-02, E-03, E-04 |
| Low–Medium | 2 | E-05, E-06 |
| Low | 17 | E-07 … E-23 |
| **Total** | **23** | |

Recommended fix order: E-02/E-03 (docs and packaging, 20 minutes), E-01, E-04, E-05, E-06, then the Low items in batches.

---

## Medium

### E-01 — A deactivated user's live session gets 403, which the frontend never handles
- **Where:** `backend/middleware/verifyToken.js:62-64`, `frontend/src/api/axios.js:95-107`, `frontend/src/store/slices/authSlice.js` (`logoutThunk`), `frontend/src/components/shared/Navbar.jsx:~189-197`.
- **Problem:** when an admin deactivates a signed-in user, every later request returns `403 "Account has been deactivated"`. The axios interceptor only handles 401, so the user stays on the page with failing calls and a Retry button; there is no redirect to login. Clicking *Sign out* calls `/auth/logout`, which also returns 403 for that user, so `logoutThunk` is rejected and the toast says "The server could not be reached, so your session may stay active". That message is false: the server did clear the cookie.
- **Evidence:** Confirmed (ran) by two reviewers and in the browser. `grep deactivat frontend/src` finds only admin UI strings.
- **Fix:** return 401 with a code such as `ACCOUNT_DEACTIVATED` from `verifyToken` (keep 403 on `/auth/login`), or make the interceptor treat a 403 matching `/deactivated/i` like 401. In `Navbar.onLogout`, show the "could not be reached" toast only when `err.response` is absent (any HTTP response means the server answered). Update `tests/auth.test.js:~386` and `tests/config.test.js:~228`; add interceptor and Navbar tests.

### E-02 — `backend/.env.example` is missing (README step 1 fails); the frontend env template is a gitignored `.env`
- **Where:** `README.md:20-24,41`, `backend/` (no template), `frontend/.env`, `backend/.gitignore` (whitelists `.env.example`), `frontend/.gitignore` (ignores `.env`).
- **Problem:** README says `cp .env.example .env` and that `.env.example` "has comments for each variable". Neither file exists. A clean checkout cannot start: `validateEnv` stops with "JWT_SECRET is missing". The only frontend documentation of env vars is a comments-only file named `.env`, which `.gitignore` drops on the first commit.
- **Evidence:** Confirmed (read) by three reviewers (`find . -name '.env*'` returns only `frontend/.env`).
- **Fix:** add `backend/.env.example` (required: `MONGODB_URI`, `JWT_SECRET`, `FRONTEND_URL`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`; optional: `ANALYST_INVITE_CODE`, `COOKIE_MODE`, `COOKIE_DOMAIN`, `APP_TIME_ZONE`, `TRUST_PROXY`, `PORT`; seed-only: `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD`). Use placeholders that still trip `validateEnv`'s "replace-with / change-me" check. Rename `frontend/.env` to `frontend/.env.example`.

### E-03 — README/docs point to folders and files that do not exist
- **Where:** `README.md:6-9,19,22,24,29,35,52,55-57,63-64`, `docs/FRONTEND_BUILD_NOTES.md:21,34,43,56`.
- **Problem:** the docs use `finguardai-backend/` and `finguardai-frontend/`, but the zip folders are `backend/` and `frontend/`; every `cd` command and the Render/Vercel "root directory" instructions fail as written. README lines 9 and 64, and the build notes, refer to `FIX_LOG.md`, which is not in the zip. README line 19 refers to `finguardai-backend/.nvmrc`.
- **Evidence:** Confirmed (read).
- **Fix:** pick one layout and make everything match (rename the folders, or edit the docs and the `.gitignore` comments). Restore or remove the `FIX_LOG.md` references.

### E-04 — Fraud-pattern clusters show an arbitrary 10 transactions, often not the newest
- **Where:** `backend/routes/AnalystAPI.js:~513-540` (all three aggregations).
- **Problem:** each cluster pushes transactions with `$push` and then shows `$slice: ['$transactions', 10]`, but there is no `$sort` before the `$group`. For a cluster with more than 10 transactions the 10 shown depend on storage order, so the newest can be missing. Group documents also grow without bound (16 MB limit risk at scale).
- **Evidence:** Confirmed (ran): 12 HIGH transactions on one device returned `count 12` with amounts 1000–1009; the newest two (1010, 1011) were missing. Real MongoDB order depends on the index chosen, so it is not reliably "newest" there either.
- **Fix:** add `{ $sort: { timestamp: -1, _id: -1 } }` before each `$group` (or use `$firstN`/`$topN` on MongoDB 5.2+). Add a test that asserts newest-first contents (the current test only checks status 200).

---

## Low–Medium

### E-05 — Analyst can open any customer's LOW/MEDIUM transaction, and open a case on a MEDIUM alert
- **Where:** `backend/routes/AnalystAPI.js:104` (`findById`), `POST /cases` (~134-196), `validators/caseValidators.js`.
- **Problem:** the list endpoint shows only HIGH/CRITICAL, but `GET /flagged-transactions/:id` has no risk filter. Any analyst who knows an id gets the full document: customer email, IP, device and the device's associated users. `POST /cases` also accepts a MEDIUM alert (201), which contradicts the AUD-38 comment that MEDIUM never enters the analyst queue. No customer data leaks to other customers; this is analyst over-exposure (least privilege).
- **Evidence:** Confirmed (ran) by three reviewers.
- **Fix:** `findOne({ _id, riskLevel: { $in: ['HIGH','CRITICAL'] } })` and 404 otherwise; require HIGH/CRITICAL in `POST /cases`. Add negative tests.

### E-06 — Omitting `location` silently disables the location rule
- **Where:** `backend/validators/transactionValidators.js:34-48` (`location` optional), `models/TransactionModel.js:7` (default city `'Unknown'`), `services/fraudDetectionService.js:135` (skips `'unknown'`).
- **Problem:** a transaction posted without `location` scores 0 for the location rule and is stored with city "Unknown". A client can therefore avoid the unusual-city signal just by leaving the field out. Admin city charts also show an "Unknown" bucket.
- **Evidence:** Confirmed (ran): Lagos after a Mumbai profile scores +15; with `location.city: 'Unknown'` the score is 0 with no reasons.
- **Fix:** require `location.city` in the validator (the web form always sends it), or treat a missing city as its own "unknown location" signal. Add a test.

---

## Low

### E-07 — Amount validator and model disagree (0.01 minimum, unlimited decimals)
- **Where:** `validators/transactionValidators.js:14-17` (`gt: 0`), `models/TransactionModel.js:29` (`min 0.01`), frontend `SubmitTransaction` form (`v > 0`).
- **Problem:** amounts 0.005, 0.001 or "0.009" pass the validator but fail the model, and the customer sees "Amount must be greater than 0" — false for 0.005. The error body also has a different shape (no `type`/`location`). Amounts like `100.123456789` are stored unrounded.
- **Evidence:** Confirmed (ran).
- **Fix:** `isFloat({ min: 0.01, max: 1e9 })` with the message "at least ₹0.01"; round to 2 decimals in a sanitizer (or reject more than 2); set the frontend minimum to 0.01; add boundary tests (0.009, 0.01, 3 decimals).

### E-08 — Array `fraudAlertId` accepted; raw Mongoose text leaks
- **Where:** `validators/caseValidators.js:3-4` (`isMongoId` only).
- **Problem:** express-validator accepts arrays, so `["<validId>"]` creates a case (201); `[id,id]` returns 422 with the raw "Cast to ObjectId failed … for model FraudCase" text, exposing internal model names.
- **Evidence:** Confirmed (ran).
- **Fix:** `.isString().bail()` before `.isMongoId()` on every body id field. Add a test.

### E-09 — Fraud-by-city and merchant clusters are case-sensitive
- **Where:** `routes/AdminAPI.js:~151` (`$location.city`), `routes/AnalystAPI.js:~534` (`$merchantName`).
- **Problem:** the fraud rule treats `Mumbai`, `mumbai` and `MUMBAI` as one city, but the aggregations do not. Counts split across spellings, so the top-10 and the `count >= 3` merchant-cluster threshold under-report.
- **Evidence:** Confirmed (ran) (the `$_id` label text in my probe is a FerretDB artefact; the split is real).
- **Fix:** group on `{ $toLower: { $trim: { input: … } } }` and take the display label with `$first`.

### E-10 — Date-time filters with impossible values roll over silently
- **Where:** `backend/utils/dateRange.js:~58-70,197-206`.
- **Problem:** date-only values are validated, but date-times are not: `2026-10-05T25:00` becomes 19:30Z, `2026-02-30T10:00` becomes 2 March, `T10:99` rolls into the next hour, and `2026-02-30T10:00:00Z` also becomes 2 March. The filter then covers a different window than typed. (The frontend never sends these, so only direct API callers are affected.)
- **Evidence:** Confirmed (ran) in pass 2 and re-run by me.
- **Fix:** range-check hour/minute/second and round-trip the calendar day in both the zoneless and the offset/`Z` branches; return 400. Add tests.

### E-11 — README claim "soft signals alone cannot reach MEDIUM" is false
- **Where:** `README.md:62`.
- **Problem:** with default thresholds (`mediumMin` 25, comparison `>=`), new city (15) + unusual hour (10) = **25 = MEDIUM**. Velocity over the limits + unusual hour also reaches MEDIUM.
- **Evidence:** Confirmed (ran): score 25, MEDIUM, action OTP.
- **Fix:** reword the sentence, or lower the soft-signal caps if the intent is to keep them below MEDIUM.

### E-12 — "Loss prevented" hint does not match what is summed
- **Where:** `frontend/src/pages/admin/AdminDashboard.jsx:72` (hint "Held + blocked amounts"), `backend/routes/AdminAPI.js:156-159` (sums `estimatedLoss`).
- **Problem:** `estimatedLoss` is 0.7 × amount for HIGH and 1.0 × amount for CRITICAL, so a HELD ₹5,000 payment shows ₹3,500. The Trends page "Amount at risk" sums full amounts, so the two pages use different definitions.
- **Evidence:** Confirmed (read, probe in pass 2).
- **Fix:** pick one definition, and make the label and hint say it (for example "Estimated loss prevented (70% of held, 100% of blocked)").

### E-13 — Self-assigning a case notifies the assigner
- **Where:** `routes/AnalystAPI.js:~290-300`.
- **Problem:** if an analyst assigns the case to themselves, they get a CASE_ASSIGNED notification ("Assigned to You") for their own action.
- **Evidence:** Confirmed (ran).
- **Fix:** skip the notification when `assignee === actor`.

### E-14 — Invalid query filters are silently accepted
- **Where:** `routes/AdminAPI.js:36` (`isActive`), `routes/NotificationAPI.js:~25` (`isRead`), `routes/CustomerAPI.js:~273`, `routes/AnalystAPI.js:~202` (`status`, `riskLevel`).
- **Problem:** `?isActive=banana` filters to inactive users; `isRead=banana`, `status=garbage`, `riskLevel=x` return empty or unfiltered lists instead of a validation error. A bad `actorId` already returns 400, so behaviour is inconsistent.
- **Evidence:** Confirmed (ran).
- **Fix:** add `query(...).isIn([...])` validators and return 422.

### E-15 — Admin seed does not enforce the 72-byte bcrypt limit
- **Where:** `backend/seed/seedAdmin.js` (`assertSeedConfig`).
- **Problem:** register and change-password reject passwords over 72 bytes; the seed does not, so a longer `ADMIN_PASSWORD` is silently truncated (the first 72 bytes work and anything after is ignored).
- **Evidence:** Confirmed (ran): bcryptjs compares equal for `'a'*72+'zzz'` vs `'a'*100`.
- **Fix:** reject `Buffer.byteLength(ADMIN_PASSWORD) > 72`; add a test.

### E-16 — `PATCH /admin-api/thresholds` is read → merge-validate → write without a guard
- **Where:** `routes/AdminAPI.js:~432-516`.
- **Problem:** two admins updating at the same moment can each pass the merged-value check and together store an invalid combination (for example A sets `highMin` to 40 while B sets `mediumMin` to 45; the same for `maxPerDay < maxPerHour`). Practically very unlikely with few admins.
- **Evidence:** Confirmed (read).
- **Fix:** include the values you read in the update filter and return 409 on a miss, or add a cross-field validator on the model.

### E-17 — Unique-index build failures are silent (e.g. one case per alert)
- **Where:** `backend/server.js` (start), `models/FraudCaseModel.js:~283`.
- **Problem:** Mongoose builds indexes in the background after connecting (it does call `init()` itself), but nothing logs a failure. If the `fraudcases` collection already holds two cases for one alert (for example data from before the index existed), the unique `fraudAlertId` index fails silently and the "one case per alert" guarantee is gone. Likely only on an existing database, not a fresh one.
- **Evidence:** Confirmed (ran) that a duplicate makes the unique index fail with no log. The claim that indexes are *never* built is refuted: on a clean database they are built.
- **Fix:** after `connectDB()`, run `await Promise.allSettled(Object.values(mongoose.models).map(m => m.init()))` and `console.error` any rejection (optionally exit in production). Add a README note about checking for duplicate cases before upgrading.

### E-18 — Stale numbers and notes in the docs
- **Where:** `docs/FRONTEND_BUILD_NOTES.md:5,9,21,56`, deviation 11, "Common components" list.
- **Problem:** "22 pages" (there are 23 page files) and "296 tests" (there are 297 in 33 files). Deviation 11's reason is stale (the backend now parses `YYYY-MM-DD` as an IST day with an inclusive end). The "Common components" list omits `LoadError`, `BusyRegion` and `ServerWakeGate`. `README.md:19` says Node 22 "also ran the tests" while `engines` says 24.x.
- **Evidence:** Confirmed (ran/read).
- **Fix:** update the numbers or drop them; update deviation 11; complete the component list; state that Node 22 only gives an EBADENGINE warning.

### E-19 — Accessibility defects (contrast, empty `<th>`, heading skip)
- **Where:** `frontend/src/pages/customer/TrustScore.jsx:~434-437`, `components/shared/AuthShell.jsx:55`, `TransactionHistory.jsx:~339-341`, `UserManagement.jsx:~200`, `AuditLogs.jsx:~91`, `BarCard`/`TrendChart` (`AdminDashboard`, `AdminTrends`).
- **Problem:** "Good" label (`text-green-600`) measures 3.22:1 and "Excellent" (`text-emerald-600`) is lower than 4.5:1 by the same maths; AuthShell footer (`text-gray-500` on `gray-900`) is 3.67:1. Three tables have empty `<th>` cells for the action column. The chart cards use `<h3>` directly under `<h1>` (heading level skip).
- **Evidence:** Reported as Confirmed (ran) (canvas contrast script and DOM scan) by the frontend reviewer; I verified the class names by reading the code (**Plausible** on the exact ratios).
- **Fix:** `text-green-700` / `text-emerald-700`, `text-gray-400`; add `<span className="sr-only">Actions</span>` to the three tables; use `<h2>` in the chart cards.

### E-20 — Test-suite weaknesses (tests that cannot fail for the reason they claim)
- **Where:** `backend/tests/transactions.test.js:~138`, `tests/admin.test.js:~130-155,325-343`, `tests/cases.test.js:~122`, `frontend/src/api/axios.test.js`.
- **Problem:** (1) "concurrent submissions get unique TXN ids" uses one user, and the per-user lock now serialises it, so the ID-counter race is never exercised. (2) `istHour`, `todayIST` and trend `windowStart` are computed at assertion time and will flake near an IST hour or midnight boundary. (3) "fraud patterns respond" only checks status 200, so E-04 and E-09 pass unnoticed. (4) Missing negative tests: analyst reading a LOW transaction, deactivated session, array ids, 0.01 boundary, reactivation. (5) Test emails built from `Date.now()` can collide within the same millisecond. (6) The full backend run logs `MaxListenersExceededWarning: 11 listeners added to [Server]` (a supertest server not closed in some suite). (7) `axios.test.js` has a single test; the 401 redirect, cold-start retry and "no retry for POST" logic are untested.
- **Evidence:** Confirmed (read) by two reviewers; the warning was seen in the run log.
- **Fix:** use several users or direct parallel `createWithSequentialId` calls; freeze the clock with fake timers; assert real contents; add the missing tests; use a counter or UUID for emails; find the leaking suite with `--trace-warnings`.

### E-21 — Development-setup traps not documented
- **Where:** `README.md:27,34`, `vite.config.js:76,104`, `config/corsOptions.js:18`.
- **Problem:** (a) The dev backend defaults to port 5000, which macOS 12+ AirPlay Receiver holds (**Likely**, not reproduced here). (b) `vite preview` (port 4173) is not an allowed dev origin, so login and every POST from it are blocked by CORS/`originGuard` until `FRONTEND_URL=http://localhost:4173` is set (Confirmed (ran)). (c) On Vercel, preview/alias URLs other than the one listed in `FRONTEND_URL` are CORS-blocked by design; people opening the "wrong" URL see a broken login.
- **Fix:** document all three in the README troubleshooting section; consider 5001 as the dev default.

### E-22 — Dev-only dependency advisories (vitest chain)
- **Where:** `frontend/package.json` (`vitest` and `@vitest/coverage-v8` pinned to 3.2.7).
- **Problem:** `npm audit` (all) reports 4 findings: 2 critical (tinypool prototype-pollution to RCE, GHSA-5gmw-xhrv-c9v3 and GHSA-85c8-ppgw-ccpr) and 2 moderate (`@vitest/mocker` path traversal). They are **dev-only** and need an attacker-controlled test config, so the practical risk is low, and production is unaffected (`--omit=dev` is clean). The backend shows 19 moderate findings, all in the `jest` 30 dev tree; npm's suggested "fix" is a downgrade to jest 25, so ignore it.
- **Evidence:** Confirmed (ran): I re-ran `npm audit` in the frontend.
- **Fix:** later, bump `vitest` and `@vitest/coverage-v8` together (npm suggests 5.0.3, a major) and re-check whether the `esbuild: { jsx: 'automatic' }` workaround in `vitest.config.js` is still needed.

### E-23 — Package hygiene
- **Where:** the zip, both `package.json` files.
- **Problem:** every file in the zip has mode 666 (no executable bits, but unusual); no `description`, `license` or `repository` in either `package.json`; `@types/react` and `@types/react-dom` are unused devDependencies in a JavaScript-only project.
- **Evidence:** Confirmed (read).
- **Fix:** re-zip with 644/755; add the metadata; drop the two `@types` packages.

---

## Reviewed and found refuted or not a defect

These were raised during the audit and I checked them; you do not need to act on them.

- **"Indexes are never built / `Model.init()` never runs":** refuted as stated. Mongoose calls `init()` on connection and builds the unique indexes on a clean database. Only the *silent failure* part survived (E-17).
- **Authentication bypass, IDOR, NoSQL injection, mass assignment:** ~120 requests across roles, routes and malformed input found none. Cross-customer access returns 404; Express 5's simple query parser neutralises `?riskLevel[$ne]=x`; threshold keys are whitelisted; register ignores `isActive`, `trustScore`, `role: ADMIN`.
- **JWT, cookies, CORS, `originGuard`, sockets:** expired and `alg:none` tokens return 401; production cookie flags are `HttpOnly; Secure; Partitioned; SameSite=None`; an evil origin is refused for POST and socket; room joins for other users have no effect; deactivation closes the socket.
- **Frontend contract:** every API path, method, query parameter and response field matches the backend, including the dotted `+05:30` IST dates; enums (alert/case/transaction statuses, notification types, audit entity types) match across models, validators and routes.
- **No horizontal overflow** at 375 and 768 px on all 18 role pages; no unlabelled inputs, no duplicate ids, one `h1` per page; modal focus handling works; no timer or socket leaks.
- **No circular imports, no unresolved imports, no TODO/FIXME/debugger, no BOM/CRLF**, no unused production dependencies.
- **Static-analysis noise discarded:** `consistent-return` in Express handlers, `require-atomic-updates` on `req`/`socket`, `no-console` in server/seed, depcheck flags for `tailwindcss` and `@vitest/coverage-v8`, the `$_id` group-label difference on FerretDB.

## What I could not verify

- Real MongoDB / Atlas behaviour (I used FerretDB). Please check the payment-method and city charts once on your live Atlas data (E-09 related), and the `$group` label fields.
- macOS AirPlay on port 5000 (E-21a) is from reviewer knowledge, not a reproduction.
- Exact contrast ratios in E-19 were measured by the frontend reviewer; I confirmed only the classes.
