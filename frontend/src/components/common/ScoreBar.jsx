/**
 * @file src/components/common/ScoreBar.jsx
 * @description 0–100 horizontal bar. The fill colour is looked up from complete class strings
 *   (no concatenation) according to the score bands of the fraud engine defaults.
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
 * @param {{ value: number, invert?: boolean, label?: string }} props
 *   invert: higher is better (reputation, trust) → colour bands flip.
 */
export default function ScoreBar({ value = 0, invert = false, label = 'Score' }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 w-full rounded-full bg-gray-100" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v}>
        <div className={FILL[bandOf(v, invert)]} style={{ width: `${v}%` }} />
      </div>
      <span className="w-10 text-right text-sm font-semibold text-gray-700">{v}</span>
    </div>
  );
}
