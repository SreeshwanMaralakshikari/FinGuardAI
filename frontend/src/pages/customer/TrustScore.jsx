/**
 * @file src/pages/customer/TrustScore.jsx
 * @description SVG meter + behaviour summary. The score is read from GET /customer-api/trust-score
 *   on mount (AUD-09). Bands: Excellent 80–100, Good 60–79, Fair 40–59, Poor 0–39.
 *   Recent activity = last 5 transactions, loaded into LOCAL state (N-08: not the Redux keys of the
 *   Transactions page). N-02: failures show the error + Retry.
 */
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { CARD, formatCurrency, formatDate } from '../../utils/common.js';
import { useFetch } from '../../hooks/useFetch.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import DetailRow from '../../components/common/DetailRow.jsx';
import { RiskBadge, TxStatusBadge } from '../../components/common/Badges.jsx';

const BANDS = [
  { min: 80, label: 'Excellent', stroke: 'stroke-emerald-500', text: 'text-emerald-600' },
  { min: 60, label: 'Good',      stroke: 'stroke-green-500',   text: 'text-green-600' },
  { min: 40, label: 'Fair',      stroke: 'stroke-yellow-500',  text: 'text-yellow-700' },
  { min: 0,  label: 'Poor',      stroke: 'stroke-red-500',     text: 'text-red-600' },
];

const RADIUS = 70;
const CIRC = 2 * Math.PI * RADIUS;

export default function TrustScore() {
  const { data, loading, error, reload } = useFetch(
    async () => (await api.get(API_PATHS.CUSTOMER.TRUST_SCORE)).data.data,
    [],
  );
  const recent = useFetch(
    async () => (await api.get(API_PATHS.CUSTOMER.TRANSACTIONS, { params: { limit: 5 } })).data.data ?? [],
    [],
  );
  const transactions = recent.data ?? [];

  if (loading) return <Spinner />;
  if (error) {
    return (
      <div>
        <PageHeader title="Trust score" subtitle="Calculated from your payment history. It changes after every transaction." />
        <LoadError message={error} onRetry={reload} />
      </div>
    );
  }

  const score = Math.max(0, Math.min(100, Number(data?.trustScore) || 0));
  const band = BANDS.find((b) => score >= b.min) ?? BANDS[BANDS.length - 1];
  const summary = data?.behaviorSummary;

  return (
    <div>
      <PageHeader title="Trust score" subtitle="Calculated from your payment history. It changes after every transaction." />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className={`${CARD.base} flex flex-col items-center p-8`} aria-label="Trust score meter">
          <svg viewBox="0 0 180 180" className="h-48 w-48" role="img" aria-label={`Trust score ${score} out of 100, ${band.label}`}>
            <circle cx="90" cy="90" r={RADIUS} fill="none" strokeWidth="14" className="stroke-gray-100" />
            <circle
              cx="90" cy="90" r={RADIUS} fill="none" strokeWidth="14" strokeLinecap="round"
              className={band.stroke}
              strokeDasharray={CIRC}
              strokeDashoffset={CIRC * (1 - score / 100)}
              transform="rotate(-90 90 90)"
            />
            <text x="90" y="88" textAnchor="middle" className="fill-gray-900 text-4xl font-bold">{score}</text>
            <text x="90" y="112" textAnchor="middle" className="fill-gray-500 text-xs">out of 100</text>
          </svg>
          <p className={`mt-2 text-xl font-semibold ${band.text}`}>{band.label}</p>
          <p className="mt-1 text-center text-xs text-gray-500">Excellent 80–100 · Good 60–79 · Fair 40–59 · Poor 0–39</p>
        </section>

        <section className={`${CARD.base} p-6 lg:col-span-2`} aria-label="Behaviour summary">
          <h2 className="text-base font-semibold text-gray-900">Your usual behaviour</h2>
          {!summary ? (
            <p className="mt-3 text-sm text-gray-500">Not enough approved activity yet — submit a few payments to build your profile.</p>
          ) : (
            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <DetailRow label="Average amount">{formatCurrency(summary.avgTransactionAmount)}</DetailRow>
              <DetailRow label="Largest amount">{formatCurrency(summary.maxTransactionAmount)}</DetailRow>
              <DetailRow label="Updated">{formatDate(summary.lastUpdated)}</DetailRow>
              <DetailRow label="Usual cities">{summary.usualLocations?.join(', ') || '—'}</DetailRow>
              <DetailRow label="Usual methods">{summary.usualPaymentMethods?.map((m) => m.replace('_', ' ')).join(', ') || '—'}</DetailRow>
            </dl>
          )}
        </section>
      </div>

      <section className="mt-8" aria-labelledby="recent-activity">
        <h2 id="recent-activity" className="mb-3 text-base font-semibold text-gray-900">Recent activity</h2>
        {recent.error ? (
          <LoadError message={recent.error} onRetry={recent.reload} />
        ) : recent.loading ? (
          <Spinner className="py-6" />
        ) : transactions.length === 0 ? (
          <p className="text-sm text-gray-500">No transactions yet.</p>
        ) : (
          <ul className={`${CARD.base} divide-y divide-gray-100`}>
            {transactions.slice(0, 5).map((t) => (
              <li key={t._id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="text-sm font-medium text-gray-900">{t.merchantName}</p>
                  <p className="text-xs text-gray-500">{formatDate(t.timestamp)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-700">{formatCurrency(t.amount)}</span>
                  <RiskBadge level={t.riskLevel} />
                  <TxStatusBadge status={t.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
