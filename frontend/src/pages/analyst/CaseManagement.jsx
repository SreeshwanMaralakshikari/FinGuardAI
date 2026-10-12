/**
 * @file src/pages/analyst/CaseManagement.jsx
 * @description Paginated investigation cases. Filters: status + "My cases only" (assignedToMe).
 *   List items: { _id, publicId, status, assignedAnalystId: {name,email}|null,
 *   transactionId: { publicId, amount, merchantName, fraudScore, riskLevel }, openedAt, resolvedAt }.
 *   N-02 / N-03 / N-08: a failed load shows the error + Retry (never "No cases found"); refetching
 *   over existing rows dims them with an "Updating…" pill; the pager follows the page state.
 *   F-11: "My queue" quick filter (assignedToMe), an "Age" column with an SLA cue (text + icon, not colour
 *   alone: warn after 24 h, critical after 72 h), a sort control and "Export CSV" of the loaded rows.
 *   B-02: RESOLVED / DISMISSED are described by what they do to the payment.
 *   The sort is CLIENT-SIDE over the loaded page — GET /analyst-api/cases has no sort parameter (it
 *   always answers newest first), so it orders only the rows of the current page.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { fetchCasesThunk } from '../../store/slices/fraudCaseSlice.js';
import { BTN, INPUT, TABLE, formatCurrency, formatDate } from '../../utils/common.js';
import { CASE_STATUSES, CASE_OUTCOME, PAGINATION } from '../../utils/constants.js';
import { caseAge } from '../../utils/caseAge.js';
import { exportRowsToCsv } from '../../utils/csv.js';
import Icon from '../../components/common/Icon.jsx';
import PageHeader from '../../components/common/PageHeader.jsx';
import Pagination from '../../components/common/Pagination.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import TableSkeleton from '../../components/common/TableSkeleton.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import BusyRegion from '../../components/common/BusyRegion.jsx';
import { RiskBadge, CaseStatusBadge } from '../../components/common/Badges.jsx';

const STATUS_OPTION_TEXT = (s) => (CASE_OUTCOME[s] ? `${s} - ${CASE_OUTCOME[s].split(' - ')[0].toLowerCase()}` : s.replace('_', ' '));

const SLA_STYLE = {
  ok:       'text-gray-700',
  warn:     'font-semibold text-amber-700',
  critical: 'font-semibold text-red-700',
  closed:   'text-gray-500',
  unknown:  'text-gray-500',
};
const SLA_FLAG = { warn: 'Over 24 h', critical: 'Over 72 h - critical' };

function AgeCell({ age }) {
  return (
    <span className={`inline-flex items-center gap-1 ${SLA_STYLE[age.level]}`}>
      {SLA_FLAG[age.level] && <Icon name="alert" className="h-4 w-4" />}
      {age.text}
      {SLA_FLAG[age.level] && <span className="text-xs">({SLA_FLAG[age.level]})</span>}
    </span>
  );
}

const CSV_COLUMNS = (nowMs) => [
  { header: 'Case', value: (c) => c.publicId },
  { header: 'Transaction', value: (c) => c.transactionId?.publicId },
  { header: 'Merchant', value: (c) => c.transactionId?.merchantName },
  { header: 'Amount (INR)', value: (c) => c.transactionId?.amount },
  { header: 'Risk', value: (c) => c.transactionId?.riskLevel },
  { header: 'Status', value: (c) => c.status },
  { header: 'Assigned to', value: (c) => c.assignedAnalystId?.name ?? 'Unassigned' },
  { header: 'Opened (IST)', value: (c) => formatDate(c.openedAt) },
  { header: 'Age', value: (c) => caseAge(c, nowMs).text },
];

export default function CaseManagement() {
  const dispatch = useAppDispatch();
  const { cases, pagination, loading, error } = useAppSelector((s) => s.fraudCases);
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [newestFirst, setNewestFirst] = useState(true);
  const [now, setNow] = useState(() => Date.now()); // ticks each minute so ages stay current
  const [attempt, setAttempt] = useState(0); // Retry re-runs the load effect

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  // F-11: client-side sort of the LOADED page (the API has no sort parameter)
  const rows = useMemo(() => {
    const t = (c) => new Date(c.openedAt).getTime() || 0;
    return [...cases].sort((a, b) => (newestFirst ? t(b) - t(a) : t(a) - t(b)));
  }, [cases, newestFirst]);

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
            {Object.values(CASE_STATUSES).map((s) => <option key={s} value={s}>{STATUS_OPTION_TEXT(s)}</option>)}
          </select>
        </div>
        <div className="w-full sm:w-48">
          <label htmlFor="cs-sort" className={INPUT.label}>Sort this page</label>
          <select id="cs-sort" className={INPUT.select} value={newestFirst ? 'new' : 'old'} onChange={(e) => setNewestFirst(e.target.value === 'new')}>
            <option value="new">Newest first</option>
            <option value="old">Oldest first</option>
          </select>
        </div>
        <button
          type="button"
          aria-pressed={mine}
          className={`${BTN.base} ${mine ? BTN.primary : BTN.secondary} ${BTN.md}`}
          onClick={() => { setPage(1); setMine((m) => !m); }}
        >
          {mine ? 'My queue (on)' : 'My queue'}
        </button>
        <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.md}`} onClick={() => { setPage(1); setStatus(''); setMine(false); setNewestFirst(true); }}>Clear</button>
        <button
          type="button"
          disabled={rows.length === 0}
          className={`${BTN.base} ${BTN.secondary} ${BTN.md}`}
          onClick={() => exportRowsToCsv('fraud-cases', CSV_COLUMNS(now), rows)}
        >
          Export CSV
        </button>
      </div>

      {error ? (
        <LoadError message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : loading && cases.length === 0 ? <TableSkeleton cols={9} /> : cases.length === 0 ? (
        <EmptyState title="No cases found" message="Open a case from the flagged transactions page." action={<Link to="/analyst/flagged-transactions" className={`${BTN.base} ${BTN.primary} ${BTN.md}`}>Go to flagged transactions</Link>} />
      ) : (
        <BusyRegion busy={loading}>
          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <thead className={TABLE.thead}>
                <tr>{['Case', 'Transaction', 'Merchant', 'Amount', 'Risk', 'Status', 'Assigned to', 'Opened', 'Age'].map((h) => <th key={h} className={TABLE.th}>{h}</th>)}</tr>
              </thead>
              <tbody className={TABLE.tbody}>
                {rows.map((c) => (
                  <tr key={c._id} className={TABLE.tr}>
                    <td className={TABLE.td}><Link to={`/analyst/cases/${c._id}`} className="font-medium text-primary-600 hover:underline">{c.publicId}</Link></td>
                    <td className={TABLE.td}>{c.transactionId?.publicId}</td>
                    <td className={TABLE.td}>{c.transactionId?.merchantName}</td>
                    <td className={TABLE.td}>{formatCurrency(c.transactionId?.amount)}</td>
                    <td className={TABLE.td}><RiskBadge level={c.transactionId?.riskLevel} /></td>
                    <td className={TABLE.td}><CaseStatusBadge status={c.status} /></td>
                    <td className={TABLE.td}>{c.assignedAnalystId?.name ?? <span className="text-gray-500">Unassigned</span>}</td>
                    <td className={TABLE.td}>{formatDate(c.openedAt)}</td>
                    <td className={TABLE.td}><AgeCell age={caseAge(c, now)} /></td>
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
