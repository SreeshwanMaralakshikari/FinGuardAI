/**
 * @file src/components/common/MlExplanation.jsx
 * @description Phase 10: "why the ML model gave this score" — SHAP values as a diverging bar list.
 *   Backend shape (Transaction.scoring, engine 'ML'):
 *     { modelVersion, fraudProbability, ruleScore, shapValues: [{ feature, label, value, shap }] }
 *   shap > 0 pushed the payment towards fraud (bar to the right, red), shap < 0 towards safe
 *   (bar to the left, blue). Bars are scaled to the strongest factor of THIS payment.
 *   Accessibility: every value is repeated as text (label, value, signed SHAP, "raises/lowers risk"),
 *   so colour and direction are never the only cue; the bars themselves are aria-hidden.
 *   Colours: red-700 / sky-700 (diverging pair, both ≥ 3:1 on white; validated for colour-blind separation).
 */
import { useState } from 'react';

const TOP = 6;           // factors shown before "Show all"
const MIN_VISIBLE = 0.005; // smaller pushes are noise at this resolution

const signed = (v) => (Math.abs(v) < MIN_VISIBLE ? '0.00' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`);
const direction = (v) => {
  if (Math.abs(v) < MIN_VISIBLE) return 'no effect';
  return v > 0 ? 'raises risk' : 'lowers risk';
};

/**
 * @param {{ scoring: { modelVersion?: string, ruleScore?: number, shapValues?: Array<{feature:string,label:string,value:string,shap:number}> } }} props
 */
export default function MlExplanation({ scoring }) {
  const [showAll, setShowAll] = useState(false);
  const values = Array.isArray(scoring?.shapValues)
    ? scoring.shapValues.filter((v) => v && Number.isFinite(Number(v.shap)))
    : [];
  const ranked = [...values].sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap));
  const meaningful = ranked.filter((v) => Math.abs(v.shap) >= MIN_VISIBLE);
  const shown = showAll ? ranked : meaningful.slice(0, TOP);
  const scale = Math.max(...ranked.map((v) => Math.abs(v.shap)), 0);

  return (
    <section aria-label="ML model explanation" data-testid="ml-explanation">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">What moved the ML score</p>
        <p className="text-xs text-gray-500">
          Scored by the ML model{scoring?.modelVersion ? ` (${scoring.modelVersion})` : ''}
          {Number.isFinite(scoring?.ruleScore) && <> · rule engine would give {scoring.ruleScore}/100</>}
        </p>
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-gray-500">No single detail moved the score noticeably.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((v) => {
            const up = v.shap >= 0;
            const width = scale > 0 ? (Math.abs(v.shap) / scale) * 50 : 0; // % of the full row; each side is 50 %
            return (
              <li key={v.feature} className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,14rem)_1fr_7rem] sm:items-center sm:gap-3">
                <span className="text-sm text-gray-700">
                  {v.label}: <span className="font-medium text-gray-900">{v.value}</span>
                </span>
                <span className="relative h-4 w-full rounded bg-gray-50" aria-hidden="true" title={`${v.label}: ${signed(v.shap)}`}>
                  <span className="absolute inset-y-0 left-1/2 w-px bg-gray-300" />
                  <span
                    className={`absolute inset-y-0.5 ${up ? 'left-1/2 rounded-r bg-red-700' : 'right-1/2 rounded-l bg-sky-700'}`}
                    style={{ width: `${width}%` }}
                  />
                </span>
                <span className="text-xs tabular-nums text-gray-600 sm:text-right">
                  {signed(v.shap)} · {direction(v.shap)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {ranked.length > TOP && (
        <button type="button" className="mt-3 text-sm font-medium text-primary-600 hover:underline" onClick={() => setShowAll((s) => !s)} aria-expanded={showAll}>
          {showAll ? 'Show fewer factors' : `Show all ${ranked.length} factors`}
        </button>
      )}

      <p className="mt-3 text-xs text-gray-500">
        These are SHAP values: how far each detail pushed this payment&apos;s score above (red, right) or below
        (blue, left) the model&apos;s average payment. Longer bars mattered more.
      </p>
    </section>
  );
}
