/**
 * @file src/pages/admin/AdminDashboard.jsx
 * @description Admin KPIs + charts. Everything comes from GET /admin-api/analytics via
 *   fetchAnalyticsThunk (AUD-33 / AUD-38 — never fetchCasesThunk, which is ANALYST-only):
 *   totalTransactions, fraudRate (already a percentage), openCases, openAlerts, lossPrevented.
 *   Live feed: real `fraud_alert` events pushed to the admin socket room (useSocket in AdminLayout);
 *   simulation events appear only while a simulation is running.
 *   A-01: top devices (real deviceId list) and the fraud-score histogram; a From / To filter (IST days)
 *   re-fetches with startDate/endDate. Open cases / open alerts are live counts and ignore the range.
 *   N-02: a failed analytics load shows the error + Retry instead of ₹0.00 / 0 % KPIs and empty charts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { fetchAnalyticsThunk } from '../../store/slices/analyticsSlice.js';
import { BTN, CARD, INPUT, cityLabel, formatCurrency, formatDate } from '../../utils/common.js';
import { dateRangeParams } from '../../utils/dates.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import StatCard from '../../components/common/StatCard.jsx';
import Alert from '../../components/common/Alert.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import BarCard from '../../components/charts/BarCard.jsx';
import { RiskBadge } from '../../components/common/Badges.jsx';

const RISK_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const RISK_HEX = { LOW: '#059669', MEDIUM: '#ca8a04', HIGH: '#ea580c', CRITICAL: '#dc2626' };

/** "dev_4f9a2c81e07b" → "dev_4f…e07b" (the full id stays in the tooltip / table) */
const shortId = (id) => { const t = String(id ?? 'Unknown'); return t.length > 14 ? `${t.slice(0, 6)}…${t.slice(-4)}` : t; };

export default function AdminDashboard() {
  const dispatch = useAppDispatch();
  const a = useAppSelector((s) => s.analytics);
  const sim = useAppSelector((s) => s.simulation);
  const liveAlerts = useAppSelector((s) => s.fraudAlerts.alerts);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState({ from: '', to: '' });
  const [rangeError, setRangeError] = useState('');

  const load = useCallback(() => { dispatch(fetchAnalyticsThunk(dateRangeParams(applied.from, applied.to))); }, [dispatch, applied]);
  useEffect(() => { load(); }, [load]);

  const applyRange = (e) => {
    e.preventDefault();
    if (from && to && from > to) { setRangeError('“From” must be on or before “To”.'); return; } // YYYY-MM-DD compares as text
    setRangeError('');
    setApplied({ from, to });
  };
  const clearRange = () => { setFrom(''); setTo(''); setRangeError(''); setApplied({ from: '', to: '' }); };

  const risk = useMemo(
    () => RISK_ORDER.map((level) => ({ level, count: a.riskDistribution.find((r) => r._id === level)?.count ?? 0 })),
    [a.riskDistribution],
  );
  const byHour = useMemo(
    () => Array.from({ length: 24 }, (_, h) => ({ hour: `${String(h).padStart(2, '0')}h`, count: a.fraudByHour.find((x) => x.hour === h)?.count ?? 0 })),
    [a.fraudByHour],
  );
  const byMethod = useMemo(
    () => a.fraudByPaymentMethod.map((d) => ({ method: String(d.paymentMethod ?? 'Unknown').replace('_', ' '), count: d.count })),
    [a.fraudByPaymentMethod],
  );
  const byDevice = useMemo(
    () => a.fraudByDevice.map((d) => ({
      device: shortId(d.deviceId),
      full: `${d.deviceId ?? 'Unknown'} (${d.userCount} ${d.userCount === 1 ? 'account' : 'accounts'})`,
      count: d.count,
    })),
    [a.fraudByDevice],
  );
  const byCity = useMemo(
    () => a.fraudByLocation.map((d) => ({ city: cityLabel(d.city), count: d.count })),
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

      <form onSubmit={applyRange} noValidate className={`${CARD.base} mb-6 flex flex-wrap items-end gap-3 p-4`} aria-label="Date range">
        <div>
          <label htmlFor="ad-from" className={INPUT.label}>From (IST day)</label>
          <input id="ad-from" type="date" className={INPUT.base} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label htmlFor="ad-to" className={INPUT.label}>To (IST day)</label>
          <input id="ad-to" type="date" className={INPUT.base} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button type="submit" className={`${BTN.base} ${BTN.primary} ${BTN.md}`}>Apply</button>
        <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.md}`} onClick={clearRange}>Clear</button>
        <p className="basis-full text-xs text-gray-500">
          {applied.from || applied.to
            ? `Charts and totals cover ${applied.from || 'the beginning'} to ${applied.to || 'today'} (whole IST days). `
            : 'Charts and totals cover all time. '}
          Open cases and open alerts are live counts and ignore the range.
        </p>
        <div className="basis-full"><Alert tone="error">{rangeError}</Alert></div>
      </form>

      {a.error ? (
        <LoadError message={a.error} onRetry={load} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatCard label="Transactions" value={a.totalTransactions.toLocaleString('en-IN')} loading={first} />
            <StatCard label="Fraud rate" value={`${a.fraudRate}%`} hint="HIGH + CRITICAL share" loading={first} />
            <StatCard label="Open cases" value={a.openCases} loading={first} />
            <StatCard label="Open alerts (not yet closed)" value={a.openAlerts} hint="Includes alerts whose case is still in progress" loading={first} />
            <StatCard label="Loss prevented" value={formatCurrency(a.lossPrevented)} hint="Held + blocked amounts" loading={first} />
          </div>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <BarCard title="Risk distribution" subtitle="All transactions by risk level" data={risk} xKey="level" xLabel="Risk level" colors={RISK_HEX} yLabel="Transactions" />
            <BarCard title="High-risk by hour of day" subtitle="HIGH and CRITICAL, IST" data={byHour} xKey="hour" xLabel="Hour (IST)" yLabel="Transactions" />
            <BarCard title="High-risk by payment method" data={byMethod} xKey="method" xLabel="Payment method" yLabel="Transactions" />
            <BarCard title="Fraud score distribution" subtitle="All transactions in the period, by score (0–100)" data={a.scoreHistogram} xKey="label" xLabel="Score range" yLabel="Transactions" />
            <BarCard title="Top devices by high-risk transactions" subtitle="HIGH and CRITICAL; the tooltip shows the full device id and how many accounts used it" data={byDevice} xKey="device" fullKey="full" xLabel="Device (accounts)" yLabel="High-risk transactions" />
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
