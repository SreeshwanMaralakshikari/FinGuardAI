/**
 * @file src/components/charts/BarCard.jsx
 * @description Single-series bar chart card (recharts) with a plain-table fallback.
 *   One measure, one axis, a title that names the series (so no legend box), 4px-rounded
 *   data ends, recessive grid. `xLabel` / `yLabel` name the table columns (N-21). `colors` (optional) colours bars per datum for ordered
 *   categories (risk levels); otherwise the brand blue is used.
 */
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CARD } from '../../utils/common.js';

const BRAND = '#2563eb';

export default function BarCard({ title, subtitle, data, xKey, xLabel = null, yKey = 'count', yLabel = 'Count', colors = null, height = 240 }) {
  const empty = !data || data.every((d) => !d[yKey]);
  return (
    <section className={`${CARD.base} p-5`} aria-label={title}>
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
      {empty ? (
        <p className="py-16 text-center text-sm text-gray-500">No data for this period.</p>
      ) : (
        <>
          <div className="mt-4" style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={{ stroke: '#d1d5db' }} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: 'rgba(37,99,235,0.06)' }} formatter={(v) => [v, yLabel]} />
                <Bar dataKey={yKey} radius={[4, 4, 0, 0]} maxBarSize={36}>
                  {data.map((d, i) => <Cell key={`${String(d[xKey])}-${i}`} fill={colors?.[d[xKey]] ?? BRAND} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <details className="mt-3 text-xs text-gray-500">
            <summary className="cursor-pointer select-none">View as table</summary>
            <table className="mt-2 w-full text-left">
              <thead><tr><th className="py-1 pr-4 font-medium">{xLabel ?? xKey}</th><th className="py-1 font-medium">{yLabel}</th></tr></thead>
              <tbody>{data.map((d, i) => <tr key={`${String(d[xKey])}-${i}`}><td className="py-0.5 pr-4">{String(d[xKey])}</td><td className="py-0.5">{d[yKey]}</td></tr>)}</tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}
