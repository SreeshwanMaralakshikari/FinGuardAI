/**
 * @file src/components/modelcard/modelFacts.js
 * @description R4-09: the facts on the public model card (/model), copied from the ML service's own reports:
 *   ml-service/model/model_meta.json, ml-service/reports/metrics.json and ml-service/reports/rule_floor_metrics.json.
 *   A frontend test compares these numbers with those files, so a retrained model cannot leave a stale card.
 */
export const MODEL = Object.freeze({
  version: 'fg-xgb-1.1.0',
  trainedAt: '2026-10-14',
  algorithm: 'XGBoost gradient-boosted trees (binary:logistic), 177 trees of depth ≤ 5',
  xgboostVersion: '3.4.1',
  inputs: 15,
  modelColumns: 18,
});

export const DATASET = Object.freeze({
  payments: 769782,
  customers: 8000,
  fraudRate: 0.00645,
  trainPayments: 541410,
  validationPayments: 114798,
  testPayments: 113574,
  testCustomers: 1200,
});

/** Test set, default bands (MEDIUM ≥ 25, HIGH ≥ 50, CRITICAL ≥ 75). */
export const METRICS = Object.freeze({
  ml:    { rocAuc: 0.9328, prAuc: 0.7682, brier: 0.002144, high: { precision: 0.9118, recall: 0.6816, fp: 47 }, medium: { precision: 0.8165, recall: 0.7237, fp: 116, flaggedShare: 0.00556 } },
  rules: { rocAuc: 0.8429, prAuc: 0.3266, high: { precision: 0.5102, recall: 0.352, fp: 241 }, medium: { precision: 0.0547, recall: 0.7616, fp: 9375, flaggedShare: 0.08733 } },
  floor: { high: { precision: 0.9118, recall: 0.6816, fp: 47 }, medium: { fp: 2449, flaggedShare: 0.02634 } },
});

/** Share of each fraud scenario held or blocked (score ≥ 50) on the test set. */
export const SCENARIOS = Object.freeze([
  { key: 'card_testing',       label: 'Card testing',       payments: 233, ml: 0.9056, rules: 0.5408 },
  { key: 'account_takeover',   label: 'Account takeover',   payments: 131, ml: 0.8855, rules: 0.5115 },
  { key: 'sim_swap',           label: 'SIM swap',           payments: 55,  ml: 0.8727, rules: 0.4182 },
  { key: 'new_account_fraud',  label: 'New-account fraud',  payments: 124, ml: 0.7984, rules: 0.0161 },
  { key: 'mule_cashout',       label: 'Mule cash-out',      payments: 53,  ml: 0.434,  rules: 0.7358 },
  { key: 'social_engineering', label: 'Social engineering', payments: 41,  ml: 0.0244, rules: 0 },
  { key: 'low_and_slow',       label: 'Low-and-slow',       payments: 30,  ml: 0,      rules: 0 },
]);

/** Calibration: predicted probability vs how often those payments really were fraud. */
export const CALIBRATION = Object.freeze([
  { range: '0–5 %',    payments: 112593, predicted: 0.0016, observed: 0.0013 },
  { range: '5–25 %',   payments: 350,    predicted: 0.1005, observed: 0.1343 },
  { range: '25–50 %',  payments: 100,    predicted: 0.3776, observed: 0.32 },
  { range: '50–75 %',  payments: 51,     predicted: 0.6094, observed: 0.5882 },
  { range: '75–100 %', payments: 480,    predicted: 0.9726, observed: 0.9458 },
]);

/** Mean |SHAP| (log-odds) per input on the test set; the four payment-method columns are summed. */
export const IMPORTANCE = Object.freeze([
  { feature: 'amountToAvgRatio',      label: 'Amount vs usual average',         value: 0.4393 },
  { feature: 'isNewCity',             label: 'New city for this customer',      value: 0.3515 },
  { feature: 'deviceReputationScore', label: 'Device trust score',              value: 0.3423 },
  { feature: 'amount',                label: 'Payment amount',                  value: 0.333 },
  { feature: 'isNewDevice',           label: 'New device for this customer',    value: 0.2705 },
  { feature: 'paymentMethod',         label: 'Payment method',                  value: 0.2462 },
  { feature: 'txnsLastHour',          label: 'Payments in the last hour',       value: 0.1898 },
  { feature: 'hourOfDay',             label: 'Hour of day',                     value: 0.1654 },
  { feature: 'isHighRiskMerchant',    label: 'High-risk merchant category',     value: 0.1447 },
  { feature: 'txnsLastDay',           label: 'Payments in the last 24 hours',   value: 0.1306 },
  { feature: 'amountToMaxRatio',      label: 'Amount vs largest earlier payment', value: 0.1201 },
  { feature: 'hasProfile',            label: 'Has payment history',             value: 0.1189 },
  { feature: 'isUnusualHour',         label: 'Unusual hour for this customer',  value: 0.0896 },
  { feature: 'isNewPaymentMethod',    label: 'New payment method',              value: 0.0009 },
  { feature: 'deviceIsBlacklisted',   label: 'Device blacklisted',              value: 0 },
]);
