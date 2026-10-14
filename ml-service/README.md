# FinGuardAI ML Service (Phase 10)

A small Python service that scores a payment with an **XGBoost** model and
explains the score with **SHAP** values. The Node backend calls it for every
payment; if it is asleep, slow or failing, the backend falls back to the
existing rule engine, so payments never wait on it.

```
Customer pays ─► Node backend ──(features JSON, X-API-Key)──► ML service /predict
                      │                                           │
                      │◄──── fraudScore, SHAP contributions, reasons
                      │
                      └─ no answer within the timeout → rule engine (fraudDetectionService.js)
```

## Folder layout

```
ml-service/
├── app/
│   ├── features.py     Feature contract: names, types, ranges, encoding, reasons (single source of truth)
│   ├── model.py        Loads the model once; predicts + TreeSHAP contributions
│   ├── server.py       Flask app: /health, /contract, /predict, JSON errors, API-key check
│   └── config.py       Environment variables (ML_API_KEY, MODEL_DIR, LOG_LEVEL)
├── training/
│   ├── generate_data.py  Synthetic payment history in FinGuardAI's own schema
│   ├── rule_engine.py    Exact Python port of checkFraud() — the comparison baseline
│   ├── train.py          Train, evaluate, export model + reports
│   └── evaluate_floor.py Measures the backend's alert-only rule floor on the same test set
├── model/
│   ├── fraud_model.json  Trained XGBoost model (committed — Render's disk is wiped on restart)
│   └── model_meta.json   Version, columns, contract, parameters, test metrics
├── reports/
│   ├── metrics.json      Full test-set metrics, ML vs rules
│   ├── rule_floor_metrics.json  ML only vs ML + rule floor vs rules
│   └── shap_summary.png  SHAP beeswarm plot for the report/PPT
├── tests/              106 pytest tests
├── wsgi.py             gunicorn entry point (and local dev server)
├── gunicorn.conf.py    1 worker × 4 threads, sized for a 512 MB free instance
├── requirements.txt        Serving only (what Render installs)
└── requirements-train.txt  Training + tests (your laptop only)
```

## The feature contract

The backend sends exactly these 15 keys in `{"features": {...}}`. Unknown or
missing keys are rejected with **422**, so a renamed field fails loudly instead of
silently scoring wrong.

| Feature | Type | Meaning |
|---|---|---|
| `amount` | number ≥ 0.01 | Payment amount (₹) |
| `amountToAvgRatio` | number ≥ 0 | amount ÷ customer's average (1.0 if no profile) |
| `amountToMaxRatio` | number ≥ 0 | amount ÷ customer's largest previous payment (1.0 if no profile) |
| `txnsLastHour` | integer | Customer's payments in the previous 60 min (current one excluded) |
| `txnsLastDay` | integer | Same for 24 h |
| `isNewCity` | 0/1 | City not in `usualLocations` (0 when the list is empty) |
| `isNewDevice` | 0/1 | Device not in `knownDeviceIds` (0 when the list is empty) |
| `isNewPaymentMethod` | 0/1 | Method not in `usualPaymentMethods` (0 when the list is empty) |
| `isUnusualHour` | 0/1 | Hour not in `usualHours` (0 when the list is empty) |
| `hourOfDay` | 0–23 | Local hour in India (Asia/Kolkata) |
| `deviceReputationScore` | 0–100 | Device trust score (100 when the device has no record) |
| `deviceIsBlacklisted` | 0/1 | Device is blacklisted |
| `isHighRiskMerchant` | 0/1 | Category is in the admin's high-risk list |
| `hasProfile` | 0/1 | Customer has a behaviour profile |
| `paymentMethod` | `UPI` / `CARD` / `NET_BANKING` / `WALLET` | Payment method |

Response of `POST /predict`:

```json
{
  "modelVersion": "fg-xgb-1.1.0",
  "fraudProbability": 0.957387,
  "fraudScore": 96,
  "baseValue": -5.590679,
  "contributions": [
    {"feature": "isNewDevice", "value": 1, "shap": 3.237752},
    {"feature": "amountToAvgRatio", "value": 10.0, "shap": 2.504595}
  ],
  "reasons": ["Payment from a device the customer has not used before", "..."],
  "reasonFeatures": ["isNewDevice", "amountToAvgRatio", "..."]
}
```

* `fraudScore = round(100 × probability)` (halves round up, like JavaScript).
  The backend still maps it to LOW / MEDIUM / HIGH / CRITICAL with the admin's
  thresholds, so the threshold settings page keeps working.
* `contributions` are SHAP values in log-odds, largest first. They add up
  exactly: `baseValue + Σ shap = log(p / (1 − p))`. Positive pushes towards
  fraud, negative towards safe.
* `reasonFeatures[i]` is the feature behind `reasons[i]`; the backend uses it to
  classify the fraud alert (e.g. `isNewDevice` → `NEW_DEVICE`) without parsing text.
* SHAP is computed with XGBoost's built-in TreeSHAP (`pred_contribs=True`) —
  the same algorithm as `shap.TreeExplainer` (a test proves they match), without
  shipping the `shap`/pandas/scikit-learn packages to the server.

## Results (test set: 1,200 customers the model never saw, 113,574 payments)

| | ML model | Rule engine |
|---|---|---|
| ROC-AUC | **0.933** | 0.843 |
| PR-AUC | **0.768** | 0.327 |
| At HIGH (score ≥ 50) — precision | **0.912** | 0.510 |
| At HIGH — recall | **0.682** | 0.352 |
| At HIGH — F1 | **0.780** | 0.417 |
| At HIGH — false alarms | **47** | 241 |
| At MEDIUM (≥ 25) — payments sent to OTP | **0.56 %** | 8.73 % |
| At MEDIUM — false alarms | **116** | 9,375 |

Fraud caught at HIGH, by scenario:

| Scenario | Test payments | ML | Rules |
|---|---|---|---|
| Account takeover | 131 | **88.5 %** | 51.1 % |
| SIM swap | 55 | **87.3 %** | 41.8 % |
| Card testing | 233 | **90.6 %** | 54.1 % |
| New-account fraud | 124 | **79.8 %** | 1.6 % |
| Mule cash-out | 53 | 43.4 % | **73.6 %** |
| Social engineering | 41 | 2.4 % | 0.0 % |
| Low-and-slow | 30 | 0.0 % | 0.0 % |

The model is well calibrated (Brier score 0.0021): payments it rates 75–100 %
are fraud 94.6 % of the time.

### The backend's rule floor (alert only)

The backend lets the model decide, with one exception (`backend/services/scoringService.js`):
when the rule engine sees a **policy** signal — a merchant category on the admin's high-risk
list, a blacklisted device, or an amount above the admin's high-value threshold — and itself
rates the payment MEDIUM or higher, the score is raised to the rule score, **capped just below
HIGH**. So such a payment always raises an alert, but only the model can hold or block it.

Why: the model learned that these facts alone are not fraud. It scores a casino payment from a
known device, and even a ₹50 crore payment from the customer's own phone and city, at about
1–2 out of 100. An admin who lists a merchant category or sets a high-value limit expects those
payments to be flagged.

Measured with `python -m training.evaluate_floor` (writes `reports/rule_floor_metrics.json`):

| Test set | ML only | ML + rule floor (used) | Uncapped floor (rejected) |
|---|---|---|---|
| At HIGH — precision / recall | 0.912 / 0.682 | **0.912 / 0.682** | 0.653 / 0.711 |
| At HIGH — false alarms | 47 | **47** | 269 |
| At MEDIUM — share of payments alerted | 0.56 % | 2.63 % | 2.63 % |
| At MEDIUM — mule cash-outs caught | 54.7 % | **84.9 %** | 84.9 % |

The floor changes nothing at HIGH (holds and blocks); it adds MEDIUM alerts, which approve the
payment and notify the customer. The uncapped version would hold honest high-value and casino
payments again, so it was rejected.

**Monotonic constraints.** The model is trained so that a riskier value of a
feature can never lower the score (a larger amount-to-average ratio, more
payments in the last hour, a new device or city, a lower device trust score…).
Without them it reached ROC-AUC 0.939 / PR-AUC 0.791, but it also learned data
artefacts that would have been shown to analysts as explanations, e.g. "17× the
largest earlier payment *lowers* the risk". Explanations that make sense were
judged worth the small drop. `tests/test_model.py` checks the constraints hold.

### Limitations — state these in the report

1. **The data is synthetic.** Public fraud datasets do not contain FinGuardAI's
   signals (usual cities, usual hours, known devices, device reputation), so the
   training data is simulated. Fraud patterns and rates are plausible
   assumptions, not measurements. These numbers show the pipeline works; they
   do not prove accuracy on real bank traffic.
2. **Labels come from scenarios, not from the rules**, so the model is not just
   copying the rule engine. But because the scenarios were designed by us, the
   gap between ML and rules is partly built into the data.
3. **Social engineering and low-and-slow fraud are not caught by either
   engine.** The victim pays from their own phone, in their own city, at a
   normal-looking amount. Catching these needs a customer confirmation step
   (the deferred "Was this you?" feature, B-05), not a better score.
4. **High-risk merchants and large amounts**: on its own the model scores a
   casino payment from a known device, or a very large payment from the
   customer's own device and city, as LOW. Some honest customers in the data pay
   casinos regularly or make occasional large payments, and the contract has no
   "first time at this kind of merchant" feature. The backend's alert-only rule
   floor (above) makes such payments MEDIUM, so they are no longer missed, but
   the model itself does not treat these facts as decisive.
5. **`deviceIsBlacklisted` never fires in the training data** (no simulated
   device fell below a trust score of 30), so the model leans on the trust score
   itself; the rule engine still adds its blacklist points.

## Run it locally (Windows, PowerShell)

Python 3.13 is the tested version.

```powershell
cd ml-service
py -3.13 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-train.txt

# 1. Generate the data (~2 min, ~56 MB, identical every time for seed 42)
python -m training.generate_data --customers 8000 --days 120 --seed 42 --out data/synthetic_transactions.csv

# 2. Train + evaluate (~30 s) → model/, reports/
python -m training.train --data data/synthetic_transactions.csv

# 2b. (optional) Measure the backend's rule floor → reports/rule_floor_metrics.json
python -m training.evaluate_floor --data data/synthetic_transactions.csv

# 3. Tests
python -m pytest -q

# 4. Run the service (gunicorn does not run on Windows; this uses Flask's server on port 5001)
$env:ML_API_KEY = python -c "import secrets; print(secrets.token_hex(32))"
python wsgi.py
```

Steps 1–2 are only needed to rebuild the model; the trained model is already in
`model/`. Rebuilding from seed 42 reproduces the same model file byte for byte.

Try it from a second PowerShell window (use the same key):

```powershell
$body = '{"features":{"amount":9000,"amountToAvgRatio":10,"amountToMaxRatio":3,"txnsLastHour":0,"txnsLastDay":1,"isNewCity":1,"isNewDevice":1,"isNewPaymentMethod":0,"isUnusualHour":1,"hourOfDay":3,"deviceReputationScore":100,"deviceIsBlacklisted":0,"isHighRiskMerchant":0,"hasProfile":1,"paymentMethod":"UPI"}}'
Invoke-RestMethod -Uri http://127.0.0.1:5001/predict -Method Post -ContentType "application/json" -Headers @{ "X-API-Key" = $env:ML_API_KEY } -Body $body
```

## Deploy on Render (second free web service)

1. Commit the `ml-service/` folder (including `model/` and `reports/`; not `data/`) and push.
2. Render → **New → Web Service** → pick the same GitHub repository.
3. Settings:
   * **Root Directory:** `ml-service`
   * **Runtime / Language:** Python 3
   * **Build Command:** `pip install -r requirements.txt`
   * **Start Command:** `gunicorn -c gunicorn.conf.py wsgi:app`
   * **Instance type:** Free
   * **Health Check Path:** `/health`
4. Environment variables:
   * `ML_API_KEY` = a new random 64-character hex string (the backend gets the same value)
   * `PYTHON_VERSION` = `3.13.16` (Render's default for new services is 3.14)
5. Deploy, then open `https://<your-ml-service>.onrender.com/health` — it should show
   `{"status": "ok", "modelVersion": "fg-xgb-1.1.0"}`.

Free services sleep after 15 minutes without traffic and take a while to wake
up. That is why the backend uses a short timeout and falls back to the rule
engine: the first payment after a quiet period is scored by the rules while the
ML service wakes up, and later payments use the model.

Free web services cannot use Render's private network, so the backend reaches
this service over public HTTPS; `ML_API_KEY` is what keeps `/predict` private.
Never put the key in the frontend.

## Connect the backend

In the **backend** service on Render (Settings → Environment) add:

| Variable | Value |
|---|---|
| `ML_ENABLED` | `true` |
| `ML_SERVICE_URL` | `https://<your-ml-service>.onrender.com` (no trailing slash) |
| `ML_API_KEY` | exactly the same value as the ML service's `ML_API_KEY` |
| `ML_TIMEOUT_MS` | optional, default `2500` |
| `ML_COOLDOWN_MS` | optional, default `60000` |

Save → the backend redeploys. Its log then shows
`Fraud scoring: ML model at https://… , rule engine as fallback` and, once the ML
service answers, `ML service is up (model fg-xgb-1.1.0)`. The admin dashboard's
"Fraud scoring engine" card shows the same, plus how many payments the model and
the rules scored in the last 24 hours.

Locally: run this service with `python wsgi.py` (port 5001) and put
`ML_ENABLED=true`, `ML_SERVICE_URL=http://localhost:5001` and the key in
`backend/.env` (plain http is accepted only for localhost in development).

To switch the model off again, set `ML_ENABLED=false` (or delete it); the rule
engine then scores every payment exactly as before Phase 10.

## Errors

All errors are JSON: `{"error": {"code": "...", "message": "..."}}`.

| Status | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Body is not valid JSON or has no `features` object |
| 401 | `UNAUTHORIZED` | Missing or wrong `X-API-Key` |
| 404 / 405 | `NOT_FOUND` / `METHOD_NOT_ALLOWED` | Wrong path or method |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 8 KB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type is not JSON |
| 422 | `INVALID_FEATURES` | Contract violation; `fields` names each bad key |
| 500 | `INTERNAL_ERROR` | Unexpected failure (details only in the server log) |
