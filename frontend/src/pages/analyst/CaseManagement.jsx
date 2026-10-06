/**
 * @file src/pages/analyst/CaseManagement.jsx
 * @description Paginated investigation cases. Filters: status + "My cases only" (assignedToMe).
 *   List items: { _id, publicId, status, assignedAnalystId: {name,email}|null,
 *   transactionId: { publicId, amount, merchantName, fraudScore, riskLevel }, openedAt, resolvedAt }.
 *   N-02 / N-03 / N-08: a failed load shows the error + Retry (never "No cases found"); refetching
 *   over existing rows dims them with an "Updating…" pill; the pager follows the page state.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { fetchCasesThunk } from '../../store/slices/fraudCaseSlice.js';
import { BTN, INPUT, TABLE, formatCurrency, formatDate } from '../../utils/common.js';
import { CASE_STATUSES, PAGINATION } from '../../utils/constants.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Pagination from '../../components/common/Pagination.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import BusyRegion from '../../components/common/BusyRegion.jsx';
import { RiskBadge, CaseStatusBadge } from '../../components/common/Badges.jsx';

export default function CaseManagement() {
  const dispatch = useAppDispatch();
  const { cases, pagination, loading, error } = useAppSelector((s) => s.fraudCases);
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0); // Retry re-runs the load effect

  useEffect(() => {
    const params = { page, limit: PAGINATION.DEFAULT_LIMIT_CASES };
    if (status) params.status = status;
    if (mine) params.assignedToMe = true;
    dispatch(fetchCasesThunk(params));
  }, [dispatch, page, status, mine, attempt]);

  return (
    <div>
      <PageHeader title="Fraud cases" subtitle="Investigations opened from flagged transactions." />

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="w-full sm:w-56">
          <label htmlFor="cs-status" className={INPUT.label}>Status</label>
          <select id="cs-status" className={INPUT.select} value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">All statuses</option>
            {Object.values(CASE_STATUSES).map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm text-gray-700">
          <input type="checkbox" className="h-4 w-4 rounded border-gray-300" checked={mine} onChange={(e) => { setPage(1); setMine(e.target.checked); }} />
          My cases only
        </label>
        <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.md}`} onClick={() => { setPage(1); setStatus(''); setMine(false); }}>Clear</button>
      </div>

      {error ? (
        <LoadError message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : loading && cases.length === 0 ? <Spinner /> : cases.length === 0 ? (
        <EmptyState title="No cases found" message="Open a case from the flagged transactions page." action={<Link to="/analyst/flagged-transactions" className={`${BTN.base} ${BTN.primary} ${BTN.md}`}>Go to flagged transactions</Link>} />
      ) : (
        <BusyRegion busy={loading}>
          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <thead className={TABLE.thead}>
                <tr>{['Case', 'Transaction', 'Merchant', 'Amount', 'Risk', 'Status', 'Assigned to', 'Opened'].map((h) => <th key={h} className={TABLE.th}>{h}</th>)}</tr>
              </thead>
              <tbody className={TABLE.tbody}>
                {cases.map((c) => (
                  <tr key={c._id} className={TABLE.tr}>
                    <td className={TABLE.td}><Link to={`/analyst/cases/${c._id}`} className="font-medium text-primary-600 hover:underline">{c.publicId}</Link></td>
                    <td className={TABLE.td}>{c.transactionId?.publicId}</td>
                    <td className={TABLE.td}>{c.transactionId?.merchantName}</td>
                    <td className={TABLE.td}>{formatCurrency(c.transactionId?.amount)}</td>
                    <td className={TABLE.td}><RiskBadge level={c.transactionId?.riskLevel} /></td>
                    <td className={TABLE.td}><CaseStatusBadge status={c.status} /></td>
                    <td className={TABLE.td}>{c.assignedAnalystId?.name ?? <span className="text-gray-500">Unassigned</span>}</td>
                    <td className={TABLE.td}>{formatDate(c.openedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </BusyRegion>
      )}

      {!error && <Pagination page={page} limit={pagination.limit} total={pagination.total} onChange={setPage} />}
    </div>
  );
}
