/**
 * @file src/pages/customer/TransactionHistory.jsx
 * @description Paginated, filterable transaction table with a detail modal.
 *   Detail = composite { transaction, deviceReputation } (D-P7-05 / C-P6-32); the selection is
 *   cleared on close. Date filters are sent as explicit IST bounds (utils/dates.js).
 *   N-02 / N-03: a failed load shows the error with a Retry button (never "No transactions found");
 *   while a refetch runs over existing rows they are dimmed with an "Updating…" pill; the detail
 *   modal reads its loading / error state from the slice, which ignores superseded requests.
 */
import { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import {
  fetchTransactionsThunk, fetchTransactionByIdThunk, clearSelectedTransaction,
} from '../../store/slices/transactionSlice.js';
import { BTN, INPUT, TABLE, formatCurrency, formatDate } from '../../utils/common.js';
import { PAGINATION, RISK_LEVELS, PAYMENT_METHODS } from '../../utils/constants.js';
import { dateRangeParams } from '../../utils/dates.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Pagination from '../../components/common/Pagination.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import BusyRegion from '../../components/common/BusyRegion.jsx';
import Modal from '../../components/common/Modal.jsx';
import Alert from '../../components/common/Alert.jsx';
import DetailRow from '../../components/common/DetailRow.jsx';
import ScoreBar from '../../components/common/ScoreBar.jsx';
import { RiskBadge, TxStatusBadge } from '../../components/common/Badges.jsx';

const EMPTY_FILTERS = { riskLevel: '', paymentMethod: '', startDate: '', endDate: '' };

export default function TransactionHistory() {
  const dispatch = useAppDispatch();
  const { transactions, pagination, selectedTransaction, loading, error, detailError } = useAppSelector((s) => s.transactions);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState(false);
  const [attempt, setAttempt] = useState(0); // Retry re-runs the load effect

  useEffect(() => {
    const params = { page, limit: PAGINATION.DEFAULT_LIMIT_STANDARD, ...dateRangeParams(filters.startDate, filters.endDate) };
    if (filters.riskLevel) params.riskLevel = filters.riskLevel;
    if (filters.paymentMethod) params.paymentMethod = filters.paymentMethod;
    dispatch(fetchTransactionsThunk(params));
  }, [dispatch, page, filters, attempt]);

  const setFilter = (key) => (e) => { setPage(1); setFilters((f) => ({ ...f, [key]: e.target.value })); };

  const openDetail = (id) => {
    setViewing(true);
    dispatch(fetchTransactionByIdThunk(id));
  };

  const closeDetail = () => {
    setViewing(false);
    dispatch(clearSelectedTransaction());
  };

  const t = selectedTransaction?.transaction;
  const dev = selectedTransaction?.deviceReputation;

  return (
    <div>
      <PageHeader title="Transaction history" subtitle="Every payment you submitted, with its fraud score." />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label htmlFor="f-risk" className={INPUT.label}>Risk level</label>
          <select id="f-risk" className={INPUT.select} value={filters.riskLevel} onChange={setFilter('riskLevel')}>
            <option value="">All</option>
            {Object.values(RISK_LEVELS).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f-method" className={INPUT.label}>Payment method</label>
          <select id="f-method" className={INPUT.select} value={filters.paymentMethod} onChange={setFilter('paymentMethod')}>
            <option value="">All</option>
            {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="f-from" className={INPUT.label}>From</label>
          <input id="f-from" type="date" className={INPUT.base} value={filters.startDate} max={filters.endDate || undefined} onChange={setFilter('startDate')} />
        </div>
        <div>
          <label htmlFor="f-to" className={INPUT.label}>To</label>
          <input id="f-to" type="date" className={INPUT.base} value={filters.endDate} min={filters.startDate || undefined} onChange={setFilter('endDate')} />
        </div>
        <div className="flex items-end">
          <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.md} w-full`} onClick={() => { setPage(1); setFilters(EMPTY_FILTERS); }}>
            Clear filters
          </button>
        </div>
      </div>

      {error ? (
        <LoadError message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : loading && transactions.length === 0 ? (
        <Spinner />
      ) : transactions.length === 0 ? (
        <EmptyState title="No transactions found" message="Try clearing the filters, or submit a new transaction." />
      ) : (
        <BusyRegion busy={loading}>
          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <thead className={TABLE.thead}>
                <tr>
                  {['ID', 'Merchant', 'Amount', 'Method', 'Score', 'Risk', 'Status', 'Date', ''].map((h) => (
                    <th key={h || 'actions'} className={TABLE.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className={TABLE.tbody}>
                {transactions.map((tx) => (
                  <tr key={tx._id} className={TABLE.tr}>
                    <td className={TABLE.td}>{tx.publicId}</td>
                    <td className={TABLE.td}>{tx.merchantName}</td>
                    <td className={TABLE.td}>{formatCurrency(tx.amount)}</td>
                    <td className={TABLE.td}>{tx.paymentMethod?.replace('_', ' ')}</td>
                    <td className={TABLE.td}>{tx.fraudScore}</td>
                    <td className={TABLE.td}><RiskBadge level={tx.riskLevel} /></td>
                    <td className={TABLE.td}><TxStatusBadge status={tx.status} /></td>
                    <td className={TABLE.td}>{formatDate(tx.timestamp)}</td>
                    <td className={TABLE.td}>
                      <button type="button" className={`${BTN.base} ${BTN.ghost} ${BTN.sm}`} onClick={() => openDetail(tx._id)} aria-label={`Details for ${tx.publicId}`}>Details</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </BusyRegion>
      )}

      {!error && <Pagination page={page} limit={pagination.limit} total={pagination.total} onChange={setPage} />}

      <Modal open={viewing} title="Transaction details" onClose={closeDetail} wide>
        {detailError ? <Alert tone="error">{detailError}</Alert> : !t ? <Spinner className="py-10" /> : (
          <div className="space-y-6">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <DetailRow label="Transaction ID">{t.publicId}</DetailRow>
              <DetailRow label="Amount">{formatCurrency(t.amount)}</DetailRow>
              <DetailRow label="Date">{formatDate(t.timestamp)}</DetailRow>
              <DetailRow label="Merchant">{t.merchantName}</DetailRow>
              <DetailRow label="Category">{t.merchantCategory}</DetailRow>
              <DetailRow label="Payment method">{t.paymentMethod?.replace('_', ' ')}</DetailRow>
              <DetailRow label="Location">{[t.location?.city, t.location?.country].filter(Boolean).join(', ') || '—'}</DetailRow>
              <DetailRow label="Device">{t.deviceId}</DetailRow>
              <DetailRow label="Status"><TxStatusBadge status={t.status} /></DetailRow>
              <DetailRow label="Risk"><RiskBadge level={t.riskLevel} /></DetailRow>
              <DetailRow label="Recommended action">{t.recommendedAction}</DetailRow>
              <DetailRow label="Estimated loss at risk">{formatCurrency(t.estimatedLoss)}</DetailRow>
            </dl>

            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Fraud score</p>
              <ScoreBar value={t.fraudScore} label="Fraud score" />
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Why this score</p>
              {t.reasons?.length ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">{t.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              ) : <p className="text-sm text-gray-500">No risk signals were triggered.</p>}
            </div>

            {dev && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Device reputation</p>
                <ScoreBar value={dev.reputationScore} invert label="Device reputation" />
                <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <DetailRow label="Flags">{dev.flagCount}</DetailRow>
                  <DetailRow label="Fraud transactions">{dev.fraudTransactionCount}</DetailRow>
                  <DetailRow label="Blacklisted">{dev.isBlacklisted ? 'Yes' : 'No'}</DetailRow>
                  <DetailRow label="First seen">{formatDate(dev.firstSeenAt)}</DetailRow>
                </dl>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
