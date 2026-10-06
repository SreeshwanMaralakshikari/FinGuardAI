/**
 * @file src/pages/analyst/CaseDetail.jsx
 * @description One investigation case: summary, transaction, alert reasons, notes, workflow actions.
 *   - Case document is fully populated (fraudAlertId, transactionId, assignedAnalystId, notes[].analystId).
 *   - Workflow (STATUS_TRANSITIONS mirrors the server, which enforces it and answers 400 otherwise;
 *     only the assigned analyst may change the status — 403 for anyone else):
 *       OPEN → (take the case) → ASSIGNED → UNDER_REVIEW → RESOLVED | DISMISSED
 *       ASSIGNED → DISMISSED is allowed too. DISMISSED = false positive: the alert is dismissed and the
 *       held / blocked transaction is released (APPROVED); the customer is notified of the outcome.
 *   - RESOLVED / DISMISSED require a resolutionSummary (max 5000) — AUD-07.
 *   - After a status change the case is refetched so resolvedAt / resolutionSummary are current.
 *   - Closed cases are read-only (the API rejects assign / status / notes with 400).
 *   - N-06: an error from closing the case is shown INSIDE the Resolve / Dismiss dialog (page-level
 *     alerts sit behind the overlay), the dialog stays open on failure and cannot be dismissed
 *     while the request runs.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import {
  fetchCaseByIdThunk, assignCaseThunk, updateCaseStatusThunk, addCaseNoteThunk, clearSelectedCase,
} from '../../store/slices/fraudCaseSlice.js';
import { STATUS_TRANSITIONS } from '../../utils/constants.js';
import { BTN, CARD, INPUT, formatCurrency, formatDate } from '../../utils/common.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import Alert from '../../components/common/Alert.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import Modal from '../../components/common/Modal.jsx';
import DetailRow from '../../components/common/DetailRow.jsx';
import ScoreBar from '../../components/common/ScoreBar.jsx';
import { RiskBadge, CaseStatusBadge, TxStatusBadge } from '../../components/common/Badges.jsx';


const CLOSING = ['RESOLVED', 'DISMISSED'];
const ACTION_LABEL = { UNDER_REVIEW: 'Start review', RESOLVED: 'Resolve', DISMISSED: 'Dismiss' };

export default function CaseDetail() {
  const { id } = useParams();
  const dispatch = useAppDispatch();
  const me = useAppSelector((s) => s.auth.user);
  const { selectedCase: c } = useAppSelector((s) => s.fraudCases);
  const [loadFailure, setLoadFailure] = useState(null); // { id, message }
  const loadError = loadFailure?.id === id ? loadFailure.message : '';
  const [actionError, setActionError] = useState('');
  const [closeError, setCloseError] = useState(''); // shown inside the Resolve / Dismiss dialog (N-06)
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(null); // 'RESOLVED' | 'DISMISSED' while the summary modal is open
  const [summary, setSummary] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const [attempt, setAttempt] = useState(0); // Retry re-runs the load effect
  const noteForm = useForm({ defaultValues: { noteText: '' } });

  useEffect(() => {
    let active = true;
    dispatch(fetchCaseByIdThunk(id)).then((action) => {
      if (active && fetchCaseByIdThunk.rejected.match(action) && action.meta.aborted !== true) {
        setLoadFailure({ id, message: action.payload ?? 'Could not load the case.' });
      }
    });
    return () => { active = false; dispatch(clearSelectedCase()); };
  }, [dispatch, id, attempt]);

  if (loadError) {
    return (
      <div className="max-w-xl space-y-4">
        <LoadError message={loadError} onRetry={() => { setLoadFailure(null); setAttempt((n) => n + 1); }} />
        <Link to="/analyst/cases" className={`${BTN.base} ${BTN.secondary} ${BTN.md}`}>Back to cases</Link>
      </div>
    );
  }
  if (!c || c._id !== id) return <Spinner />;

  /**
   * Reload the case, but only while it is still the one in the store. A late reply for a case the
   * user already left must not clobber the one now on screen (the store holds the current case).
   */
  const refreshCase = (caseId) => dispatch((thunkDispatch, getState) => {
    if (getState().fraudCases.selectedCase?._id === caseId) thunkDispatch(fetchCaseByIdThunk(caseId));
  });

  const closed = CLOSING.includes(c.status);
  const assignedToMe = c.assignedAnalystId?._id === me?.id;
  const nextStatuses = STATUS_TRANSITIONS[c.status] ?? [];
  const alert = c.fraudAlertId && typeof c.fraudAlertId === 'object' ? c.fraudAlertId : null;
  const tx = c.transactionId && typeof c.transactionId === 'object' ? c.transactionId : null;

  /** Runs a thunk with the busy flag; a failure goes to `onError` (page alert by default). */
  const run = async (thunkAction, okMessage, onError = setActionError) => {
    setBusy(true);
    setActionError('');
    setCloseError('');
    const action = await dispatch(thunkAction);
    setBusy(false);
    if (action.type.endsWith('/fulfilled')) {
      if (okMessage) toast.success(okMessage);
      return true;
    }
    onError(action.payload ?? action.error?.message ?? 'The action failed.');
    // The case probably changed under us (400 / 403 / 409): reload it so the
    // buttons and "assigned to me" match the server again.
    refreshCase(c._id);
    return false;
  };

  const onAssign = async () => {
    await run(assignCaseThunk({ id: c._id, analystId: me.id }), 'Case assigned to you');
  };

  const onStatus = async (status) => {
    if (CLOSING.includes(status)) { setSummary(''); setSummaryError(''); setCloseError(''); setClosing(status); return; }
    if (await run(updateCaseStatusThunk({ id: c._id, status }), `Status: ${status.replace('_', ' ')}`)) {
      refreshCase(c._id);
    }
  };

  const confirmClose = async () => {
    const text = summary.trim();
    if (!text) { setSummaryError('A resolution summary is required.'); return; }
    if (text.length > 5000) { setSummaryError('The summary cannot exceed 5000 characters.'); return; }
    const ok = await run(
      updateCaseStatusThunk({ id: c._id, status: closing, resolutionSummary: text }),
      `Case ${closing.toLowerCase()}`,
      setCloseError,
    );
    if (ok) {
      setClosing(null);
      refreshCase(c._id);
    }
  };

  const onAddNote = async ({ noteText }) => {
    setActionError('');
    const action = await dispatch(addCaseNoteThunk({ id: c._id, note: noteText.trim() }));
    if (addCaseNoteThunk.fulfilled.match(action)) noteForm.reset({ noteText: '' });
    else {
      setActionError(action.payload ?? 'Could not add the note.');
      refreshCase(c._id);
    }
  };

  return (
    <div>
      <PageHeader
        title={`Case ${c.publicId}`}
        subtitle={`Opened ${formatDate(c.openedAt)}`}
        actions={<Link to="/analyst/cases" className={`${BTN.base} ${BTN.secondary} ${BTN.sm}`}>All cases</Link>}
      />
      <div className="mb-4"><Alert tone="error">{actionError}</Alert></div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <section className={`${CARD.base} ${CARD.body}`} aria-label="Case summary">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <DetailRow label="Status"><CaseStatusBadge status={c.status} /></DetailRow>
              <DetailRow label="Assigned to">{c.assignedAnalystId?.name ?? 'Unassigned'}</DetailRow>
              <DetailRow label="Opened">{formatDate(c.openedAt)}</DetailRow>
              <DetailRow label="Closed">{c.resolvedAt ? formatDate(c.resolvedAt) : '—'}</DetailRow>
            </dl>
            {c.resolutionSummary && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Resolution summary</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{c.resolutionSummary}</p>
              </div>
            )}
          </section>

          {tx && (
            <section className={`${CARD.base} ${CARD.body}`} aria-label="Transaction">
              <h2 className="mb-4 text-base font-semibold text-gray-900">Transaction</h2>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <DetailRow label="ID">{tx.publicId}</DetailRow>
                <DetailRow label="Amount">{formatCurrency(tx.amount)}</DetailRow>
                <DetailRow label="Merchant">{tx.merchantName}</DetailRow>
                <DetailRow label="Date">{formatDate(tx.timestamp)}</DetailRow>
                <DetailRow label="Risk"><RiskBadge level={tx.riskLevel} /></DetailRow>
                <DetailRow label="Status"><TxStatusBadge status={tx.status} /></DetailRow>
                <DetailRow label="IP">{tx.ipAddress}</DetailRow>
                <DetailRow label="Device">
                  {tx.deviceId ? <Link className="text-primary-600 hover:underline" to={`/analyst/device-reputation?deviceId=${encodeURIComponent(tx.deviceId)}`}>{tx.deviceId}</Link> : '—'}
                </DetailRow>
              </dl>
              <div className="mt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Fraud score</p>
                <ScoreBar value={tx.fraudScore} label="Fraud score" />
              </div>
            </section>
          )}

          {alert?.reasons?.length > 0 && (
            <section className={`${CARD.base} ${CARD.body}`} aria-label="Alert reasons">
              <h2 className="mb-3 text-base font-semibold text-gray-900">Why it was flagged</h2>
              <p className="mb-2 text-xs text-gray-500">{alert.alertType?.replaceAll('_', ' ')}</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">{alert.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            </section>
          )}

          <section className={`${CARD.base} ${CARD.body}`} aria-labelledby="notes-title">
            <h2 id="notes-title" className="mb-4 text-base font-semibold text-gray-900">Investigation notes</h2>
            {(c.notes ?? []).length === 0 ? (
              <p className="text-sm text-gray-500">No notes yet.</p>
            ) : (
              <ul className="space-y-3">
                {c.notes.map((n, i) => (
                  <li key={n._id ?? `${n.createdAt}-${i}`} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                    <p className="whitespace-pre-wrap text-sm text-gray-800">{n.text}</p>
                    <p className="mt-1 text-xs text-gray-500">{n.analystId?.name ?? 'Analyst'} · {formatDate(n.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}

            {!closed && (
              <form onSubmit={noteForm.handleSubmit(onAddNote)} noValidate className="mt-4 space-y-2">
                <label htmlFor="noteText" className={INPUT.label}>Add a note</label>
                <textarea
                  id="noteText"
                  rows={3}
                  className={`${INPUT.base} ${noteForm.formState.errors.noteText ? INPUT.error : ''}`}
                  {...noteForm.register('noteText', {
                    required: 'Write something first',
                    maxLength: { value: 2000, message: 'A note cannot exceed 2000 characters' },
                    validate: (v) => v.trim().length > 0 || 'Write something first',
                  })}
                />
                {noteForm.formState.errors.noteText && <p className={INPUT.errMsg} role="alert">{noteForm.formState.errors.noteText.message}</p>}
                <button type="submit" disabled={noteForm.formState.isSubmitting} className={`${BTN.base} ${BTN.primary} ${BTN.sm}`}>
                  {noteForm.formState.isSubmitting ? 'Adding…' : 'Add note'}
                </button>
              </form>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <section className={`${CARD.base} ${CARD.body}`} aria-label="Actions">
            <h2 className="mb-3 text-base font-semibold text-gray-900">Actions</h2>
            {closed ? (
              <p className="text-sm text-gray-500">This case is closed and read-only.</p>
            ) : (
              <div className="space-y-3">
                {!assignedToMe && (
                  <button type="button" disabled={busy} className={`${BTN.base} ${BTN.primary} ${BTN.md} w-full`} onClick={onAssign}>
                    {c.assignedAnalystId ? 'Take over this case' : 'Assign to me'}
                  </button>
                )}
                {c.status === 'OPEN' && <p className="text-xs text-gray-500">Assign the case to yourself to start working on it.</p>}
                {nextStatuses.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={busy || !assignedToMe}
                    className={`${BTN.base} ${s === 'DISMISSED' ? BTN.secondary : BTN.primary} ${BTN.md} w-full`}
                    onClick={() => onStatus(s)}
                  >
                    {ACTION_LABEL[s]}
                  </button>
                ))}
                {nextStatuses.length > 0 && !assignedToMe && (
                  <p className="text-xs text-gray-500">Only the assigned analyst can change the status.</p>
                )}
              </div>
            )}
          </section>
        </aside>
      </div>

      <Modal
        open={closing !== null}
        title={closing === 'RESOLVED' ? 'Resolve case' : 'Dismiss case'}
        onClose={() => setClosing(null)}
        dismissible={!busy}
        footer={(
          <>
            <button type="button" disabled={busy} className={`${BTN.base} ${BTN.secondary} ${BTN.md}`} onClick={() => setClosing(null)}>Cancel</button>
            <button type="button" disabled={busy} className={`${BTN.base} ${BTN.primary} ${BTN.md}`} onClick={confirmClose}>
              {closing === 'RESOLVED' ? 'Resolve case' : 'Dismiss case'}
            </button>
          </>
        )}
      >
        {closeError && <div className="mb-3"><Alert tone="error">{closeError}</Alert></div>}
        <p className="mb-3 text-xs text-gray-500">
          {closing === 'DISMISSED'
            ? 'Dismissing marks the alert as a false positive: the transaction is released (approved) and the customer is notified.'
            : 'Resolving closes the case; the customer is notified of the outcome.'}
        </p>
        <label htmlFor="resolutionSummary" className={INPUT.label}>Resolution summary (required)</label>
        <textarea
          id="resolutionSummary"
          rows={5}
          maxLength={5000}
          className={`${INPUT.base} ${summaryError ? INPUT.error : ''}`}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="What did you find, and why is the case being closed?"
        />
        <p className="mt-1 text-xs text-gray-500">{summary.length}/5000</p>
        {summaryError && <p className={INPUT.errMsg} role="alert">{summaryError}</p>}
      </Modal>
    </div>
  );
}
