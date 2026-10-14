/**
 * @file src/components/common/FraudExplanation.jsx
 * @description Phase 10: one place that explains a fraud score, whichever engine produced it.
 *   - scoring.engine 'ML'    → the SHAP explanation, then the rule breakdown labelled as a comparison
 *                              (its points do NOT add up to the ML score, so no "capped" note is shown);
 *                              with scoring.ruleFloor the rule check set the minimum score, and says so
 *   - scoring.engine 'RULES' → the rule breakdown as before, plus a note when ML was on but not used
 *   - no scoring (transactions scored before Phase 10) → exactly the old ScoreBreakdown
 */
import ScoreBreakdown from './ScoreBreakdown.jsx';
import MlExplanation from './MlExplanation.jsx';
import { fallbackText } from '../../utils/mlExplanation.js';

/**
 * @param {{ scoring?: object|null, breakdown?: Array, fraudScore?: number }} props
 */
export default function FraudExplanation({ scoring, breakdown, fraudScore }) {
  if (scoring?.engine === 'ML') {
    return (
      <div className="space-y-6">
        <MlExplanation scoring={scoring} />
        <ScoreBreakdown
          breakdown={breakdown}
          title={scoring.ruleFloor ? 'Rule engine check (set the minimum score)' : 'Rule engine check (for comparison)'}
        />
      </div>
    );
  }
  const fallback = fallbackText(scoring);
  return (
    <div className="space-y-2">
      {fallback && <p className="text-xs text-gray-500" data-testid="ml-fallback-note">{fallback}</p>}
      <ScoreBreakdown breakdown={breakdown} fraudScore={fraudScore} />
    </div>
  );
}
