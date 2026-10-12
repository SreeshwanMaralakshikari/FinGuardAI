/**
 * @file src/components/common/ScoreBreakdown.jsx
 * @description B-01: "why this score" — a segmented bar (one segment per scoring rule, width =
 *   points / total of the rules' maximums) plus a table of rule, points and maximum.
 *   Backend shape: scoreBreakdown = [{ rule, label, points, max }] (six entries; legacy rows: []).
 *   Accessibility: the bar is one image with a text summary (aria-label); the table repeats every
 *   value as text, and each row carries a numbered marker that is also printed on its bar segment
 *   when it is wide enough — colour is never the only cue. Renders nothing when there is no data.
 *   Colours: complete class strings; every segment is white text on a -700 shade (>= 4.5:1, checked in tests).
 */
import { normaliseBreakdown } from '../../utils/scoreBreakdown.js';

const SEGMENT = [
  'bg-sky-700 text-white',
  'bg-amber-700 text-white',
  'bg-emerald-700 text-white',
  'bg-fuchsia-700 text-white',
  'bg-orange-700 text-white',
  'bg-slate-700 text-white',
];

/**
 * @param {{ breakdown?: Array<{rule:string,label:string,points:number,max:number}>, title?: string, fraudScore?: number }} props
 *   fraudScore (optional): when the rule points add up to more than the 0-100 score, a note explains the cap.
 */
export default function ScoreBreakdown({ breakdown, title = 'Score breakdown', fraudScore }) {
  const { rows, scale, total } = normaliseBreakdown(breakdown);
  if (rows.length === 0) return null;

  const summary = `${title}: ${total} points in total. ${rows.map((r) => `${r.label} ${r.points} of ${r.max}`).join('; ')}.`;

  return (
    <section aria-label={title} data-testid="score-breakdown">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</p>
      <div role="img" aria-label={summary} className="flex h-6 w-full overflow-hidden rounded bg-gray-100">
        {scale > 0 && rows.map((r, i) => (r.points > 0 ? (
          <div
            key={r.rule ?? i}
            className={`flex items-center justify-center text-xs font-semibold ${SEGMENT[i % SEGMENT.length]}`}
            style={{ width: `${(r.points / scale) * 100}%` }}
            title={`${r.label}: ${r.points} of ${r.max}`}
            aria-hidden="true"
          >
            {(r.points / scale) >= 0.06 ? i + 1 : ''}
          </div>
        ) : null))}
      </div>
      {total === 0 && <p className="mt-1 text-xs text-gray-500">No rule added any points.</p>}
      <table className="mt-3 w-full text-sm">
        <caption className="sr-only">{title}: points per scoring rule</caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
            <th scope="col" className="py-1 pr-2 font-semibold">Rule</th>
            <th scope="col" className="py-1 text-right font-semibold">Points</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r, i) => (
            <tr key={r.rule ?? i}>
              <th scope="row" className="py-1 pr-2 text-left font-normal text-gray-700">
                <span className={`mr-2 inline-flex h-5 w-5 items-center justify-center rounded text-xs font-semibold ${SEGMENT[i % SEGMENT.length]}`} aria-hidden="true">{i + 1}</span>
                {r.label}
              </th>
              <td className="py-1 text-right tabular-nums text-gray-700">{r.points} / {r.max}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-gray-200 font-semibold text-gray-900">
            <th scope="row" className="py-1 pr-2 text-left">Total</th>
            <td className="py-1 text-right tabular-nums">{total}</td>
          </tr>
        </tfoot>
      </table>
      {Number.isFinite(fraudScore) && total > fraudScore && (
        <p className="mt-2 text-xs text-gray-500">The rule points add up to {total}; the fraud score is capped at {fraudScore}.</p>
      )}
    </section>
  );
}
