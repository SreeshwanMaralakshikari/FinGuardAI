/**
 * @file services/modelInsightsService.js
 * @description R4-08: what the admin "Model insights" page shows about the ML model in real use, over the
 *   last `days` days (by payment time):
 *     • engines   — how payments were scored: ML / RULES / before Phase 10, why the rules had to take over,
 *                   and how often the policy floor raised a score;
 *     • agreement — ML risk band vs the rule engine's band for the same payments (4 × 4 counts, current bands);
 *     • disagreements — the ML-scored payments where the two engines differed most;
 *     • influence — mean |SHAP| per input over recent ML-scored payments (what the model leaned on live);
 *     • outcomes  — closed cases by engine: fraud confirmed (RESOLVED) vs false alarm (DISMISSED), and how the
 *                   customer's "Was this you?" answers matched the analyst's decision.
 *   Only simple queries and $group stages are used (no $lookup / $abs / $ifNull), so the page also works on the
 *   MongoDB stand-in used by the tests; the arithmetic is done here, on small result sets.
 */
import TransactionModel from '../models/TransactionModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import SystemConfigModel from '../models/SystemConfigModel.js';
import { resolveThresholds, riskLevelForScore } from './fraudDetectionService.js';
import { RISK_LEVELS } from '../utils/enums.js';

export const DEFAULT_INSIGHT_DAYS = 30;
const SAMPLE_LIMIT = 500;      // recent ML-scored payments used for influence and disagreements
const DISAGREEMENT_LIMIT = 10;

const zeroMatrix = () => Object.fromEntries(RISK_LEVELS.map((ml) => [ml, Object.fromEntries(RISK_LEVELS.map((r) => [r, 0]))]));

/** The model's own score of an ML-scored payment (older ML payments have no mlScore: no floor existed then). */
export const modelScoreOf = (t) => t.scoring?.mlScore ?? t.fraudScore;

/**
 * Band agreement between the model and the rules. `rows`: [{ ml, rule, count }].
 * @returns {{ matrix: object, total: number, agree: number, mlHigher: number, rulesHigher: number }}
 */
export const bandAgreement = (rows, bands) => {
  const order = (level) => RISK_LEVELS.indexOf(level);
  const matrix = zeroMatrix();
  let total = 0; let agree = 0; let mlHigher = 0; let rulesHigher = 0;
  for (const { ml, rule, count } of rows) {
    if (!Number.isFinite(ml) || !Number.isFinite(rule)) continue;
    const a = riskLevelForScore(ml, bands);
    const b = riskLevelForScore(rule, bands);
    matrix[a][b] += count;
    total += count;
    if (a === b) agree += count;
    else if (order(a) > order(b)) mlHigher += count;
    else rulesHigher += count;
  }
  return { matrix, total, agree, mlHigher, rulesHigher };
};

/** Mean |SHAP| per feature over the given transactions' stored SHAP values, strongest first. */
export const meanAbsShap = (transactions) => {
  const sums = new Map();
  let n = 0;
  for (const t of transactions) {
    const values = t.scoring?.shapValues;
    if (!Array.isArray(values) || values.length === 0) continue;
    n += 1;
    for (const { feature, label, shap } of values) {
      const entry = sums.get(feature) ?? { feature, label, total: 0 };
      entry.total += Math.abs(Number(shap) || 0);
      sums.set(feature, entry);
    }
  }
  return {
    payments: n,
    features: [...sums.values()]
      .map(({ feature, label, total }) => ({ feature, label, meanAbsShap: Math.round((total / n) * 10000) / 10000 }))
      .sort((a, b) => b.meanAbsShap - a.meanAbsShap),
  };
};

/**
 * @param {{ days?: number, now?: Date }} [options]
 */
export const getModelInsights = async ({ days = DEFAULT_INSIGHT_DAYS, now = new Date() } = {}) => {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const config = await SystemConfigModel.findOne({ singleton: 'system' }).lean();
  const bands = resolveThresholds(config).scoreThresholds;
  const inWindow = { timestamp: { $gte: since } };
  const mlInWindow = { ...inWindow, 'scoring.engine': 'ML' };

  const [engineRows, fallbackRows, floorCount, pairRows, sample, closedCases] = await Promise.all([
    TransactionModel.aggregate([{ $match: inWindow }, { $group: { _id: '$scoring.engine', count: { $sum: 1 } } }]),
    TransactionModel.aggregate([
      { $match: { ...inWindow, 'scoring.engine': 'RULES', 'scoring.fallbackReason': { $exists: true } } },
      { $group: { _id: '$scoring.fallbackReason', count: { $sum: 1 } } },
    ]),
    TransactionModel.countDocuments({ ...mlInWindow, 'scoring.ruleFloor': true }),
    TransactionModel.aggregate([
      { $match: mlInWindow },
      { $group: { _id: { ml: '$scoring.mlScore', final: '$fraudScore', rule: '$scoring.ruleScore' }, count: { $sum: 1 } } },
    ]),
    TransactionModel.find(mlInWindow)
      .select('publicId amount merchantName riskLevel fraudScore status timestamp scoring.mlScore scoring.ruleScore scoring.ruleFloor scoring.shapValues')
      .sort({ timestamp: -1, _id: -1 })
      .limit(SAMPLE_LIMIT)
      .lean(),
    FraudCaseModel.find({ status: { $in: ['RESOLVED', 'DISMISSED'] }, resolvedAt: { $gte: since } })
      .select('status transactionId')
      .lean(),
  ]);

  const engines = { ML: 0, RULES: 0, LEGACY: 0 };
  for (const { _id, count } of engineRows) engines[_id ?? 'LEGACY'] = (engines[_id ?? 'LEGACY'] ?? 0) + count;
  const fallbacks = Object.fromEntries(fallbackRows.map(({ _id, count }) => [_id, count]));

  const agreement = bandAgreement(
    pairRows.map(({ _id, count }) => ({ ml: _id.ml ?? _id.final, rule: _id.rule, count })),
    bands,
  );

  const disagreements = sample
    .map((t) => {
      const ml = modelScoreOf(t);
      const rule = t.scoring?.ruleScore;
      return {
        id: t._id,
        publicId: t.publicId,
        amount: t.amount,
        merchantName: t.merchantName,
        timestamp: t.timestamp,
        status: t.status,
        riskLevel: t.riskLevel,
        fraudScore: t.fraudScore,
        mlScore: ml,
        ruleScore: rule,
        ruleFloor: Boolean(t.scoring?.ruleFloor),
        mlBand: riskLevelForScore(ml, bands),
        ruleBand: Number.isFinite(rule) ? riskLevelForScore(rule, bands) : null,
      };
    })
    .filter((d) => d.ruleBand && d.mlBand !== d.ruleBand)
    .sort((a, b) => Math.abs(b.mlScore - b.ruleScore) - Math.abs(a.mlScore - a.ruleScore))
    .slice(0, DISAGREEMENT_LIMIT);

  // Outcomes of closed cases, by the engine that scored the payment, and against the customer's answer.
  const txIds = closedCases.map((c) => c.transactionId).filter(Boolean);
  const caseTx = txIds.length
    ? await TransactionModel.find({ _id: { $in: txIds } }).select('scoring.engine customerResponse.answer').lean()
    : [];
  const byId = new Map(caseTx.map((t) => [String(t._id), t]));
  const outcomes = { ML: { confirmed: 0, dismissed: 0 }, RULES: { confirmed: 0, dismissed: 0 }, LEGACY: { confirmed: 0, dismissed: 0 } };
  const answers = { DISPUTED: { confirmed: 0, dismissed: 0 }, CONFIRMED: { confirmed: 0, dismissed: 0 }, NONE: { confirmed: 0, dismissed: 0 } };
  for (const c of closedCases) {
    const t = byId.get(String(c.transactionId));
    const key = c.status === 'RESOLVED' ? 'confirmed' : 'dismissed';
    outcomes[t?.scoring?.engine ?? 'LEGACY'][key] += 1;
    answers[t?.customerResponse?.answer ?? 'NONE'][key] += 1;
  }

  return {
    windowDays: days,
    since,
    bands,
    engines,
    fallbacks,
    floorRaised: floorCount,
    agreement,
    disagreements,
    influence: meanAbsShap(sample),
    outcomes,
    customerAnswers: answers,
  };
};
