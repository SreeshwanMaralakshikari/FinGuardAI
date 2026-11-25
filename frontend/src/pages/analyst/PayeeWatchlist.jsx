/**
 * @file src/pages/analyst/PayeeWatchlist.jsx
 * @description TEJAS D1: the payee watchlist, a shared list of payees that received money in fraud.
 *   - Payees are added automatically when an analyst confirms fraud in a case (UPI IDs only), or by hand here.
 *   - Removing keeps the history (soft removal with an optional note); adding the payee again reactivates it.
 *   - Every change is audited on the server (PAYEE_WATCHLISTED / PAYEE_UNWATCHLISTED).
 *   GET /analyst-api/payees/watchlist?status=active|removed|all&page&limit · POST (vpa | merchantName, note)
 *   · DELETE /:id (note). Payments to a watchlisted payee are flagged to analysts, and the paying customer is warned.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../../api/axios.js';
import { getErrorMessage } from '../../api/errors.js';
import { API_PATHS } from '../../utils/constants.js';
import { BTN, CARD, INPUT, TABLE, formatDate } from '../../utils/common.js';
import { WATCHLIST_NOTE_MAX as NOTE_MAX, buildWatchlistBody, payeeProfilePath } from '../../utils/payee.js';
import { useFetch } from '../../hooks/useFetch.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Pagination from '../../components/common/Pagination.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import TableSkeleton from '../../components/common/TableSkeleton.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import Modal from '../../components/common/Modal.jsx';

const LIMIT = 20;
const SOURCE_TEXT = { CONFIRMED_FRAUD: 'Fraud confirmed', ANALYST_REPORT: 'Analyst report' };
const STATUS_OPTIONS = [['active', 'On the watchlist'], ['removed', 'Removed'], ['all', 'All']];

function AddPayeeForm({ onAdded }) {
  const [payee, setPayee] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const built = buildWatchlistBody(payee, note);
    if (built.error) { setError(built.error); return; }
    setError('');
    setSaving(true);
    try {
      const res = await api.post(API_PATHS.ANALYST.PAYEE_WATCHLIST, built.body);
      toast.success(res.data.message ?? 'Payee added to the watchlist.');
      setPayee('');
      setNote('');
      onAdded();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not add the payee'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className={`${CARD.base} ${CARD.body} mb-6 space-y-3`} aria-label="Add a payee">
      <h2 className="text-base font-semibold text-gray-900">Add a payee</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="wl-payee" className={INPUT.label}>UPI ID or merchant name</label>
          <input id="wl-payee" type="text" className={INPUT.base} value={payee} onChange={(e) => setPayee(e.target.value)}
            placeholder="e.g. easyloan.helpdesk@ybl" autoComplete="off" aria-invalid={Boolean(error)}
            aria-describedby={error ? 'wl-error' : undefined} />
        </div>
        <div>
          <label htmlFor="wl-note" className={INPUT.label}>Note (optional)</label>
          <input id="wl-note" type="text" className={INPUT.base} value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)}
            placeholder="Why it is listed, e.g. reported by 3 customers" />
        </div>
      </div>
      {error && <p id="wl-error" className={INPUT.errMsg} role="alert">{error}</p>}
      <button type="submit" className={`${BTN.base} ${BTN.primary} ${BTN.md}`} disabled={saving || !payee.trim()}>
        {saving ? 'Adding…' : 'Add to watchlist'}
      </button>
    </form>
  );
}

function RemoveDialog({ entry, onClose, onRemoved }) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    setSaving(true);
    setError('');
    try {
      await api.delete(`${API_PATHS.ANALYST.PAYEE_WATCHLIST}/${entry.id}`, { data: note.trim() ? { note: note.trim() } : {} });
      toast.success(`${entry.label} removed from the watchlist`);
      onRemoved();
    } catch (err) {
      setError(getErrorMessage(err, 'Could not remove the payee'));
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      title={`Remove ${entry.label} from the watchlist?`}
      onClose={onClose}
      dismissible={!saving}
      footer={(
        <>
          <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.md}`} onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className={`${BTN.base} ${BTN.danger} ${BTN.md}`} onClick={remove} disabled={saving}>{saving ? 'Removing…' : 'Remove'}</button>
        </>
      )}
    >
      <p className="text-sm text-gray-600">Payments to this payee will no longer be flagged. The entry and its history are kept.</p>
      <label htmlFor="wl-remove-note" className={`${INPUT.label} mt-4`}>Reason (optional)</label>
      <input id="wl-remove-note" type="text" className={INPUT.base} value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} />
      {error && <p className={INPUT.errMsg} role="alert">{error}</p>}
    </Modal>
  );
}

// Long text wraps (note, added-by) and the status column appears only where removed entries can be listed, so the
// table fits a 1280 px screen with the Remove button visible.
const TD_WRAP = TABLE.td.replace('whitespace-nowrap', 'whitespace-normal break-words');

function WatchlistTable({ entries, showStatus, onRemove }) {
  const headers = ['Payee', 'Source', 'Cases', 'Note', 'Added', ...(showStatus ? ['Status'] : []), ''];
  return (
    <div className={TABLE.wrapper}>
      <table className={TABLE.table}>
        <thead className={TABLE.thead}>
          <tr>{headers.map((h) => <th key={h || 'actions'} className={TABLE.th}>{h || <span className="sr-only">Actions</span>}</th>)}</tr>
        </thead>
        <tbody className={TABLE.tbody}>
          {entries.map((e) => (
            <tr key={e.id} className={TABLE.tr}>
              <td className={TD_WRAP}><Link className="font-medium text-primary-600 hover:underline" to={payeeProfilePath(e.key)}>{e.label}</Link></td>
              <td className={TABLE.td}>{SOURCE_TEXT[e.source] ?? e.source}</td>
              <td className={TABLE.td}>{e.caseCount}</td>
              <td className={`${TD_WRAP} min-w-48 max-w-xs`}>{e.note || '—'}</td>
              <td className={TD_WRAP}>
                {formatDate(e.addedAt)}
                {e.addedBy?.name && <span className="block text-xs text-gray-500">{e.addedBy.name}</span>}
              </td>
              {showStatus && (
                <td className={TD_WRAP}>
                  {e.active ? 'On the watchlist' : <>Removed {formatDate(e.removedAt)}{e.removalNote && <span className="block text-xs text-gray-500">{e.removalNote}</span>}</>}
                </td>
              )}
              <td className={TABLE.td}>
                {e.active && (
                  <button type="button" className={`${BTN.base} ${BTN.ghost} ${BTN.sm}`} onClick={() => onRemove(e)} aria-label={`Remove ${e.label}`}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PayeeWatchlist() {
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [removing, setRemoving] = useState(null);

  const list = useFetch(async (signal) => {
    const res = await api.get(API_PATHS.ANALYST.PAYEE_WATCHLIST, { params: { status, page, limit: LIMIT }, signal });
    return { entries: res.data.data ?? [], total: res.data.pagination?.total ?? 0 };
  }, [status, page]);

  const entries = list.data?.entries ?? [];

  return (
    <div>
      <PageHeader title="Payee watchlist" subtitle="Payees that received money in fraud. Payments to them are flagged to analysts, and the paying customer is warned." />
      <AddPayeeForm onAdded={() => { if (page === 1 && status === 'active') list.reload(); else { setStatus('active'); setPage(1); } }} />

      <div className="mb-4 max-w-xs">
        <label htmlFor="wl-status" className={INPUT.label}>Show</label>
        <select id="wl-status" className={INPUT.select} value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
          {STATUS_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </div>

      {list.loading && !list.data && <TableSkeleton rows={4} cols={7} />}
      <LoadError message={list.error} onRetry={list.reload} />
      {!list.loading && !list.error && entries.length === 0 && (
        <EmptyState title="No payees here" message={status === 'active' ? 'Payees appear here when fraud is confirmed in a case, or when you add one.' : 'Nothing to show for this filter.'} />
      )}
      {entries.length > 0 && <WatchlistTable entries={entries} showStatus={status !== 'active'} onRemove={setRemoving} />}
      {(list.data?.total ?? 0) > LIMIT && <Pagination page={page} limit={LIMIT} total={list.data.total} onChange={setPage} />}

      {removing && (
        <RemoveDialog
          entry={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => { setRemoving(null); list.reload(); }}
        />
      )}
    </div>
  );
}
