/**
 * @file src/pages/analyst/FlaggedTransactions.jsx
 * @description System-wide HIGH/CRITICAL transactions (AUD-13). The risk filter defaults to ALL
 *   (param omitted → HIGH + CRITICAL): defaulting to HIGH would hide every CRITICAL, i.e.
 *   BLOCKED, transaction. "Investigate" loads the investigation context; "Open case" posts
 *   createCaseThunk({ fraudAlertId: selectedFlagged.fraudAlert._id }) — only when that context
 *   belongs to the transaction on screen. If a case exists it links to it instead.
 *   Never calls the /customer-api alert thunks (403 for analysts).
 *   N-02 / N-03 / N-08: list + detail read their own loading / error flags from the slice (a
 *   failed list shows error + Retry, refetching dims the old rows); the dialog cannot be dismissed
 *   while the case is being created (N-01/N-07). N-22: the Investigate button is the FIRST column,
 *   so it stays on screen at 1280 px without horizontal scrolling.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import {
  fetchFlaggedTransactionsThunk, fetchFlaggedTransactionByIdThunk, clearSelectedFlagged,
} from '../../store/slices/fraudAlertSlice.js';
import { createCaseThunk } from '../../store/slices/fraudCaseSlice.js';
import { BTN, INPUT, TABLE, formatCurrency, formatDate } from '../../utils/common.js';
import { PAGINATION } from '../../utils/constants.js';
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
import { RiskBadge, TxStatusBadge, CaseStatusBadge, AlertStatusBadge } from '../../components/common/Badges.jsx';

export default function FlaggedTransactions() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const {
    flagged, selectedFlagged, flaggedLoading: loading, flaggedError: error, flaggedDetailError,
  } = useAppSelector((s) => s.fraudAlerts);
  const [riskLevel, setRiskLevel] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);
  const [viewingId, setViewingId] = useState(null);
  const [createError, setCreateError] = useState('');
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [attempt, setAttempt] = useState(0); // Retry re-runs the load effect

  useEffect(() => {
    const params = { page, limit: PAGINATION.DEFAULT_LIMIT_CASES, ...dateRangeParams(startDate, endDate) };
    if (riskLevel) params.riskLevel = riskLevel;
    dispatch(fetchFlaggedTransactionsThunk(params));
  }, [dispatch, page, riskLevel, startDate, endDate, attempt]);

  const open = (id) => {
    setViewingId(id);
    setCreateError('');
    setNote('');
    dispatch(fetchFlaggedTransactionByIdThunk(id));
  };

  const close = () => {
    setViewingId(null);
    dispatch(clearSelectedFlagged());
  };

  // Only trust the context if it belongs to the transaction that was clicked
  const ctx = selectedFlagged?.transaction?._id === viewingId ? selectedFlagged : null;

  const openCase = async () => {
    if (!ctx?.fraudAlert?._id) return;
    setCreating(true);
    setCreateError('');
    const body = { fraudAlertId: ctx.fraudAlert._id };
    if (note.trim()) body.initialNote = note.trim();
    const action = await dispatch(createCaseThunk(body));
    setCreating(false);
    if (createCaseThunk.fulfilled.match(action)) {
      toast.success(`Case ${action.payload.publicId} opened`);
      close();
      navigate(`/analyst/cases/${action.payload._id}`);
    } else {
      const message = action.payload ?? 'Could not open a case.';
      setCreateError(message);
      // "A case already exists for this alert": reload so the dialog offers the existing case.
      // Other failures (network, 5xx) keep the form so the analyst can simply retry.
      if (/already exists/i.test(message)) dispatch(fetchFlaggedTransactionByIdThunk(viewingId));
    }
  };

  const t = ctx?.transaction;
  const dev = ctx?.deviceReputation;

  return (
    <div>
      <PageHeader title="Flagged transactions" subtitle="HIGH and CRITICAL risk payments from all customers." />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="fl-risk" className={INPUT.label}>Risk level</label>
          <select id="fl-risk" className={INPUT.select} value={riskLevel} onChange={(e) => { setPage(1); setRiskLevel(e.target.value); }}>
            <option value="">High and critical</option>
            <option value="HIGH">HIGH only</option>
            <option value="CRITICAL">CRITICAL only</option>
          </select>
        </div>
        <div>
          <label htmlFor="fl-from" className={INPUT.label}>From</label>
          <input id="fl-from" type="date" className={INPUT.base} value={startDate} max={endDate || undefined} onChange={(e) => { setPage(1); setStartDate(e.target.value); }} />
        </div>
        <div>
          <label htmlFor="fl-to" className={INPUT.label}>To</label>
          <input id="fl-to" type="date" className={INPUT.base} value={endDate} min={startDate || undefined} onChange={(e) => { setPage(1); setEndDate(e.target.value); }} />
        </div>
        <div className="flex items-end">
          <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.md} w-full`} onClick={() => { setPage(1); setRiskLevel(''); setStartDate(''); setEndDate(''); }}>
            Clear filters
          </button>
        </div>
      </div>

      {error ? (
        <LoadError message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : loading && flagged.items.length === 0 ? <Spinner /> : flagged.items.length === 0 ? (
        <EmptyState title="No flagged transactions" message="Nothing matches these filters." />
      ) : (
        <BusyRegion busy={loading}>
          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <thead className={TABLE.thead}>
                <tr>{['', 'ID', 'Customer', 'Merchant', 'Amount', 'Score', 'Risk', 'Status', 'Date'].map((h) => <th key={h || 'a'} className={TABLE.th}>{h ? h : <span className="sr-only">Actions</span>}</th>)}</tr>
              </thead>
              <tbody className={TABLE.tbody}>
                {flagged.items.map((tx) => (
                  <tr key={tx._id} className={TABLE.tr}>
                    <td className={TABLE.td}><button type="button" className={`${BTN.base} ${BTN.primary} ${BTN.sm}`} onClick={() => open(tx._id)} aria-label={`Investigate ${tx.publicId}`}>Investigate</button></td>
                    <td className={TABLE.td}>{tx.publicId}</td>
                    <td className={TABLE.td}>{tx.userId?.name ?? '—'}</td>
                    <td className={TABLE.td}>{tx.merchantName}</td>
                    <td className={TABLE.td}>{formatCurrency(tx.amount)}</td>
                    <td className={TABLE.td}>{tx.fraudScore}</td>
                    <td className={TABLE.td}><RiskBadge level={tx.riskLevel} /></td>
                    <td className={TABLE.td}><TxStatusBadge status={tx.status} /></td>
                    <td className={TABLE.td}>{formatDate(tx.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </BusyRegion>
      )}

      {!error && <Pagination page={page} limit={flagged.pagination.limit} total={flagged.pagination.total} onChange={setPage} />}

      <Modal open={viewingId !== null} title="Investigate transaction" onClose={close} wide dismissible={!creating}>
        {(flaggedDetailError || createError) && <div className="mb-4"><Alert tone="error">{flaggedDetailError || createError}</Alert></div>}
        {!t && !flaggedDetailError && <Spinner className="py-10" />}
        {t && (
          <div className="space-y-6">
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <DetailRow label="Transaction">{t.publicId}</DetailRow>
              <DetailRow label="Amount">{formatCurrency(t.amount)}</DetailRow>
              <DetailRow label="Date">{formatDate(t.timestamp)}</DetailRow>
              <DetailRow label="Customer">{t.userId?.name} <span className="text-gray-500">({t.userId?.email})</span></DetailRow>
              <DetailRow label="Customer trust score">{t.userId?.trustScore}</DetailRow>
              <DetailRow label="Merchant">{t.merchantName} {t.merchantCategory && <span className="text-gray-500">· {t.merchantCategory}</span>}</DetailRow>
              <DetailRow label="Payment method">{t.paymentMethod?.replace('_', ' ')}</DetailRow>
              <DetailRow label="Location">{[t.location?.city, t.location?.country].filter(Boolean).join(', ') || '—'}</DetailRow>
              <DetailRow label="IP address">{t.ipAddress}</DetailRow>
              <DetailRow label="Status"><TxStatusBadge status={t.status} /></DetailRow>
              <DetailRow label="Risk"><RiskBadge level={t.riskLevel} /></DetailRow>
              <DetailRow label="Recommended action">{t.recommendedAction}</DetailRow>
            </dl>

            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Fraud score</p>
              <ScoreBar value={t.fraudScore} label="Fraud score" />
              {t.reasons?.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-700">{t.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
            </div>

            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Device</p>
              <p className="text-sm text-gray-700">
                <Link className="font-medium text-primary-600 hover:underline" to={`/analyst/device-reputation?deviceId=${encodeURIComponent(t.deviceId)}`}>{t.deviceId}</Link>
              </p>
              {dev ? (
                <div className="mt-2 space-y-2">
                  <ScoreBar value={dev.reputationScore} invert label="Device reputation" />
                  <p className="text-xs text-gray-500">
                    {dev.flagCount} flags · {dev.fraudTransactionCount} fraud transactions · {dev.isBlacklisted ? 'BLACKLISTED' : 'not blacklisted'} ·
                    shared by {dev.associatedUserIds?.length ?? 0} customer(s)
                  </p>
                </div>
              ) : <p className="mt-1 text-sm text-gray-500">No reputation record for this device.</p>}
            </div>

            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-gray-900">Investigation</p>
                {ctx.fraudAlert && <AlertStatusBadge status={ctx.fraudAlert.status} />}
              </div>
              {ctx.existingCase ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span className="text-sm text-gray-700">Case {ctx.existingCase.publicId}</span>
                  <CaseStatusBadge status={ctx.existingCase.status} />
                  {ctx.existingCase.assignedAnalystId?.name && <span className="text-xs text-gray-500">assigned to {ctx.existingCase.assignedAnalystId.name}</span>}
                  <Link to={`/analyst/cases/${ctx.existingCase._id}`} className={`${BTN.base} ${BTN.primary} ${BTN.sm}`} onClick={close}>Open case</Link>
                </div>
              ) : ctx.fraudAlert ? (
                <div className="mt-3 space-y-3">
                  <div>
                    <label htmlFor="initial-note" className={INPUT.label}>Initial note (optional)</label>
                    <textarea id="initial-note" rows={3} maxLength={2000} className={INPUT.base} value={note} onChange={(e) => setNote(e.target.value)} />
                  </div>
                  <button type="button" disabled={creating} className={`${BTN.base} ${BTN.primary} ${BTN.md}`} onClick={openCase}>
                    {creating ? 'Opening…' : 'Open investigation case'}
                  </button>
                </div>
              ) : (
                <p className="mt-2 text-sm text-gray-500">This transaction has no fraud alert, so a case cannot be opened for it.</p>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
