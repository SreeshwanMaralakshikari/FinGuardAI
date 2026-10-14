/**
 * @file src/components/charts/TrendChart.jsx
 * @description Daily high-risk transaction count (solid) + 7-day moving average (dashed).
 *   Both series are in the same unit (transactions per day) on one axis. A legend is always
 *   shown for two series, and the dashed/solid difference means colour is never the only cue.
 *   A-04: optional `forecast` ({ available, days[] } from GET /admin-api/analytics/trends) adds a third,
 *   dashed indigo series "Forecast (next 7 days, linear trend)". It lives under its own key (`forecast`),
 *   starts at the last real day so the line continues, and never touches the existing series.
 */
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CARD } from '../../utils/common.js';
import { useChartColors, tooltipStyles } from '../../hooks/useChartColors.js';

export const FORECAST_NAME = 'Forecast (next 7 days, linear trend)';
const FORECAST_NOTE = 'No forecast yet: it needs at least 7 days with high-risk transactions in the last 14 days.';

export default function TrendChart({ data, forecast = null, height = 300 }) {
  const empty = !data || data.every((d) => !d.count);
  const c = useChartColors(); // R4-01: theme-aware colours
  const forecastDays = forecast?.available ? (forecast.days ?? []) : [];
  const hasForecast = forecastDays.length > 0 && !empty;
  const chartData = hasForecast
    ? [
      // the last real day carries the forecast value too, so the dashed line connects to the solid one
      ...data.map((d, i) => (i === data.length - 1 ? { ...d, forecast: d.count } : d)),
      ...forecastDays.map((d) => ({ date: d.date, forecast: d.count })),
    ]
    : data;
  return (
    <section className={`${CARD.base} p-5`} aria-label="Daily high-risk transactions">
      <h2 className="text-sm font-semibold text-gray-900">High-risk transactions per day</h2>
      <p className="mt-0.5 text-xs text-gray-500">HIGH and CRITICAL per IST day, from midnight 30 days ago until now, with a 7-day moving average.</p>
      {empty ? (
        <p className="py-16 text-center text-sm text-gray-500">No high-risk transactions in this period.</p>
      ) : (
        <>
          <div className="mt-4" style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 0, left: -12 }}>
                <CartesianGrid stroke={c.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: c.tick }} tickLine={false} axisLine={{ stroke: c.axis }} tickFormatter={(d) => d.slice(5)} minTickGap={24} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: c.tick }} tickLine={false} axisLine={false} />
                <Tooltip {...tooltipStyles(c)} />
                <Legend verticalAlign="top" height={28} iconType="plainline" />
                <Line type="monotone" dataKey="count" name="Transactions" stroke={c.brand} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                <Line type="monotone" dataKey="movingAvg" name="7-day average" stroke={c.average} strokeWidth={2} strokeDasharray="6 4" dot={false} />
                {hasForecast && (
                  <Line type="monotone" dataKey="forecast" name={FORECAST_NAME} stroke={c.forecast} strokeWidth={2} strokeDasharray="2 4" dot={{ r: 2 }} connectNulls />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {forecast && !forecast.available && <p className="mt-3 text-xs text-gray-500" role="note">{FORECAST_NOTE}</p>}
          {hasForecast && (
            <p className="mt-3 text-xs text-gray-500" role="note">
              Dashed purple line: {FORECAST_NAME}, fitted on the last 14 days. It is an estimate, not a promise.
            </p>
          )}
          <details className="mt-3 text-xs text-gray-500">
            <summary className="cursor-pointer select-none">View as table</summary>
            <div className="mt-2 max-h-64 overflow-auto">
              <table className="w-full text-left">
                <thead><tr>{['Date', 'Count', 'Amount', 'Avg score', '7-day avg'].map((h) => <th key={h} className="py-1 pr-4 font-medium">{h}</th>)}</tr></thead>
                <tbody>{data.map((d) => (
                  <tr key={d.date}><td className="py-0.5 pr-4">{d.date}</td><td className="pr-4">{d.count}</td><td className="pr-4">{d.totalAmount}</td><td className="pr-4">{d.avgFraudScore}</td><td>{d.movingAvg}</td></tr>
                ))}</tbody>
                {hasForecast && (
                  <tbody>
                    <tr><th colSpan={5} scope="rowgroup" className="pt-3 pb-1 text-left font-medium">{FORECAST_NAME}</th></tr>
                    {forecastDays.map((d) => (
                      <tr key={`f-${d.date}`}><td className="py-0.5 pr-4">{d.date}</td><td className="pr-4">{d.count}</td><td className="pr-4">{d.totalAmount}</td><td className="pr-4">{d.avgFraudScore}</td><td>{d.movingAvg}</td></tr>
                    ))}
                  </tbody>
                )}
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
