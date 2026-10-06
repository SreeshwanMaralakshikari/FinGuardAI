/**
 * @file src/pages/analyst/DeviceReputation.jsx
 * @description Device lookup (local state + api, no Redux device slice — D-P7-06, C-P7-03).
 *   GET /analyst-api/devices/:deviceId → { device, recentTransactions[10] }.
 *   404 = "not in the reputation registry" is a normal result, not an error.
 *   Supports ?deviceId=… deep links (from the flagged-transaction / case pages).
 *   N-05: the lookup is driven ONLY by the URL param (one request per search); the input mirrors
 *   the param, so browser back / forward restores both the text and the result.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { BTN, CARD, INPUT, TABLE, formatCurrency, formatDate } from '../../utils/common.js';
import { useFetch } from '../../hooks/useFetch.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import DetailRow from '../../components/common/DetailRow.jsx';
import ScoreBar from '../../components/common/ScoreBar.jsx';
import { RiskBadge, TxStatusBadge } from '../../components/common/Badges.jsx';

export default function DeviceReputation() {
  const [params, setParams] = useSearchParams();
  const deviceId = (params.get('deviceId') ?? '').trim();
  const [input, setInput] = useState(params.get('deviceId') ?? '');
  const [syncedParam, setSyncedParam] = useState(params.get('deviceId') ?? '');

  // Keep the text box in step with the URL (browser back / forward, deep links). Adjusting state
  // while rendering — instead of in an effect — avoids an extra render with the old text.
  const urlValue = params.get('deviceId') ?? '';
  if (urlValue !== syncedParam) {
    setSyncedParam(urlValue);
    setInput(urlValue);
  }

  // N-05: the URL is the single source of truth. Submitting only changes the URL; this ONE lookup
  // reacts to it (it used to be fired twice per search: once by setParams, once directly).
  const lookup = useFetch(async () => {
    if (!deviceId) return null;
    try {
      const res = await api.get(`${API_PATHS.ANALYST.DEVICE_REPUTATION}/${encodeURIComponent(deviceId)}`);
      return { found: true, ...res.data.data };
    } catch (err) {
      if (err?.response?.status === 404) return { found: false }; // "not in the registry" is a result, not an error
      throw err;
    }
  }, [deviceId]);

  const onSubmit = (e) => {
    e.preventDefault();
    const v = input.trim();
    if (!v) return;
    if (v === deviceId) lookup.reload(); // same id again = refresh
    else setParams({ deviceId: v });
  };

  const searching = Boolean(deviceId) && lookup.loading;
  const result = deviceId && !lookup.loading && !lookup.error ? lookup.data : null;

  const d = result?.found ? result.device : null;
  const recent = result?.found ? (result.recentTransactions ?? []) : [];

  return (
    <div>
      <PageHeader title="Device reputation" subtitle="Look up a device fingerprint: its score, flags and the customers who used it." />

      <form onSubmit={onSubmit} className="mb-6 flex max-w-2xl flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="deviceId" className={INPUT.label}>Device ID</label>
          <input id="deviceId" type="text" className={INPUT.base} value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. web-1a2b3c…" />
        </div>
        <button type="submit" className={`${BTN.base} ${BTN.primary} ${BTN.md}`} disabled={!input.trim() || searching}>Search</button>
      </form>

      {!deviceId && <EmptyState title="Search for a device" message="Paste a device ID from a flagged transaction." />}
      {searching && <Spinner />}
      {deviceId && !lookup.loading && <LoadError message={lookup.error} onRetry={lookup.reload} />}
      {result && !result.found && <EmptyState title="Device not found" message="This device has no reputation record yet — it has not been seen in a scored transaction." />}

      {d && (
        <div className="space-y-6">
          <section className={`${CARD.base} ${CARD.body}`} aria-label="Reputation">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="break-all text-base font-semibold text-gray-900">{d.deviceId}</h2>
              {d.isBlacklisted
                ? <span className="inline-flex items-center rounded-full border border-red-300 bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-700">BLACKLISTED</span>
                : <span className="inline-flex items-center rounded-full border border-emerald-300 bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">Not blacklisted</span>}
            </div>
            <div className="mt-4 max-w-md">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Reputation score (higher is safer)</p>
              <ScoreBar value={d.reputationScore} invert label="Reputation score" />
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <DetailRow label="Flags">{d.flagCount}</DetailRow>
              <DetailRow label="Fraud transactions">{d.fraudTransactionCount}</DetailRow>
              <DetailRow label="First seen">{formatDate(d.firstSeenAt)}</DetailRow>
              <DetailRow label="Last seen">{formatDate(d.lastSeenAt)}</DetailRow>
            </dl>
          </section>

          <section aria-labelledby="assoc">
            <h2 id="assoc" className="mb-3 text-base font-semibold text-gray-900">Customers who used this device ({d.associatedUserIds?.length ?? 0})</h2>
            {(d.associatedUserIds ?? []).length === 0 ? <p className="text-sm text-gray-500">None recorded.</p> : (
              <div className={TABLE.wrapper}>
                <table className={TABLE.table}>
                  <thead className={TABLE.thead}><tr>{['Name', 'Email', 'Role', 'Trust score'].map((h) => <th key={h} className={TABLE.th}>{h}</th>)}</tr></thead>
                  <tbody className={TABLE.tbody}>
                    {d.associatedUserIds.map((u) => (
                      <tr key={u._id} className={TABLE.tr}>
                        <td className={TABLE.td}>{u.name}</td><td className={TABLE.td}>{u.email}</td>
                        <td className={TABLE.td}>{u.role}</td><td className={TABLE.td}>{u.trustScore}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="recent-dev">
            <h2 id="recent-dev" className="mb-3 text-base font-semibold text-gray-900">Recent transactions</h2>
            {recent.length === 0 ? <p className="text-sm text-gray-500">No transactions.</p> : (
              <div className={TABLE.wrapper}>
                <table className={TABLE.table}>
                  <thead className={TABLE.thead}><tr>{['ID', 'Customer', 'Merchant', 'Amount', 'Score', 'Risk', 'Status', 'Date'].map((h) => <th key={h} className={TABLE.th}>{h}</th>)}</tr></thead>
                  <tbody className={TABLE.tbody}>
                    {recent.map((t) => (
                      <tr key={t._id} className={TABLE.tr}>
                        <td className={TABLE.td}>{t.publicId}</td>
                        <td className={TABLE.td}>{t.userId?.name ?? '—'}</td>
                        <td className={TABLE.td}>{t.merchantName}</td>
                        <td className={TABLE.td}>{formatCurrency(t.amount)}</td>
                        <td className={TABLE.td}>{t.fraudScore}</td>
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
      )}
    </div>
  );
}
