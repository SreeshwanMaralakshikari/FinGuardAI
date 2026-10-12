/** @file B-01 helper for components/common/ScoreBreakdown.jsx */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Pure helper: rows with numeric points / max and the bar scale. */
export function normaliseBreakdown(breakdown) {
  if (!Array.isArray(breakdown)) return { rows: [], scale: 0, total: 0 };
  const rows = breakdown
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({ rule: r.rule, label: r.label || String(r.rule ?? 'Rule'), points: Math.max(0, num(r.points)), max: Math.max(0, num(r.max)) }));
  const scale = rows.reduce((s, r) => s + Math.max(r.max, r.points), 0);
  const total = rows.reduce((s, r) => s + r.points, 0);
  return { rows, scale, total };
}

