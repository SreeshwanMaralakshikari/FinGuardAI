/**
 * @file src/components/common/ScoringPipeline.jsx
 * @description R4-04: how a payment was scored, as three steps — rule engine → ML model → decision —
 *   with the real numbers of THIS payment (Transaction.scoring): both scores, the model version and the
 *   time the model took, why the rules decided when the model was not used, and whether the policy
 *   floor raised the score. A single scan sweep runs once when the result appears (not under reduced motion).
 */
import { fallbackText } from '../../utils/mlExplanation.js';

const DECISION_TEXT = {
  APPROVE: 'Approved',
  OTP: 'Approved, customer alerted',
  HOLD: 'Held for an analyst',
  BLOCK: 'Blocked',
};

function Step({ title, value, detail, highlight = false }) {
  return (
    <li className={`relative flex-1 rounded-lg border px-4 py-3 ${highlight ? 'border-primary-500 bg-primary-50' : 'border-gray-200 bg-white'}`}>
      <p className="text-xs font-medium text-gray-500">{title}</p>
      <p className="mt-0.5 font-display text-2xl font-bold tabular-nums text-gray-900">{value}</p>
      {detail && <p className="mt-0.5 text-xs text-gray-600">{detail}</p>}
    </li>
  );
}

/** @param {{ result: { fraudScore: number, riskLevel: string, recommendedAction: string, scoring?: object|null } }} props */
export default function ScoringPipeline({ result }) {
  const s = result.scoring;
  const ruleScore = s?.ruleScore ?? result.fraudScore;
  let ml;
  if (s?.engine === 'ML') {
    const parts = [s.modelVersion, Number.isFinite(s.mlLatencyMs) ? `${s.mlLatencyMs} ms` : null].filter(Boolean);
    ml = { value: `${s.mlScore ?? result.fraudScore}/100`, detail: parts.join(', ') };
  } else if (s?.fallbackReason) {
    ml = { value: 'Not used', detail: fallbackText(s).replace(', so the rule engine scored this payment.', '.') };
  } else {
    ml = { value: 'Off', detail: 'The rule engine scored this payment.' };
  }
  const decided = s?.engine === 'ML' ? (s.ruleFloor ? 'Model, raised by the policy floor' : 'Model') : 'Rule engine';

  return (
    <section aria-label="How this payment was scored" data-testid="scoring-pipeline">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">How it was scored</p>
      <div className="relative overflow-hidden rounded-xl">
        <ol className="flex flex-col gap-2 sm:flex-row">
          <Step title="1. Rule engine" value={`${ruleScore}/100`} detail="Six warning-sign rules" />
          <Step title="2. ML model" value={ml.value} detail={ml.detail} />
          <Step
            title="3. Decision"
            value={`${result.riskLevel} · ${result.fraudScore}`}
            detail={`${DECISION_TEXT[result.recommendedAction] ?? result.recommendedAction}. Decided by: ${decided}.`}
            highlight
          />
        </ol>
        <span className="pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 animate-[scan-sweep_1.4s_ease-out_1] bg-gradient-to-r from-transparent via-primary-400/25 to-transparent opacity-0 motion-reduce:hidden" aria-hidden="true" />
      </div>
    </section>
  );
}
