/**
 * @file src/pages/admin/AdminTrends.jsx
 * @description GET /admin-api/analytics/trends via fetchLossStatsThunk. dailyTrend has one entry
 *   per IST day, zero-filled, from IST midnight 30 days ago through today (31 days, AUD-26) —
 *   plotted directly. peakFraudHours (top 5, IST) is computed over the SAME window (N-14).
 *   N-02: a failed load shows the error + Retry instead of an all-zero chart.
 *   The phase-1 "predictions" requirement is met by the 7-day moving average (no forecasting
 *   model exists in the backend).
 */
import { useCallback, useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { fetchLossStatsThunk } from '../../store/slices/analyticsSlice.js';
import { CARD, formatCurrency } from '../../utils/common.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import StatCard from '../../components/common/StatCard.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import TrendChart from '../../components/charts/TrendChart.jsx';

export default function AdminTrends() {
  const dispatch = useAppDispatch();
  const { lossStats, lossLoading, lossError } = useAppSelector((s) => s.analytics);

  const load = useCallback(() => { dispatch(fetchLossStatsThunk()); }, [dispatch]);
  useEffect(() => { load(); }, [load]);

  const days = lossStats.dailyTrend ?? [];
  const peaks = lossStats.peakFraudHours ?? [];
  const total = days.reduce((s, d) => s + d.count, 0);
  const amount = days.reduce((s, d) => s + d.totalAmount, 0);
  const latestAvg = days.at(-1)?.movingAvg ?? 0;

  const subtitle = 'How high-risk activity is moving: IST days from midnight 30 days ago until now.';

  if (lossError) {
    return (
      <div>
        <PageHeader title="Fraud trends" subtitle={subtitle} />
        <LoadError message={lossError} onRetry={load} />
      </div>
    );
  }
  if (lossLoading && days.length === 0) return <Spinner />;

  return (
    <div>
      <PageHeader title="Fraud trends" subtitle={subtitle} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="High-risk transactions" value={total} hint="Last 30 days plus today (IST)" />
        <StatCard label="Amount at risk" value={formatCurrency(amount)} hint="Last 30 days plus today (IST)" />
        <StatCard label="Current 7-day average" value={`${latestAvg}/day`} />
      </div>
      <div className="mt-6"><TrendChart data={days} /></div>
      <section className={`${CARD.base} mt-6 p-5`} aria-labelledby="peak-hours">
        <h2 id="peak-hours" className="text-sm font-semibold text-gray-900">Peak fraud hours (IST)</h2>
        <p className="mt-0.5 text-xs text-gray-500">Top 5 hours of the day, counted over the same period as the chart.</p>
        {peaks.length === 0 ? <p className="mt-2 text-sm text-gray-500">Not enough data yet.</p> : (
          <ol className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {peaks.map((p) => (
              <li key={p.hour} className="rounded-lg bg-gray-50 p-3 text-center">
                <p className="text-lg font-bold text-gray-900">{String(p.hour).padStart(2, '0')}:00</p>
                <p className="text-xs text-gray-500">{p.count} flagged</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
