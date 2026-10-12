/**
 * @file src/components/common/FraudTimeline.jsx
 * @description A-02: the customer's activity feed, newest first (GET /customer-api/timeline).
 *   Event: { id, type: 'TRANSACTION'|'ALERT'|'CASE_OUTCOME', timestamp, title, description,
 *            riskLevel, status, amount, transactionId (public id) }.
 *   An ordered list; every event has a time (IST), an icon AND a text label for its type and the risk
 *   level as text — colour is never the only cue. Links go to the transaction history / alert list.
 */
import { Link } from 'react-router-dom';
import { formatCurrency, formatDate } from '../../utils/common.js';
import Icon from './Icon.jsx';
import { RiskBadge } from './Badges.jsx';

const TYPES = {
  TRANSACTION:  { icon: 'send',   label: 'Payment',      ring: 'bg-blue-50 text-blue-700 border-blue-200' },
  ALERT:        { icon: 'alert',  label: 'Fraud alert',  ring: 'bg-amber-50 text-amber-800 border-amber-200' },
  CASE_OUTCOME: { icon: 'shield', label: 'Case outcome', ring: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};
const FALLBACK = { icon: 'list', label: 'Activity', ring: 'bg-gray-50 text-gray-700 border-gray-200' };

const statusText = (status) => String(status ?? '').replaceAll('_', ' ').toLowerCase();

export default function FraudTimeline({ events }) {
  return (
    <ol className="relative space-y-4 border-l-2 border-gray-200 pl-6" aria-label="Fraud timeline, newest first">
      {events.map((e) => {
        const t = TYPES[e.type] ?? FALLBACK;
        const linkTo = e.type === 'TRANSACTION' ? '/customer/transactions' : '/customer/fraud-alerts';
        const linkText = e.type === 'TRANSACTION' ? 'View in transaction history' : 'View in fraud alerts';
        return (
          <li key={e.id} className="relative">
            <span className={`absolute -left-[2.2rem] flex h-8 w-8 items-center justify-center rounded-full border ${t.ring}`}>
              <Icon name={t.icon} className="h-4 w-4" />
            </span>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{t.label}</p>
                <time dateTime={e.timestamp} className="text-xs text-gray-500">{formatDate(e.timestamp)} IST</time>
              </div>
              <p className="mt-1 text-sm font-semibold text-gray-900">{e.title}</p>
              {e.description && <p className="mt-0.5 text-sm text-gray-700">{e.description}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
                {e.riskLevel && <RiskBadge level={e.riskLevel} />}
                {e.status && <span>Status: <span className="font-medium">{statusText(e.status)}</span></span>}
                {e.amount != null && <span>{formatCurrency(e.amount)}</span>}
                {e.transactionId && <span>{e.transactionId}</span>}
                <Link to={linkTo} className="font-medium text-primary-700 underline">{linkText}</Link>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
