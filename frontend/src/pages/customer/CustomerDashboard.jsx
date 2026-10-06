/**
 * @file src/pages/customer/CustomerDashboard.jsx
 * @description Customer home: KPIs + 5 latest transactions + 5 latest alerts (limit 5).
 *   Trust score comes from GET /customer-api/trust-score (AUD-09 — it changes after every
 *   transaction, auth.user.trustScore is only as fresh as the last login).
 *   "Open alerts" is a separate count query (status=OPEN, limit 1 → pagination.total).
 *   N-08: every widget loads into LOCAL state (useFetch). The 5-row previews used to be written
 *   into the same Redux keys as the Transactions / Alerts pages, so those pages first showed
 *   these rows under "All" with a wrong pager. N-02: each widget shows its own error + Retry;
 *   a failed load is never rendered as 0 / "No transactions yet" / "Nothing suspicious".
 */
import { Link } from 'react-router-dom';
import { useAppSelector } from '../../store/hooks.js';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { BTN, CARD, TABLE, formatCurrency, formatDate } from '../../utils/common.js';
import { useFetch } from '../../hooks/useFetch.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import StatCard from '../../components/common/StatCard.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import { RiskBadge, TxStatusBadge } from '../../components/common/Badges.jsx';

const fetchPreview = async (path) => {
  const res = await api.get(path, { params: { limit: 5 } });
  return { rows: res.data.data ?? [], total: res.data.pagination?.total ?? 0 };
};

export default function CustomerDashboard() {
  const user = useAppSelector((s) => s.auth.user);

  const recentTx = useFetch(() => fetchPreview(API_PATHS.CUSTOMER.TRANSACTIONS), []);
  const recentAlerts = useFetch(() => fetchPreview(API_PATHS.CUSTOMER.FRAUD_ALERTS), []);
  const trust = useFetch(
    async () => (await api.get(API_PATHS.CUSTOMER.TRUST_SCORE)).data.data,
    [],
  );
  const openAlerts = useFetch(
    async () => (await api.get(API_PATHS.CUSTOMER.FRAUD_ALERTS, { params: { status: 'OPEN', limit: 1 } })).data.pagination.total,
    [],
  );

  const transactions = recentTx.data?.rows ?? [];
  const alerts = recentAlerts.data?.rows ?? [];

  return (
    <div>
      <PageHeader
        title={`Welcome back, ${user?.name?.split(' ')[0] ?? ''}`}
        subtitle="Your account security at a glance."
        actions={<Link to="/customer/submit-transaction" className={`${BTN.base} ${BTN.primary} ${BTN.md}`}>New transaction</Link>}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Trust score" value={trust.data ? `${trust.data.trustScore}/100` : '—'} hint="Drops after risky activity, recovers with safe payments" loading={trust.loading && !trust.data} />
        <StatCard label="Open fraud alerts" value={openAlerts.data ?? '—'} hint="Alerts that have not been closed yet (medium-risk alerts are not sent to an analyst)" loading={openAlerts.loading && openAlerts.data == null} />
        <StatCard label="Total transactions" value={recentTx.data ? recentTx.data.total : '—'} loading={recentTx.loading && !recentTx.data} />
      </div>
      <div className="mt-4 space-y-2">
        <LoadError message={trust.error && `Trust score: ${trust.error}`} onRetry={trust.reload} />
        <LoadError message={openAlerts.error && `Open alerts: ${openAlerts.error}`} onRetry={openAlerts.reload} />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <section className="xl:col-span-2" aria-labelledby="recent-tx">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="recent-tx" className="text-base font-semibold text-gray-900">Recent transactions</h2>
            <Link to="/customer/transactions" className="text-sm font-medium text-primary-600 hover:underline">View all</Link>
          </div>
          {recentTx.error ? (
            <LoadError message={recentTx.error} onRetry={recentTx.reload} />
          ) : transactions.length === 0 ? (
            <EmptyState
              title={recentTx.loading ? 'Loading…' : 'No transactions yet'}
              message={recentTx.loading ? undefined : 'Submit your first payment to see how FinGuardAI scores it.'}
            />
          ) : (
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <thead className={TABLE.thead}>
                  <tr>
                    <th className={TABLE.th}>Merchant</th><th className={TABLE.th}>Amount</th>
                    <th className={TABLE.th}>Risk</th><th className={TABLE.th}>Status</th><th className={TABLE.th}>Date</th>
                  </tr>
                </thead>
                <tbody className={TABLE.tbody}>
                  {transactions.slice(0, 5).map((t) => (
                    <tr key={t._id} className={TABLE.tr}>
                      <td className={TABLE.td}>{t.merchantName}</td>
                      <td className={TABLE.td}>{formatCurrency(t.amount)}</td>
                      <td className={TABLE.td}><RiskBadge level={t.riskLevel} /></td>
                      <td className={TABLE.td}><TxStatusBadge status={t.status} /></td>
                      <td className={TABLE.td}>{formatDate(t.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-labelledby="recent-alerts">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="recent-alerts" className="text-base font-semibold text-gray-900">Recent alerts</h2>
            <Link to="/customer/fraud-alerts" className="text-sm font-medium text-primary-600 hover:underline">View all</Link>
          </div>
          {recentAlerts.error ? (
            <LoadError message={recentAlerts.error} onRetry={recentAlerts.reload} />
          ) : alerts.length === 0 ? (
            <EmptyState title={recentAlerts.loading ? 'Loading…' : 'No alerts'} message={recentAlerts.loading ? undefined : 'Nothing suspicious so far.'} />
          ) : (
            <ul className={`${CARD.base} divide-y divide-gray-100`}>
              {alerts.slice(0, 5).map((a) => (
                <li key={a._id} className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-gray-900">{a.transactionId?.merchantName ?? 'Transaction'}</span>
                    <RiskBadge level={a.riskLevel} />
                  </div>
                  <p className="mt-1 text-xs text-gray-600">{a.reasons?.[0] ?? 'Flagged by the fraud engine'}</p>
                  <p className="mt-1 text-[11px] text-gray-500">{formatDate(a.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
