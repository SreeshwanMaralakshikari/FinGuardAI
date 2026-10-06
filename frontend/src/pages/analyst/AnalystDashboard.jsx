/**
 * @file src/pages/analyst/AnalystDashboard.jsx
 * @description Open cases (status=OPEN) + the 5 latest flagged transactions (AUD-13).
 *   KPIs: open cases (pagination.total), my active cases (ASSIGNED + UNDER_REVIEW assigned to me),
 *   flagged transactions (HIGH + CRITICAL) total. The analyst API has no "alert count"
 *   endpoint, so the flagged-transaction total is the alert KPI.
 *   N-08: all widgets load into LOCAL state (useFetch). They used to be written into the Redux
 *   keys of the Cases / Flagged pages, which then flashed OPEN-only rows under "All statuses" with
 *   a wrong pager. N-02: every widget shows its error + Retry instead of "No open cases" / 0.
 */
import { Link } from 'react-router-dom';
import { useAppSelector } from '../../store/hooks.js';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { PAGINATION } from '../../utils/constants.js';
import { CARD, TABLE, formatCurrency, formatDate } from '../../utils/common.js';
import { useFetch } from '../../hooks/useFetch.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import StatCard from '../../components/common/StatCard.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import { RiskBadge, CaseStatusBadge, TxStatusBadge } from '../../components/common/Badges.jsx';

const countOf = async (params) =>
  (await api.get(API_PATHS.ANALYST.CASES, { params: { ...params, limit: 1 } })).data.pagination.total;

export default function AnalystDashboard() {
  const user = useAppSelector((s) => s.auth.user);

  const openCases = useFetch(async () => {
    const res = await api.get(API_PATHS.ANALYST.CASES, { params: { status: 'OPEN', limit: PAGINATION.DEFAULT_LIMIT_CASES } });
    return { rows: res.data.data ?? [], total: res.data.pagination?.total ?? 0 };
  }, []);
  const flagged = useFetch(async () => {
    const res = await api.get(API_PATHS.ANALYST.FLAGGED_TRANSACTIONS, { params: { limit: 5 } });
    return { rows: res.data.data ?? [], total: res.data.pagination?.total ?? 0 };
  }, []);

  const mine = useFetch(async () => {
    const [assigned, review] = await Promise.all([
      countOf({ assignedToMe: 'true', status: 'ASSIGNED' }),
      countOf({ assignedToMe: 'true', status: 'UNDER_REVIEW' }),
    ]);
    return assigned + review;
  }, []);

  const cases = openCases.data?.rows ?? [];
  const flaggedRows = flagged.data?.rows ?? [];

  return (
    <div>
      <PageHeader title={`Hello, ${user?.name?.split(' ')[0] ?? ''}`} subtitle="Fraud investigation queue." />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Open cases" value={openCases.data ? openCases.data.total : '—'} hint="Waiting for an analyst" loading={openCases.loading && !openCases.data} />
        <StatCard label="My active cases" value={mine.data ?? '—'} hint="Assigned or under review" loading={mine.loading && mine.data == null} />
        <StatCard label="Flagged transactions" value={flagged.data ? flagged.data.total : '—'} hint="HIGH and CRITICAL risk" loading={flagged.loading && !flagged.data} />
      </div>
      <div className="mt-4 space-y-2">
        <LoadError message={mine.error && `My active cases: ${mine.error}`} onRetry={mine.reload} />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section aria-labelledby="open-cases">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="open-cases" className="text-base font-semibold text-gray-900">Open cases</h2>
            <Link to="/analyst/cases" className="text-sm font-medium text-primary-600 hover:underline">All cases</Link>
          </div>
          {openCases.error ? (
            <LoadError message={openCases.error} onRetry={openCases.reload} />
          ) : cases.length === 0 ? (
            <EmptyState title={openCases.loading ? 'Loading…' : 'No open cases'} message={openCases.loading ? undefined : 'Open one from the flagged transactions.'} />
          ) : (
            <ul className={`${CARD.base} divide-y divide-gray-100`}>
              {cases.slice(0, 6).map((c) => (
                <li key={c._id}>
                  <Link to={`/analyst/cases/${c._id}`} className="flex items-center justify-between gap-3 p-4 hover:bg-gray-50">
                    <span>
                      <span className="block text-sm font-medium text-gray-900">{c.publicId}</span>
                      <span className="block text-xs text-gray-500">{c.transactionId?.merchantName} · {formatCurrency(c.transactionId?.amount)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <RiskBadge level={c.transactionId?.riskLevel} />
                      <CaseStatusBadge status={c.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="latest-flagged">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="latest-flagged" className="text-base font-semibold text-gray-900">Latest flagged transactions</h2>
            <Link to="/analyst/flagged-transactions" className="text-sm font-medium text-primary-600 hover:underline">View all</Link>
          </div>
          {flagged.error ? (
            <LoadError message={flagged.error} onRetry={flagged.reload} />
          ) : flaggedRows.length === 0 ? (
            <EmptyState title={flagged.loading ? 'Loading…' : 'Nothing flagged'} />
          ) : (
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <thead className={TABLE.thead}>
                  <tr><th className={TABLE.th}>Customer</th><th className={TABLE.th}>Amount</th><th className={TABLE.th}>Risk</th><th className={TABLE.th}>Status</th><th className={TABLE.th}>Date</th></tr>
                </thead>
                <tbody className={TABLE.tbody}>
                  {flaggedRows.slice(0, 5).map((t) => (
                    <tr key={t._id} className={TABLE.tr}>
                      <td className={TABLE.td}>{t.userId?.name ?? '—'}</td>
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
      </div>
    </div>
  );
}
