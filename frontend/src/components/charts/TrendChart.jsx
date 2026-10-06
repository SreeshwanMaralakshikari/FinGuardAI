/**
 * @file src/components/charts/TrendChart.jsx
 * @description Daily high-risk transaction count (solid) + 7-day moving average (dashed).
 *   Both series are in the same unit (transactions per day) on one axis. A legend is always
 *   shown for two series, and the dashed/solid difference means colour is never the only cue.
 */
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CARD } from '../../utils/common.js';

export default function TrendChart({ data, height = 300 }) {
  const empty = !data || data.every((d) => !d.count);
  return (
    <section className={`${CARD.base} p-5`} aria-label="Daily high-risk transactions">
      <h3 className="text-sm font-semibold text-gray-900">High-risk transactions per day</h3>
      <p className="mt-0.5 text-xs text-gray-500">HIGH and CRITICAL per IST day, from midnight 30 days ago until now, with a 7-day moving average.</p>
      {empty ? (
        <p className="py-16 text-center text-sm text-gray-500">No high-risk transactions in this period.</p>
      ) : (
        <>
          <div className="mt-4" style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={{ stroke: '#d1d5db' }} tickFormatter={(d) => d.slice(5)} minTickGap={24} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#6b7280' }} tickLine={false} axisLine={false} />
                <Tooltip />
                <Legend verticalAlign="top" height={28} iconType="plainline" />
                <Line type="monotone" dataKey="count" name="Transactions" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                <Line type="monotone" dataKey="movingAvg" name="7-day average" stroke="#ea580c" strokeWidth={2} strokeDasharray="6 4" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <details className="mt-3 text-xs text-gray-500">
            <summary className="cursor-pointer select-none">View as table</summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="w-full text-left">
                <thead><tr>{['Date', 'Count', 'Amount', 'Avg score', '7-day avg'].map((h) => <th key={h} className="py-1 pr-4 font-medium">{h}</th>)}</tr></thead>
                <tbody>{data.map((d) => (
                  <tr key={d.date}><td className="py-0.5 pr-4">{d.date}</td><td className="pr-4">{d.count}</td><td className="pr-4">{d.totalAmount}</td><td className="pr-4">{d.avgFraudScore}</td><td>{d.movingAvg}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
