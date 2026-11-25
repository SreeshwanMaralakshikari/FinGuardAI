/**
 * @file src/pages/analyst/PayeeProfile.jsx
 * @description TEJAS D1: look up one payee (a UPI ID or a merchant) — how much it received, from how many different
 *   customers (overall and in the last 24 hours), the risk mix of those payments, its watchlist status and its recent
 *   payments. GET /analyst-api/payees/profile?key=… (audited on the server as PAYEE_VIEWED).
 *   Like DeviceReputation (N-05): the URL (?key=) is the single source of truth, one request per search, and deep
 *   links from the flagged-transaction and case pages work. 404 = "no payments to this payee" is a result.
 *   The payments table is a ScrollRegion: keyboard-scrollable on phones (axe scrollable-region-focusable).
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../../api/axios.js';
import { getErrorMessage } from '../../api/errors.js';
import { API_PATHS } from '../../utils/constants.js';
import { BTN, CARD, INPUT, TABLE, formatCurrency, formatDate } from '../../utils/common.js';
import { labelFromKey, payeeKeyFromInput } from '../../utils/payee.js';
import { useFetch } from '../../hooks/useFetch.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import DetailRow from '../../components/common/DetailRow.jsx';
import Alert from '../../components/common/Alert.jsx';
import ScrollRegion from '../../components/common/ScrollRegion.jsx';
import { RiskBadge, TxStatusBadge } from '../../components/common/Badges.jsx';

const RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Body for POST /payees/watchlist from a stored key ("vpa:…" → vpa, "merchant:…" → merchantName). */
const watchlistBody = (key) => (key.startsWith('vpa:') ? { vpa: labelFromKey(key) } : { merchantName: labelFromKey(key) });

function WatchlistStatus({ profile, onAdd, adding }) {
  const w = profile.watchlist;
  if (w?.active) {
    return (
      <Alert tone="error">
        On the payee watchlist ({w.source === 'CONFIRMED_FRAUD' ? 'fraud confirmed in a case' : 'reported by an analyst'}
        {w.caseCount ? `, ${w.caseCount} case${w.caseCount === 1 ? '' : 's'}` : ''}) since {formatDate(w.addedAt)}.
        {w.note ? ` Note: ${w.note}` : ''}{' '}
        <Link to="/analyst/payee-watchlist" className="font-medium underline">Manage watchlist</Link>
      </Alert>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-gray-600">{w ? `Removed from the watchlist on ${formatDate(w.removedAt)}.` : 'Not on the payee watchlist.'}</p>
      <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.sm}`} onClick={onAdd} disabled={adding}>
        {adding ? 'Adding…' : 'Add to watchlist'}
      </button>
    </div>
  );
}

function ProfileDetails({ profile, onAdd, adding }) {
  const { totals, last24h, riskMix, recentPayments } = profile;
  return (
    <div className="space-y-6">
      <section className={`${CARD.base} ${CARD.body} space-y-4`} aria-label="Payee summary">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="break-all text-base font-semibold text-gray-900">{profile.label}</h2>
          <span className="text-xs text-gray-500">{profile.key.startsWith('vpa:') ? 'UPI ID' : 'Merchant'}</span>
        </div>
        <WatchlistStatus profile={profile} onAdd={onAdd} adding={adding} />
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <DetailRow label="Payments (all time)">{totals.payments}</DetailRow>
          <DetailRow label="Received (all time)">{formatCurrency(totals.amount)}</DetailRow>
          <DetailRow label="Different customers">{totals.distinctSenders}</DetailRow>
          <DetailRow label="First payment">{totals.firstPaymentAt ? formatDate(totals.firstPaymentAt) : '—'}</DetailRow>
          <DetailRow label="Payments (24 h)">{last24h.payments}</DetailRow>
          <DetailRow label="Received (24 h)">{formatCurrency(last24h.amount)}</DetailRow>
          <DetailRow label="Different customers (24 h)">{last24h.distinctSenders}</DetailRow>
          <DetailRow label="Last payment">{totals.lastPaymentAt ? formatDate(totals.lastPaymentAt) : '—'}</DetailRow>
        </dl>
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Risk of payments to this payee</p>
          <ul className="flex flex-wrap gap-3" aria-label="Risk mix">
            {RISKS.map((r) => <li key={r} className="flex items-center gap-1.5 text-sm"><RiskBadge level={r} /> {riskMix[r] ?? 0}</li>)}
          </ul>
        </div>
      </section>

      <section aria-labelledby="payee-recent">
        <h2 id="payee-recent" className="mb-3 text-base font-semibold text-gray-900">Recent payments ({recentPayments.length})</h2>
        {recentPayments.length === 0 ? <p className="text-sm text-gray-500">No payments.</p> : (
          <ScrollRegion label="Recent payments to this payee (scrolls sideways)">
            <table className={TABLE.table}>
              <thead className={TABLE.thead}><tr>{['ID', 'Customer', 'Method', 'Amount', 'Score', 'Risk', 'Status', 'Date'].map((h) => <th key={h} className={TABLE.th}>{h}</th>)}</tr></thead>
              <tbody className={TABLE.tbody}>
                {recentPayments.map((t) => (
                  <tr key={t.id} className={TABLE.tr}>
                    <td className={TABLE.td}>{t.publicId}</td>
                    <td className={TABLE.td}>{t.customer?.name ?? '—'}</td>
                    <td className={TABLE.td}>{t.paymentMethod?.replace('_', ' ')}</td>
                    <td className={TABLE.td}>{formatCurrency(t.amount)}</td>
                    <td className={TABLE.td}>{t.fraudScore}</td>
                    <td className={TABLE.td}><RiskBadge level={t.riskLevel} /></td>
                    <td className={TABLE.td}><TxStatusBadge status={t.status} /></td>
                    <td className={TABLE.td}>{formatDate(t.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </section>
    </div>
  );
}

export default function PayeeProfile() {
  const [params, setParams] = useSearchParams();
  const key = (params.get('key') ?? '').trim();
  const [input, setInput] = useState(labelFromKey(key));
  const [syncedKey, setSyncedKey] = useState(key);
  const [inputError, setInputError] = useState('');
  const [adding, setAdding] = useState(false);

  // Keep the text box in step with the URL (browser back / forward, deep links), as on DeviceReputation.
  if (key !== syncedKey) {
    setSyncedKey(key);
    setInput(labelFromKey(key));
    setInputError('');
  }

  const lookup = useFetch(async (signal) => {
    if (!key) return null;
    try {
      const res = await api.get(API_PATHS.ANALYST.PAYEE_PROFILE, { params: { key }, signal });
      return { found: true, profile: res.data.data };
    } catch (err) {
      if (err?.response?.status === 404) return { found: false };
      throw err;
    }
  }, [key]);

  const onSubmit = (e) => {
    e.preventDefault();
    const parsed = payeeKeyFromInput(input);
    if (parsed.error) { setInputError(parsed.error); return; }
    setInputError('');
    if (parsed.key === key) lookup.reload();
    else setParams({ key: parsed.key });
  };

  const addToWatchlist = async () => {
    setAdding(true);
    try {
      const res = await api.post(API_PATHS.ANALYST.PAYEE_WATCHLIST, watchlistBody(key));
      toast.success(res.data.message ?? 'Payee added to the watchlist.');
      lookup.reload();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not add the payee to the watchlist'));
    } finally {
      setAdding(false);
    }
  };

  const searching = Boolean(key) && lookup.loading;
  const result = key && !lookup.loading && !lookup.error ? lookup.data : null;

  return (
    <div>
      <PageHeader title="Payees" subtitle="Who received the money: totals, how many different customers paid, and the watchlist status." />

      <form onSubmit={onSubmit} noValidate className="mb-6 flex max-w-2xl flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex-1">
          <label htmlFor="payeeQuery" className={INPUT.label}>UPI ID or merchant name</label>
          <input
            id="payeeQuery"
            type="text"
            className={INPUT.base}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. easyloan.helpdesk@ybl or Gadget Hub"
            aria-invalid={Boolean(inputError)}
            aria-describedby={inputError ? 'payeeQuery-error' : undefined}
            autoComplete="off"
          />
          {inputError && <p id="payeeQuery-error" className="mt-1 text-xs text-red-600">{inputError}</p>}
        </div>
        <button type="submit" className={`${BTN.base} ${BTN.primary} ${BTN.md} sm:mt-6`} disabled={!input.trim() || searching}>Search</button>
      </form>

      {!key && <EmptyState title="Search for a payee" message="Type a UPI ID, or open a payee from a flagged transaction or a case." />}
      {searching && <Spinner />}
      {key && !lookup.loading && <LoadError message={lookup.error} onRetry={lookup.reload} />}
      {result && !result.found && <EmptyState title="No payments to this payee" message="Nobody has paid this payee yet, and it is not on the watchlist." />}
      {result?.found && <ProfileDetails profile={result.profile} onAdd={addToWatchlist} adding={adding} />}
    </div>
  );
}
