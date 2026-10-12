/**
 * @file src/components/common/ScoreBar.jsx
 * @description 0–100 horizontal bar. The fill colour is looked up from complete class strings
 *   (no concatenation).
 *   F-06: for a FRAUD score pass `riskLevel` (the level the server computed with the LIVE admin
 *   thresholds) — the bar then always matches the badge next to it. Without it (reputation / trust
 *   scores, or no level available) the fixed 25/50/75 default bands are used.
 */
const FILL = {
  LOW:      'h-2 rounded-full bg-emerald-500',
  MEDIUM:   'h-2 rounded-full bg-yellow-500',
  HIGH:     'h-2 rounded-full bg-orange-500',
  CRITICAL: 'h-2 rounded-full bg-red-600',
};

const bandOf = (score, invert) => {
  const s = invert ? 100 - score : score;
  if (s >= 75) return 'CRITICAL';
  if (s >= 50) return 'HIGH';
  if (s >= 25) return 'MEDIUM';
  return 'LOW';
};

/**
 * @param {{ value: number, invert?: boolean, label?: string, riskLevel?: string }} props
 *   invert: higher is better (reputation, trust) → colour bands flip.
 *   riskLevel: LOW | MEDIUM | HIGH | CRITICAL — overrides the score bands (F-06).
 */
export default function ScoreBar({ value = 0, invert = false, label = 'Score', riskLevel = null }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const fill = FILL[riskLevel] ?? FILL[bandOf(v, invert)];
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 w-full rounded-full bg-gray-100" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v}>
        <div className={fill} style={{ width: `${v}%` }} />
      </div>
      <span className="w-10 text-right text-sm font-semibold text-gray-700">{v}</span>
    </div>
  );
}
