# FinGuardAI Phase 10 — ML Integration

**Status: ✅ complete (v1.1, 14 Oct 2026)** · model `fg-xgb-1.1.0`

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

## 2. Files

**New `ml-service/`** (Python 3.13): `app/features.py` (contract), `app/model.py`, `app/server.py`, `app/config.py`, `training/generate_data.py`, `training/rule_engine.py` (exact port of `checkFraud`), `training/train.py`, `model/fraud_model.json` + `model_meta.json`, `reports/metrics.json` + `shap_summary.png`, 86 tests, `wsgi.py`, `gunicorn.conf.py`, `requirements*.txt`, README.

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

End-to-end check with both real services: five normal payments scored 0 (ML). Then ₹20,000 (21.7× the average) from a new device in a new city scored **84 → CRITICAL, BLOCKED**, with SHAP pushes of new device +3.12, amount ratio +2.31 and new city +1.57. The rule engine gave 65.

## 4. Limitations (state in the report and PPT)

1. **Synthetic data:** the numbers show the pipeline works, not real-world accuracy.
2. The scenarios were designed by the team, so part of the ML-vs-rules gap is built into the data.
3. Social engineering and low-and-slow fraud are invisible to both engines. They need the deferred "Was this you?" step (B-05).
4. **High-risk merchants:** a single casino payment from a known device is LOW for the model but MEDIUM for the rules, and the rules catch more mule cash-outs. The contract has no "first time at this merchant type" feature.
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

**Still to run on your machine** (needs a real MongoDB; mongodb-memory-server downloads one): `cd backend && npm test`. All 533 tests are expected to pass. The 40 that fail here depend on features the stand-in database lacks.

## 6. Deploy

1. Commit `ml-service/` (with `model/` and `reports/`, not `data/`).
2. Render → New Web Service → root `ml-service`, build `pip install -r requirements.txt`, start `gunicorn -c gunicorn.conf.py wsgi:app`, health check `/health`, env `ML_API_KEY` (64 hex chars) and `PYTHON_VERSION=3.13.16`.
3. On the backend service: `ML_ENABLED=true`, `ML_SERVICE_URL=https://<ml-service>.onrender.com`, the same `ML_API_KEY`.
4. Existing database: no migration needed. `scoring` is optional, and older transactions show the rule breakdown as before.
