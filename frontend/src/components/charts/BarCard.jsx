/**
 * @file src/components/charts/BarCard.jsx
 * @description Single-series bar chart card (recharts) with a plain-table fallback.
 *   One measure, one axis, a title that names the series (so no legend box), 4px-rounded
 *   data ends, recessive grid. `xLabel` / `yLabel` name the table columns (N-21). `fullKey` (optional) names a
 *   field with the long form of the x label (A-01: a device id + its account count): the chart tooltip and the
 *   "View as table" rows show it, the axis shows the short `xKey` text. `colors` (optional) colours bars per datum for ordered
 *   categories (risk levels); otherwise the brand colour is used. `colors` values may be keys of
 *   useChartColors (e.g. 'LOW'), resolved for the active theme.
 */
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CARD } from '../../utils/common.js';
import { useChartColors, tooltipStyles } from '../../hooks/useChartColors.js';

export default function BarCard({ title, subtitle, data, xKey, xLabel = null, yKey = 'count', yLabel = 'Count', colors = null, fullKey = null, height = 240 }) {
  const empty = !data || data.every((d) => !d[yKey]);
  const c = useChartColors(); // R4-01: theme-aware colours
  return (
    <section className={`${CARD.base} p-5`} aria-label={title}>
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
      {empty ? (
        <p className="py-16 text-center text-sm text-gray-500">No data for this period.</p>
      ) : (
        <>
          <div className="mt-4" style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke={c.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: c.tick }} tickLine={false} axisLine={{ stroke: c.axis }} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: c.tick }} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: c.grid, fillOpacity: 0.4 }}
                  {...tooltipStyles(c)}
                  formatter={(v) => [v, yLabel]}
                  labelFormatter={(label, payload) => (fullKey ? payload?.[0]?.payload?.[fullKey] : null) ?? label}
                />
                <Bar dataKey={yKey} radius={[4, 4, 0, 0]} maxBarSize={36}>
                  {data.map((d, i) => <Cell key={`${String(d[xKey])}-${i}`} fill={c[colors?.[d[xKey]]] ?? colors?.[d[xKey]] ?? c.brand} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <details className="mt-3 text-xs text-gray-500">
            <summary className="cursor-pointer select-none">View as table</summary>
            <table className="mt-2 w-full text-left">
              <thead><tr><th className="py-1 pr-4 font-medium">{xLabel ?? xKey}</th><th className="py-1 font-medium">{yLabel}</th></tr></thead>
              <tbody>{data.map((d, i) => <tr key={`${String(d[xKey])}-${i}`}><td className="py-0.5 pr-4">{String((fullKey && d[fullKey]) || d[xKey])}</td><td className="py-0.5">{d[yKey]}</td></tr>)}</tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}
