/**
 * @file src/pages/admin/AdminDashboard.jsx
 * @description Admin KPIs + charts. Everything comes from GET /admin-api/analytics via
 *   fetchAnalyticsThunk (AUD-33 / AUD-38 — never fetchCasesThunk, which is ANALYST-only):
 *   totalTransactions, fraudRate (already a percentage), openCases, openAlerts, lossPrevented.
 *   Live feed: real `fraud_alert` events pushed to the admin socket room (useSocket in AdminLayout);
 *   simulation events appear only while a simulation is running.
 *   N-02: a failed analytics load shows the error + Retry instead of ₹0.00 / 0 % KPIs and empty charts.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { fetchAnalyticsThunk } from '../../store/slices/analyticsSlice.js';
import { BTN, CARD, formatCurrency, formatDate } from '../../utils/common.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import StatCard from '../../components/common/StatCard.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import BarCard from '../../components/charts/BarCard.jsx';
import { RiskBadge } from '../../components/common/Badges.jsx';

const RISK_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const RISK_HEX = { LOW: '#059669', MEDIUM: '#ca8a04', HIGH: '#ea580c', CRITICAL: '#dc2626' };

export default function AdminDashboard() {
  const dispatch = useAppDispatch();
  const a = useAppSelector((s) => s.analytics);
  const sim = useAppSelector((s) => s.simulation);
  const liveAlerts = useAppSelector((s) => s.fraudAlerts.alerts);

  const load = useCallback(() => { dispatch(fetchAnalyticsThunk()); }, [dispatch]);
  useEffect(() => { load(); }, [load]);

  const risk = useMemo(
    () => RISK_ORDER.map((level) => ({ level, count: a.riskDistribution.find((r) => r._id === level)?.count ?? 0 })),
    [a.riskDistribution],
  );
  const byHour = useMemo(
    () => Array.from({ length: 24 }, (_, h) => ({ hour: `${String(h).padStart(2, '0')}h`, count: a.fraudByHour.find((x) => x.hour === h)?.count ?? 0 })),
    [a.fraudByHour],
  );
  const byMethod = useMemo(
    () => a.fraudByDevice.map((d) => ({ method: String(d.paymentMethod ?? 'Unknown').replace('_', ' '), count: d.count })),
    [a.fraudByDevice],
  );
  const byCity = useMemo(
    () => a.fraudByLocation.map((d) => ({ city: String(d.city ?? 'Unknown'), count: d.count })),
    [a.fraudByLocation],
  );

  const first = a.loading && a.totalTransactions === 0;

  return (
    <div>
      <PageHeader
        title="Admin dashboard"
        subtitle="System-wide fraud monitoring."
        actions={<>
          <Link to="/admin/trends" className={`${BTN.base} ${BTN.secondary} ${BTN.sm}`}>Trends</Link>
          <Link to="/admin/simulation" className={`${BTN.base} ${BTN.primary} ${BTN.sm}`}>Simulation</Link>
        </>}
      />

      {a.error ? (
        <LoadError message={a.error} onRetry={load} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatCard label="Transactions" value={a.totalTransactions.toLocaleString('en-IN')} loading={first} />
            <StatCard label="Fraud rate" value={`${a.fraudRate}%`} hint="HIGH + CRITICAL share" loading={first} />
            <StatCard label="Open cases" value={a.openCases} loading={first} />
            <StatCard label="Open alerts" value={a.openAlerts} hint="HIGH / CRITICAL awaiting an analyst" loading={first} />
            <StatCard label="Loss prevented" value={formatCurrency(a.lossPrevented)} hint="Held + blocked amounts" loading={first} />
          </div>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <BarCard title="Risk distribution" subtitle="All transactions by risk level" data={risk} xKey="level" xLabel="Risk level" colors={RISK_HEX} yLabel="Transactions" />
            <BarCard title="High-risk by hour of day" subtitle="HIGH and CRITICAL, IST" data={byHour} xKey="hour" xLabel="Hour (IST)" yLabel="Transactions" />
            <BarCard title="High-risk by payment method" data={byMethod} xKey="method" xLabel="Payment method" yLabel="Transactions" />
            <BarCard title="High-risk by city" subtitle="Top 10" data={byCity} xKey="city" xLabel="City" yLabel="Transactions" />
          </div>
        </>
      )}

      <section className={`${CARD.base} mt-6`} aria-labelledby="live-feed">
        <div className={`${CARD.header} flex items-center justify-between`}>
          <h2 id="live-feed" className="text-base font-semibold text-gray-900">Live fraud alerts</h2>
          <span className="text-xs text-gray-500">
            Simulation: <span className="font-semibold">{sim.isRunning ? 'running' : 'idle'}</span>
          </span>
        </div>
        {liveAlerts.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-gray-500">Waiting for new alerts… they appear here the moment a customer’s payment is flagged.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {liveAlerts.slice(0, 10).map((e) => (
              <li key={e._id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm">
                <span className="font-medium text-gray-900">{e.merchantName ?? 'Transaction'} <span className="font-normal text-gray-500">· {e.publicId}</span></span>
                <span className="text-gray-700">{formatCurrency(e.amount)}</span>
                <span className="text-gray-600">score {e.fraudScore}</span>
                <RiskBadge level={e.riskLevel} />
                <span className="text-xs text-gray-500">{formatDate(e.timestamp)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
