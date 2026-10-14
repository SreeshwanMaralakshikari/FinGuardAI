/**
 * @file services/scoringService.js
 * @description Phase 10: decides which engine scores a payment.
 *
 *   1. The rule engine (checkFraud, pure) ALWAYS runs: it is instant, it is the fallback, and its
 *      per-rule breakdown (B-01) stays available for comparison.
 *   2. When ML is enabled, the ML service is asked next. If it answers in time with a valid result,
 *      its score decides the payment: the SAME bands, actions and loss multipliers as the rules
 *      (decisionForScore), so the admin thresholds page keeps working unchanged.
 *   3. If ML is off, slow, asleep or wrong in any way, the rule result is used unchanged and the reason
 *      is recorded (scoring.fallbackReason). A payment is never refused because of the ML service.
 *   4. Rule floor (alert only): a blacklisted device, a merchant category on the admin's high-risk list and
 *      an amount above the admin's high-value threshold are explicit POLICY. When the rules see one and rate
 *      the payment MEDIUM or higher, the ML score is raised to the rule score, capped just below HIGH
 *      (scoring.ruleFloor = true; scoring.mlScore keeps the model's own score). Such a payment therefore
 *      always raises an alert, but only the model can hold or block it. Why: the model learned that an amount
 *      alone, or a casino payment from a known device, is not fraud (it scored a ₹50 crore payment from the
 *      customer's own phone 2/100). Measured on the test set (ml-service/training/evaluate_floor.py): HIGH
 *      results unchanged (precision 0.912, 47 false alarms); MEDIUM alerts rise from 0.56 % to 2.63 % of
 *      payments. An uncapped floor raised HIGH false alarms to 269, so it was rejected.
 *
 *   Returned object = checkFraud's result shape ({ fraudScore, riskLevel, reasons, recommendedAction,
 *   estimatedLoss, signals, breakdown, rawScore }) plus `scoring`, stored on the Transaction:
 *     { engine: 'ML'|'RULES', ruleScore, mlScore?, ruleFloor?, modelVersion?, fraudProbability?,
 *       fallbackReason?, signals?, shapBaseValue?, shapValues?: [{ feature, label, value, shap }] }
 */
import { checkFraud, decisionForScore, resolveThresholds, hardRuleSignals } from './fraudDetectionService.js';
import { buildMlFeatures, ML_FEATURE_LABELS, ML_FEATURE_ALERT_TYPES } from './mlFeatureBuilder.js';
import { createMlClient, MlScoringError } from './mlClient.js';
import { getMlSettings } from '../config/mlSettings.js';

/** Shown when the model rates a payment risky but no single feature crossed the reason threshold. */
export const GENERIC_ML_REASON = 'The ML model found this combination of payment details unusual for this customer';

// ─── The process-wide client (created lazily from the environment) ────────────────────────────────
let sharedClient;  // undefined = not built yet; null = ML disabled

/** The configured ML client, or null when ML is disabled. */
export const getMlClient = () => {
  if (sharedClient === undefined) {
    const settings = getMlSettings();
    sharedClient = settings.enabled ? createMlClient(settings) : null;
  }
  return sharedClient;
};

/** Tests only: replace (or with no argument, reset) the shared client. */
export const setMlClientForTests = (client) => { sharedClient = client; };

/** Distinct alert types of the features behind the ML reasons (feeds the FraudAlert alertType). */
export const signalsFromReasonFeatures = (reasonFeatures) =>
  [...new Set(reasonFeatures.map((f) => ML_FEATURE_ALERT_TYPES[f]).filter(Boolean))];

/**
 * E-08: the alert types of a flagged ML payment. Normally the features behind its reasons; when none of
 * them maps to a type (generic reason, or only "new payment method" / "no history"), the strongest
 * positive SHAP feature that has a type, then the rule engine's own signals. Without this the alert was
 * labelled COMPOSITE ("several rules fired"), which is wrong for a single model finding.
 */
export const signalsForMlAlert = (prediction, ruleSignals) => {
  const fromReasons = signalsFromReasonFeatures(prediction.reasonFeatures);
  if (fromReasons.length > 0) return fromReasons;
  const strongest = prediction.contributions
    .filter((c) => c.shap > 0 && ML_FEATURE_ALERT_TYPES[c.feature])
    .sort((a, b) => b.shap - a.shap)[0];
  if (strongest) return [ML_FEATURE_ALERT_TYPES[strongest.feature]];
  return [...ruleSignals];
};

/**
 * Rule floor (alert only): the raised score, or null when the floor does not apply.
 * @param {number} mlScore
 * @param {number} ruleScore
 * @param {boolean} hard   a hard rule signal fired (hardRuleSignals)
 * @param {{ mediumMin: number, highMin: number }} bands  the effective admin bands
 */
export const applyRuleFloor = (mlScore, ruleScore, hard, { mediumMin, highMin }) => {
  if (!hard || ruleScore < mediumMin) return null;
  const floor = Math.min(ruleScore, highMin - 1);
  return floor > mlScore ? floor : null;
};

/** SHAP values with a label and a readable value, strongest first (the service already sorts them). */
const describeContributions = (contributions) => contributions.map(({ feature, value, shap }) => ({
  feature,
  label: ML_FEATURE_LABELS[feature].label,
  value: ML_FEATURE_LABELS[feature].format(value),
  shap: Math.round(shap * 1e6) / 1e6,
}));

/**
 * Score one payment.
 * @param {object} args
 * @param {object} args.transaction       { amount, merchantName, merchantCategory, paymentMethod, location, deviceId, userId, timestamp }
 * @param {object|null} args.behaviorProfile  lean profile WITH live transactionVelocity (as built in transactionService)
 * @param {object|null} args.deviceReputation
 * @param {object|null} args.thresholds   SystemConfig (lean) or null
 * @param {string} [args.requestId]       forwarded to the ML service logs
 * @param {object|null} [args.mlClient]   defaults to the shared client; null forces the rules
 */
export const scoreTransaction = async ({
  transaction, behaviorProfile, deviceReputation, thresholds, requestId, mlClient = getMlClient(),
}) => {
  const rules = checkFraud({ transaction, behaviorProfile, deviceReputation, thresholds });
  const ruleScoring = { engine: 'RULES', ruleScore: rules.fraudScore };
  if (!mlClient) return { ...rules, scoring: ruleScoring };

  const effective = resolveThresholds(thresholds);
  let prediction;
  try {
    const features = buildMlFeatures({
      transaction,
      behaviorProfile,
      deviceReputation,
      velocity: behaviorProfile?.transactionVelocity ?? { perHour: 0, perDay: 0 },
      highRiskMerchants: effective.highRiskMerchants,
    });
    prediction = await mlClient.predict(features, { requestId });
  } catch (err) {
    const fallbackReason = err instanceof MlScoringError ? err.code : 'ERROR';
    if (fallbackReason === 'ERROR') console.error('[scoringService] unexpected ML error — rule engine used:', err);
    // E-06: the same id is in the ML service's log line (X-Request-Id), so the two can be matched.
    else if (fallbackReason !== 'COOLDOWN') console.warn(`[scoringService] ML not used (${fallbackReason}); rule engine scored request ${requestId ?? '(no id)'}`);
    return { ...rules, scoring: { ...ruleScoring, fallbackReason } };
  }

  const mlScore = prediction.fraudScore;
  const hard = hardRuleSignals({ transaction, deviceReputation, thresholds });
  const floored = applyRuleFloor(mlScore, rules.fraudScore, hard.length > 0, effective.scoreThresholds);
  const fraudScore = floored ?? mlScore;
  const { riskLevel, recommendedAction, estimatedLoss } =
    decisionForScore(fraudScore, transaction.amount, effective.scoreThresholds);

  // Reasons are shown for flagged payments only: on a LOW payment the model's small positive pushes
  // (e.g. "new device" alone) would read as accusations although the payment was treated as normal.
  // The SHAP values below still explain every payment, LOW included.
  // When the floor raised the score, the hard rule finding comes first: it is why the payment was flagged.
  let reasons = [];
  let signals;
  if (floored !== null) {
    // the model's own sentence for the same fact ("Merchant category is on the high-risk list") is dropped
    const covered = new Set(hard.map((h) => h.feature));
    const modelReasons = prediction.reasons.filter((_, i) => !covered.has(prediction.reasonFeatures[i]));
    reasons = [...new Set([...hard.map((h) => h.reason), ...modelReasons])];
    signals = [...new Set([...hard.map((h) => h.type), ...signalsFromReasonFeatures(prediction.reasonFeatures)])];
  } else if (riskLevel !== 'LOW') {
    reasons = prediction.reasons.length > 0 ? [...prediction.reasons] : [GENERIC_ML_REASON];
    signals = signalsForMlAlert(prediction, rules.signals);
  } else {
    signals = signalsFromReasonFeatures(prediction.reasonFeatures);
  }

  return {
    fraudScore,
    riskLevel,
    reasons,
    recommendedAction,
    estimatedLoss,
    signals,
    breakdown: rules.breakdown,   // the rules' view, kept for comparison (B-01)
    rawScore: rules.rawScore,
    scoring: {
      engine: 'ML',
      ruleScore: rules.fraudScore,
      mlScore,                                         // the model's own score (fraudScore differs only with the floor)
      ...(floored !== null ? { ruleFloor: true } : {}),
      modelVersion: prediction.modelVersion,
      fraudProbability: prediction.fraudProbability,
      signals,
      shapBaseValue: prediction.baseValue,
      shapValues: describeContributions(prediction.contributions),
    },
  };
};
