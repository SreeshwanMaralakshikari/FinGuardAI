# FIX_LOG

Newest round first. Rounds 2 and 3 (the two audits of the Phase 1–9 code) are documented in `docs/audit/`
and in the round reports; Phase 10 itself is described in `docs/PHASE_10_ML_INTEGRATION.md`.

## Round 4, last part: model transparency and CI (15 Oct 2026)

| ID | Change |
|---|---|
| R4-09 | **Public model card** at `/model` (no sign-in, outside the wake gate): purpose, training data, results against the rule engine, results by fraud type, calibration, what the model looks at, fairness and privacy, limitations, and how FinGuardAI uses it. Every number is in `components/modelcard/modelFacts.js`, and a test checks each one against `ml-service/model/model_meta.json` and `ml-service/reports/*.json`, so the card cannot drift from the model. Landing page links to it. |
| R4-08 | **Admin "Model insights"** (`/admin/model`, `GET /admin-api/model-insights?days=7\|30\|90`): share of payments scored by the model and why the rules took over, policy-floor count, a 4 × 4 ML-band vs rule-band agreement table, the ten biggest disagreements, live mean \|SHAP\| over the last 500 model-scored payments, and closed-case outcomes by engine and by the customer's "Was this you?" answer. Uses only simple queries and `$group`, so it also runs on the test stand-in database. |
| R4-12 | **GitHub Actions CI** (`.github/workflows/ci.yml`): on every push and pull request, three parallel jobs with no secrets: backend (ESLint, Jest with coverage, throw-away `mongo:8` container), frontend (ESLint, Vitest with coverage gates, production build) and ml-service (ruff, pytest). Checked with actionlint, and each job's steps were rehearsed from a clean clone. |
| Housekeeping | Removed `backend/state.json`, a file the local test database stand-in wrote by accident (no secrets in it), and added it to `backend/.gitignore`. |

Checks:
- Backend: lint; 577 tests. On the stand-in database, the same 40 failures as before, caused by operators the stand-in lacks; the 5 new tests pass. 577/577 expected on real MongoDB (CI and Atlas).
- Frontend: lint; 605/605 with the coverage gates; production build. All from a clean `npm ci`.
- ML service: ruff clean; 106/106 in a fresh virtual environment.
- axe-core WCAG 2 A/AA on `/model` and `/admin/model`, both themes: no violations. No horizontal scrolling at 375 px.

## Round 4: Guardian look and demo flow (14 Oct 2026)

| ID | Change |
|---|---|
| R4-01 | **Two themes.** A light theme and a dark "night watch" theme, chosen before the first paint (`public/theme-init.js`), with a toggle in the navbar and on the public pages; it follows the device setting until the user picks one. All colours are CSS variables (`src/index.css`), so component class names did not change. Fonts are self-hosted: Rajdhani (headings, numbers) and IBM Plex Sans. Charts read their colours from the theme (`useChartColors`). New shield emblem and favicon. |
| R4-02 | **Public landing page** at `/`, rendered outside the server wake gate so it appears at once. It wakes the API in the background and shows the server status, and it replays three real scoring results (`components/landing`). |
| R4-03 | **Example payments** on *Submit transaction*: everyday payment, account takeover, high-risk merchant, very large payment. They fill the form only; the customer still submits. |
| R4-04 | **Scoring pipeline** on the result: rule engine → ML model (score, version, time) → decision, including why the rules decided and whether the policy floor applied. The backend stores `scoring.mlLatencyMs`. |
| R4-10b | **"Was this you?"**: on a held or blocked payment the customer confirms or disputes it, with an optional note (`POST /customer-api/transactions/:id/response`). Evidence only: the status never changes. It is stored once, audited (`CUSTOMER_RESPONDED`), and the assigned analyst (or every active analyst) gets a `CUSTOMER_RESPONSE` notification. Analysts see the answer on the flagged-payment and case pages. |
| R4-05 | Optional **one-click demo sign-in** (customer and analyst only, never admin), off unless `VITE_DEMO_LOGINS=true`. |
| R4-06 | **Link previews** (Open Graph and Twitter tags, `og-image.png`; the absolute URL comes from Vercel automatically). |
| R4-07 | **Root README** with live links, screenshots, how scoring works, results, local setup, tests, deployment and troubleshooting. |

Checks:
- Backend: lint; 572 tests (the same 40 emulator-only failures on the stand-in database; 572/572 expected on Atlas).
- Frontend: lint; 598/598 with the coverage gates; production build.
- ML service: 106/106.
- axe-core WCAG 2 A/AA scan of 10 pages in both themes: no violations.
- No horizontal scrolling at 375 px.
- Browser end-to-end run: landing → register → example payment → held → dispute → the analyst sees the answer and is notified.

---

## Error-check round after Phase 10 (14 Oct 2026)

Source: *FinGuardAI Error Check Report (Phase 1–10 zip)*. No High-severity errors were found; all items below are fixed.

| ID | Fix |
|---|---|
| E-01 | One amount limit everywhere: ₹100 crore (form, backend validator, ML contract + `model_meta.json`), pinned by a test in each service. Payments above ₹10 crore used to be rejected by the ML service (422) and were always rule-scored. |
| E-02 | Thresholds page explains which settings the ML model uses (bands for every payment; merchant list and high-value amount as policy) and which only drive the rule engine. |
| E-03 | Root README: planned with the Round 4 look (screenshots must match). |
| E-04 | ML service refuses to start with the `.env.example` placeholder key (as the backend already did). |
| E-05 | ML reasons use Indian digit grouping (₹1,50,000; 5,43,478.3×), identical to the backend's SHAP labels. |
| E-06 | One request id per scoring call: sent as `X-Request-Id`, logged when the rules take over, stored in the TRANSACTION_SUBMITTED audit entry. |
| E-07 | Admin scoring card names the real cause: wrong API key, rejected answer, contract mismatch, or waking up. |
| E-08 | ML alerts without a mapped reason are classified by the strongest SHAP feature (then the rule signals), not as COMPOSITE. |
| E-09 | ML client releases unread HTTP bodies on error paths. |
| E-10 | Duplicate `backend/seedDemoData.mjs` removed; Phase 10 doc, architecture doc and ML README updated; ruff clean with default rules (generator output verified byte-identical). |
| D-1 | **Alert-only rule floor**: high-risk merchant, blacklisted device or high-value amount → at least MEDIUM when the rules rate it MEDIUM+, never HIGH by the floor alone. Measured with `training/evaluate_floor.py`: HIGH unchanged (precision 0.912, 47 false alarms); MEDIUM alerts 0.56 % → 2.63 %; mule cash-outs caught at MEDIUM 54.7 % → 84.9 %. An uncapped floor (HIGH false alarms 269) was rejected. |
| D-2 | **Wake on visit**: the Submit page (`POST /customer-api/ml-warm-up`) and the admin dashboard wake an ML service silent for 10 minutes; during a cold start payments skip straight to the rules instead of waiting 2.5 s. Never on a timer. |

Checks: ML service 106/106 pytest + ruff; backend lint + 566 tests (the same 40 emulator-only failures as before on the stand-in database); frontend lint + 577/577 + coverage gates + build; end to end with the real gunicorn ML service, the real backend, Vite and Chromium.

---

## Round 1: review round after the frontend build

Source of the IDs: `FinGuardAI_Error_Check_Report.md` (D-, L-, F-) and `FinGuardAI_Complete_Zip_Error_Report.md` (N-).
Verified at the end of the first round: backend 221/221 tests, frontend lint clean + 285/285 tests + production build, both from a clean `npm ci` on the committed lockfiles; every page and the main workflows were also exercised live in a headless browser against the fixed backend.

## Decisions you made
- **MEDIUM risk** stays APPROVED (no OTP flow) but no longer trains the "normal" profile (L-01).
- **Analyst sign-up** needs `ANALYST_INVITE_CODE` (L-11).
- **`COOKIE_MODE`** switch added: `cross-site` (default) or `same-site` (D-02).

## Fixed: backend
| ID | Change |
|---|---|
| L-01 | Only LOW-risk approved transactions update the behaviour profile, known devices and usual locations; MEDIUM wording corrected |
| L-02, L-04, BE-11/12 | Case workflow enforced server-side (transition table, assignee-only status change, atomic update, reassign keeps status, unique `fraudAlertId`). DISMISSED sets the alert to DISMISSED, releases the transaction (HELD/BLOCKED → APPROVED) and notifies the customer; RESOLVED keeps it blocked. `lossPrevented` no longer counts dismissed cases |
| L-05, N-14 | `YYYY-MM-DD` filters are IST days on every endpoint; trends window starts at IST midnight, peak hours use the same window |
| L-06 | A user's sockets are closed on logout, deactivation and password change; handshake rejects revoked/inactive users |
| L-08, N-28 | Per-user (and per-device) lock around transaction submission: velocity, trust score and reputation see consistent state |
| L-09 | Unknown e-mail costs the same bcrypt comparison as a wrong password |
| L-10, L-13, N-26 | `isString` + length caps on transaction/role fields; missing body no longer 500s; null nested objects → 422 |
| L-12 | Register limiter counts every request; change-password limiter (5 failures/15 min per user); transaction limiter per user |
| L-14 | Threshold validation (ints, `maxPerDay ≥ maxPerHour`, merchant list limits, finite amount); audit stores before/after |
| L-15 | Dead cookies cleared on logout/check-auth; `express.urlencoded` removed; password max 72 bytes; exact-millisecond token revocation after a password change; merchant/city matching normalised; trust-score velocity live; `en-IN` formatting; ids beyond 99,999; new indexes; behaviour profile without `Math.max(...)`; post-commit helpers can no longer turn a saved transaction into a 500; failed-login and alert-creation audit entries; page cap |
| N-09 | Uploads: magic-byte check, Cloudinary failures → 502, old image destroyed best-effort |
| N-11 | `TZ` forced from `APP_TIME_ZONE`, validated at startup, used consistently |
| N-24, N-25, N-29 | Note POST returns the full saved note; `resolutionSummary` validated whenever present; dead branch removed |
| D-04, D-05, D-09, D-10 | Startup checks (DB name, Render without production, placeholder secrets); test-DB name guard; seed refuses weak passwords on remote/production DBs and exits non-zero if the e-mail exists with another role |
| D-11 | `GET /` 200, `/health` has `version`; `.node-version`/`.nvmrc`; `.env.example` completed |
| D-02 | `COOKIE_MODE` / `COOKIE_DOMAIN` |
| D-01 | `package-lock.json` for both apps, generated from a clean state and checked with `npm ci` (Linux native packages present) |

## Fixed: frontend
| ID | Change |
|---|---|
| N-01, N-07 | Modal rewritten (focus only on open, trap, restore, scroll lock, `dismissible`); same hook for the mobile drawer |
| N-02 | Load failures show an error with Retry instead of empty states or zero KPIs |
| N-03, N-08 | Latest-request-wins guards, per-thunk loading/error; dashboards no longer share state with list pages |
| N-04, N-13 | ThresholdConfig: no form after a failed load; integer/range rules identical to the backend |
| N-05, N-06, N-12, N-14 | Device lookup single request, case-close errors inside the dialog, Stop always available, trends wording |
| N-15 to N-23 | Accessibility labels/roles, form validation parity, invite-code field, return-to-page after login, free-text merchant category, pagination clamp, live-alert cap, chart labels, Investigate column first, config clean-ups (font, tokens, build guard, sourcemaps off, pinned vitest) |
| F-04 | Logout failure message is honest about the server session |
| N-10 | ~185 new tests (285 total) incl. routing with the real initial auth state |

## Still open (known, not fixed in this round)
- **L-03** Scoring design: soft signals alone cannot reach MEDIUM; first-ever transaction is never flagged by amount alone. Tune on the Thresholds page or change the weights deliberately.
- **L-07** Device reputation is keyed by the client-sent device id and shared across users.
- **N-27** Analysts get no live alert (only ADMIN sockets receive `fraud_alert`); no analyst notification for new HIGH/CRITICAL alerts. Simulation only broadcasts an event (O-06).
- **D-02 (Safari/iPhone)** needs a real-device test; `COOKIE_MODE=same-site` plus a custom domain is the fix if it fails.
- **D-06, D-07, D-14** Phase 9 doc alternatives, trust-proxy hop count (`TRUST_PROXY`) and exact-origin CORS must be checked on the first real deployment.
- **Axios** 401 uses a hard redirect and 403 has no special handling.
- **Real OTP flow** does not exist; MEDIUM is approved without it.
- **Rate limits are per process.** Sockets are websocket-only (no polling fallback).
- **Documentation** (Phase 1–9 documents) was not edited: the inconsistencies listed in section 7 of the first error report remain in those documents.
- **Concurrency tests** (`itAtomic`) skip themselves on emulators; run against real MongoDB once.
- **Existing databases**: the new unique index on `FraudCase.fraudAlertId` needs duplicate cases removed first; `express.urlencoded` removal means form-encoded bodies are no longer accepted.
- The Phase 1 features never built: fraud-by-device analytics, trend predictions, customer event timeline, trust-score history.

# Second review round (three independent review passes after the first fix round)

Verified at the end: backend 231/231 tests, frontend lint clean + 297/297 tests + production build, both from a clean `npm ci`; a live browser run of the whole app found no defects beyond those listed below, all of which were fixed.

## Fixed in round 2
| Area | Change |
|---|---|
| Transactions | A failing fraud-alert insert no longer turns a saved payment into a 500; the insert is retried once (analysts can only open a case from an alert). A merchant category such as "crypto exchange" now matches a configured `CRYPTO_EXCHANGE`; the reason text shows the configured name |
| Cases | If closing a case fails halfway the case is reopened so the analyst can retry; the retry no longer double-writes the alert audit entry; DISMISSED also takes the released payment out of the device's flag / fraud counters; trust score and device updates run under the same user / device locks as a normal payment; the "assigned" notification can no longer fail the request |
| API hygiene | Validation errors no longer echo submitted values (the password); upload limits on fields / parts / field size; profile updates are rate limited (20 / hour / user); date filters accept only `YYYY-MM-DD` or ISO 8601, a zone-less date-time is India time, `startDate` after `endDate` is a 400; first duplicate cookie wins on sockets; `APP_TIME_ZONE` is trimmed; a malformed stored image URL cannot throw; seed script works through a symlinked path; `MONGODB_URI` with a `<placeholder>` and an invite code of only spaces are rejected; `@jest/globals` is a declared devDependency |
| Frontend | After a rejected assign / status / note / open-case action the page reloads the case (buttons and "assigned to me" match the server; a late reply for a case you already left is ignored); the dashboard alert card no longer claims MEDIUM alerts wait for an analyst; passwords are limited to 72 bytes like the server; threshold fields have the server's maxima; merchant categories are normalised exactly like the server; form errors from the server are cleared on the next invalid submit; risk badges, grey helper text and the case "dismissed" badge meet WCAG AA contrast; the mobile drawer closes when the window grows past the `lg` breakpoint; each page sets `document.title`; row buttons have row-specific accessible names; long names no longer overflow the dashboard heading on phones; the profile picture row no longer overflows at 390 px; `VITE_API_URL` must be exactly a bare lower-case origin; stale notes in `docs/FRONTEND_BUILD_NOTES.md` refreshed |

## Still open on purpose (decided, or needs a product decision)
- **Sessions**: logout / deactivation clear the cookie and close sockets, but the JWT itself stays valid until it expires (6 h). Revoking it needs a server-side session store.
- **Double failure while closing a case** (the close and the undo both fail) leaves the case closed with the payment still held; the log shows `Could not reopen case…`. An analyst would have to fix the transaction by hand.
- The "7-day average" on the trends chart uses a shorter window for the first six days. Customers receive the detailed fraud reasons for their own payment. The behaviour-profile rebuild reads the user's history on every payment. Any analyst may take over an assigned case (only the assignee may change its status).
- List pages draw their empty state for one frame before the first fetch starts. A failed reload after a status change is silent. Nested dialogs are not supported (none exist).
- The five `itAtomic` concurrency tests report as passed but do nothing on emulators such as FerretDB; run them on real MongoDB.
- `amountThreshold: 0` is accepted (flags every payment); a test pins it.
