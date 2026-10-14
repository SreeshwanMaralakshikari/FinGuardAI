# FinGuardAI Phase 10 — ML Integration

**Status: ✅ complete and live (v1.2, 14 Oct 2026; error-check round applied)** · model `fg-xgb-1.1.0`

Phase 10 adds an XGBoost fraud model with SHAP explanations. It runs as a separate Python service (`ml-service/`). The backend asks it to score every payment and falls back to the existing rule engine whenever the service is off, slow, asleep or wrong. Without `ML_ENABLED=true`, the app behaves exactly as before Phase 10.

---

## 1. Decisions

| ID | Decision | Reason |
|---|---|---|
| D-P10-01 | Train on **synthetic data in FinGuardAI's own schema** (user choice) | PaySim, IEEE-CIS and ULB lack usual cities, usual hours, known devices and device reputation |
| D-P10-02 | **ML primary, rule engine as fallback** (user choice) | A payment never waits more than `ML_TIMEOUT_MS` and is never refused because of the ML service |
| D-P10-03 | **Second Render free web service** (user choice), root dir `ml-service` | Free services sleep after 15 min idle, which D-P10-02 and the cool-down/wake-up cover |
| D-P10-04 | Serve with **`xgboost-cpu`** | The plain `xgboost` package pulls NVIDIA's GPU library |
| D-P10-05 | SHAP at serving time via **XGBoost's TreeSHAP** (`pred_contribs`) | Same algorithm as `shap.TreeExplainer` (a test proves equality), without shap/pandas/scikit-learn on a 512 MB instance |
| D-P10-06 | **15-key flat feature contract**, strict validation (unknown/missing → 422) | A renamed field fails loudly instead of silently scoring wrong |
| D-P10-07 | `fraudScore = round(100 × p)` (half-up, JS semantics); **same bands, actions and loss multipliers** as the rules (`decisionForScore`) | The admin thresholds page keeps working for both engines |
| D-P10-08 | **Monotonic constraints** (riskier value can never lower the score) | Without them the model learned artefacts such as "17× the largest payment lowers risk" and "5 payments this hour lowers risk". The cost was ROC-AUC 0.939 → 0.933 |
| D-P10-09 | Split **by customer** 70/15/15; labels from **fraud scenarios, never from the rule score** | No leakage, and the model does not simply re-learn the rules |
| D-P10-10 | Feature flags derived with the **same conditions as the rules** (case-insensitive city, IST hour, normalised merchant match, empty-profile rules) | The model and the rules always see the same facts. A unit test checks parity |
| D-P10-11 | Generator aligned with the v3 backend: device reputation **rounded like `Math.round`**, blacklist < 30, profile learned only from **approved** honest payments | Removes training/serving skew found when reading the v3 code |
| D-P10-12 | SHAP values stored on the **Transaction** (`scoring.shapValues`); the FraudAlert mirrors `scoringEngine` + `modelVersion` | Every payment gets an explanation, not only alerted ones. This deviates from the original plan, which put SHAP on FraudAlert |
| D-P10-13 | Rule engine **always** runs; its breakdown is kept and shown "for comparison" | Lets analysts and examiners compare engines on every payment |
| D-P10-14 | ML reasons listed **only for MEDIUM+**; SHAP bars for every payment | A LOW payment should not list accusations |
| D-P10-15 | Shared secret `ML_API_KEY` (≥ 32 chars) in `X-API-Key`, constant-time compare; validated in `validateEnv` | Render free services cannot use the private network |
| D-P10-16 | Cool-down after TIMEOUT/UNAVAILABLE/AUTH/INVALID_RESPONSE + background `GET /health` wake-up | Payments are scored instantly by the rules while a sleeping instance starts |
| D-P10-17 | **Alert-only rule floor**: a high-risk merchant, a blacklisted device or an amount above the high-value threshold (admin policy) raises the ML score to the rule score, capped just below HIGH, when the rules rate the payment MEDIUM+ (`scoring.ruleFloor`, `scoring.mlScore`) | The model alone scored a casino payment from a known device, and a ₹50 crore payment from the customer's own phone, at 1–2/100. The floor adds alerts but never holds or blocks. Measured: HIGH unchanged (0.912 / 47 false alarms); an uncapped floor raised HIGH false alarms to 269, so it was rejected |
| D-P10-18 | **Wake on visit**: opening *Submit transaction* (`POST /customer-api/ml-warm-up`) or the admin dashboard (`GET /admin-api/ml-status`) wakes an ML service that has been silent for 10 minutes; during a cold start (> 2 s, no answer yet) payments skip straight to the rules | The ML service sleeps 15 minutes after the last *payment* even while the app is in use. Never on a timer, so no Render hours are used beyond real visits |
| D-P10-19 | One amount limit everywhere: **₹100 crore** (form, backend validator, ML contract), pinned by a test in each service | The contract allowed only ₹10 crore, so larger payments were always rule-scored with a misleading "contracts differ" error (E-01) |

## 2. Files

**New `ml-service/`** (Python 3.13): `app/features.py` (contract), `app/model.py`, `app/server.py`, `app/config.py`, `training/generate_data.py`, `training/rule_engine.py` (exact port of `checkFraud`), `training/train.py`, `model/fraud_model.json` + `model_meta.json`, `reports/metrics.json` + `shap_summary.png`, 86 tests, `wsgi.py`, `gunicorn.conf.py`, `requirements*.txt`, README.

**Error-check round (14 Oct)**: `ml-service/training/evaluate_floor.py` + `reports/rule_floor_metrics.json`; `fraudDetectionService.hardRuleSignals`; `scoringService.applyRuleFloor` / `signalsForMlAlert`; `mlClient.wakeUpIfIdle`; `POST /customer-api/ml-warm-up`; `frontend/src/api/mlWarmUp.js`; `MlStatusCard` per-cause wording and polling; Thresholds page note.

**Backend**: new `config/mlSettings.js`, `services/mlFeatureBuilder.js`, `services/mlClient.js`, `services/scoringService.js`, `tests/ml.units.test.js`, `tests/ml.integration.test.js`, `tests/helpers/fakeMlService.js`. Changed: `services/fraudDetectionService.js` (exports `resolveThresholds`, `decisionForScore`, `findHighRiskMerchant`; behaviour unchanged), `services/transactionService.js`, `models/TransactionModel.js` (`scoring`), `models/FraudAlertModel.js`, `utils/enums.js`, `routes/AdminAPI.js` (`GET /admin-api/ml-status`), `config/validateEnv.js`, `server.js`, `.env.example`, `tests/env.js`, and two response-shape tests (`scoring` key added).

**Frontend**: new `components/common/MlExplanation.jsx` (SHAP diverging bars), `FraudExplanation.jsx`, `MlStatusCard.jsx`, `utils/mlExplanation.js`, `__tests__/phase10ml.test.jsx`. Changed: SubmitTransaction, TransactionHistory, FlaggedTransactions, CaseDetail (use `FraudExplanation`), AdminDashboard (scoring-engine card), `utils/constants.js`. Two dashboard tests now route mocked requests by URL.

## 3. Results (test set: 1,200 unseen customers, 113,574 payments)

| | ML model | Rule engine |
|---|---|---|
| ROC-AUC / PR-AUC | **0.933 / 0.768** | 0.843 / 0.327 |
| HIGH (≥ 50): precision / recall / F1 | **0.912 / 0.682 / 0.780** | 0.510 / 0.352 / 0.417 |
| HIGH: false alarms | **47** | 241 |
| MEDIUM (≥ 25): share sent to OTP / false alarms | **0.56 % / 116** | 8.73 % / 9,375 |

Caught at HIGH (ML vs rules): account takeover 88.5 % vs 51.1 %; SIM swap 87.3 % vs 41.8 %; card testing 90.6 % vs 54.1 %; new-account 79.8 % vs 1.6 %; **mule cash-out 43.4 % vs 73.6 % (rules better)**; social engineering 2.4 % vs 0 %; low-and-slow 0 % vs 0 %. Calibration: payments scored 75–100 % are fraud 94.6 % of the time (Brier 0.0021).

**With the alert-only rule floor** (what the backend does — `python -m training.evaluate_floor`):

| Test set | ML only | ML + rule floor | Rule engine |
|---|---|---|---|
| HIGH: precision / recall / false alarms | 0.912 / 0.682 / 47 | **0.912 / 0.682 / 47** | 0.510 / 0.352 / 241 |
| MEDIUM: share of payments alerted / false alarms | 0.56 % / 116 | 2.63 % / 2,449 | 8.73 % / 9,375 |
| Mule cash-outs caught at MEDIUM | 54.7 % | **84.9 %** | — |

End-to-end check with both real services: five normal payments scored 0 (ML). Then ₹20,000 (21.7× the average) from a new device in a new city scored **84 → CRITICAL, BLOCKED**, with SHAP pushes of new device +3.12, amount ratio +2.31 and new city +1.57. The rule engine gave 65.

## 4. Limitations (state in the report and PPT)

1. **Synthetic data:** the numbers show the pipeline works, not real-world accuracy.
2. The scenarios were designed by the team, so part of the ML-vs-rules gap is built into the data.
3. Social engineering and low-and-slow fraud are invisible to both engines. They need the deferred "Was this you?" step (B-05).
4. **High-risk merchants and large amounts:** on its own the model rates a casino payment from a known device, or a very large payment from the customer's own device and city, as LOW (the contract has no "first time at this merchant type" feature). The alert-only rule floor (D-P10-17) makes these MEDIUM, but the model itself does not treat them as decisive.
5. `deviceIsBlacklisted` never fires in the simulated data, so the model relies on the trust score itself.

## 5. Verification log

* **ml-service:** 86/86 pytest. Ran in the dev environment and in a clean venv with only the pinned requirements (no GPU libraries), and from a fresh zip extraction. Ruff clean. Gunicorn tested over real HTTP: ~180 MB RSS, ~3 ms median prediction. Data and model are byte-identical when rebuilt from seed 42 (model SHA-256 `ff138b4a…`).
* **Backend:** lint clean. Full suite run against a MongoDB stand-in (FerretDB v1 behind a test-only proxy): **original code 430/470, Phase 10 code 493/533**. No regressions. The same 40 tests fail before and after (database features the stand-in lacks: partial/TTL indexes, `$cond`, `$toLower`…). All 63 new ML tests pass, and the `fraudDetectionService` coverage gate holds. Without the proxy: 206 → 268, also with no regressions.
* **Frontend:** lint clean, **568/568** (553 + 15 new), the `pages/**` coverage gate passes, and the production build succeeds.
* **End to end:** real gunicorn ML service + real `server.js` + Vite dev server + Chromium.
  * Registration, login and ML-scored payments all worked, and SHAP values were stored and returned.
  * The admin status card showed the model.
  * Stopping the ML service gave `RULES (UNAVAILABLE)`, then `RULES (COOLDOWN)`. After a restart, scoring returned to ML automatically.
  * Screenshots checked at 1280 px and 375 px, with no horizontal overflow.

* **On your laptop against MongoDB Atlas (14 Oct):** 532/533 on the first run. The one failure was a pre-existing test bug: the race test "two simultaneous closes" looked for /Cleared|Completed/ although B-02 renamed the RESOLVED notice to "Fraud Confirmed", so it failed whenever RESOLVED won the race. It had never run before, because the stand-in database skips concurrency tests. After fixing the check (exactly one outcome notice, the winner's), `tests/cases.test.js` passed 32/32 → **533/533**.

* **Live deployment (14 Oct):** `finguardai-ml` deployed on Render (`/health` → `fg-xgb-1.1.0`). The backend log shows `ML service is up`, and the admin card shows "ML model fg-xgb-1.1.0". On the live site, a normal ₹500 payment scored 0 (LOW, APPROVED, ML), and a ₹10,000 payment from a new device in a new city (16.7× the average) scored **81 → CRITICAL, BLOCKED** (rule engine: 65), with SHAP pushes of new device +3.13, amount ratio +2.36 and new city +1.60. A one-time `npm run db:sync-indexes` on the live database installed the round-3 unique FraudAlert index and dropped 3 unused indexes.

* **Error-check round (14 Oct):** fixes E-01…E-10 and D-1/D-2 from the error report. ML service 106/106 pytest, ruff clean (default rules); generator output byte-identical after the style fixes. Backend lint clean; full suite on the stand-in database: the same 40 emulator-only failures as before, everything else passes (566 tests, 33 of them new; expected 566/566 on Atlas). Frontend lint clean, **577/577**, coverage gates pass, build OK. End to end with the real gunicorn ML service and the real backend: a normal payment 0 (LOW, ML); ₹20,000 from a new device and city 81 (CRITICAL, ML; rules 65); a casino payment from a known device ML 1 → **49 MEDIUM** (floor, rules 50); a ₹50 crore payment is now ML-scored (no 422) and raised by the floor from 2 to **49 MEDIUM**; the warm-up route answers 202 at once.

## 6. Deploy

1. Commit `ml-service/` (with `model/` and `reports/`, not `data/`).
2. Render → New Web Service → root `ml-service`, build `pip install -r requirements.txt`, start `gunicorn -c gunicorn.conf.py wsgi:app`, health check `/health`, env `ML_API_KEY` (64 hex chars) and `PYTHON_VERSION=3.13.16`.
3. On the backend service: `ML_ENABLED=true`, `ML_SERVICE_URL=https://<ml-service>.onrender.com`, the same `ML_API_KEY`.
4. Existing database: no migration needed. `scoring` is optional, and older transactions show the rule breakdown as before. `scoring.mlScore` / `scoring.ruleFloor` exist only on payments scored after the error-check round.
5. After the error-check round, **redeploy all three services**: the ML service (amount limit, rupee formatting, placeholder-key check), the backend (rule floor, wake-up, alert types) and the frontend (warm-up call, explanations, admin wording).
