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
 *
 *   Returned object = checkFraud's result shape ({ fraudScore, riskLevel, reasons, recommendedAction,
 *   estimatedLoss, signals, breakdown, rawScore }) plus `scoring`, stored on the Transaction:
 *     { engine: 'ML'|'RULES', ruleScore, modelVersion?, fraudProbability?, fallbackReason?,
 *       signals?, shapBaseValue?, shapValues?: [{ feature, label, value, shap }] }
 */
import { checkFraud, decisionForScore, resolveThresholds } from './fraudDetectionService.js';
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
    return { ...rules, scoring: { ...ruleScoring, fallbackReason } };
  }

  const { fraudScore } = prediction;
  const { riskLevel, recommendedAction, estimatedLoss } =
    decisionForScore(fraudScore, transaction.amount, effective.scoreThresholds);
  const signals = signalsFromReasonFeatures(prediction.reasonFeatures);

  // Reasons are shown for flagged payments only: on a LOW payment the model's small positive pushes
  // (e.g. "new device" alone) would read as accusations although the payment was treated as normal.
  // The SHAP values below still explain every payment, LOW included.
  let reasons = [];
  if (riskLevel !== 'LOW') reasons = prediction.reasons.length > 0 ? [...prediction.reasons] : [GENERIC_ML_REASON];

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
      modelVersion: prediction.modelVersion,
      fraudProbability: prediction.fraudProbability,
      signals,
      shapBaseValue: prediction.baseValue,
      shapValues: describeContributions(prediction.contributions),
    },
  };
};
