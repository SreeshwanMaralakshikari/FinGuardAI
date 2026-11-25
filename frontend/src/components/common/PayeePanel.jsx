/**
 * @file src/components/common/PayeePanel.jsx
 * @description TEJAS D1: for analysts — who received the money and what was known about that payee when the
 *   payment was made (stored `payeeSignals`, earlier payments only). Links to the payee profile.
 *   Payments made before payee tracking have no `payee`: the merchant is shown with a short note.
 *   Step 1 is "shadow mode": these signals are shown but did not change the fraud score.
 */
import { Link } from 'react-router-dom';
import { formatCurrency } from '../../utils/common.js';
import { payeeChips, payeeLabel, payeeProfilePath } from '../../utils/payee.js';

const CHIP = {
  warn: 'border-amber-300 bg-amber-50 text-amber-900',
  danger: 'border-red-300 bg-red-50 text-red-800',
  neutral: 'border-gray-300 bg-gray-50 text-gray-700',
};

/** @param {{ transaction: object }} props  a transaction as the analyst API returns it */
export default function PayeePanel({ transaction }) {
  const t = transaction;
  if (!t) return null;
  const s = t.payeeSignals;
  const label = payeeLabel(t);
  return (
    <section aria-label="Payee" data-testid="payee-panel">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Payee (who received the money)</p>
      <p className="text-sm text-gray-800">
        {t.payee?.key
          ? <Link className="font-medium text-primary-600 hover:underline" to={payeeProfilePath(t.payee.key)}>{label}</Link>
          : <span className="font-medium">{label}</span>}
        {t.payee?.vpa ? <span className="ml-1 text-gray-500">(UPI ID)</span> : <span className="ml-1 text-gray-500">(merchant)</span>}
      </p>
      {s ? (
        <>
          <ul className="mt-2 flex flex-wrap gap-2" aria-label="Payee signals">
            {payeeChips(s).map((c) => (
              <li key={c.text} className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${CHIP[c.tone]}`}>{c.text}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-500">
            Before this payment: {s.sendersLast24h} customer{s.sendersLast24h === 1 ? '' : 's'} paid this payee
            {' '}{formatCurrency(s.inflowLast24h)} in the last 24 hours. Shown for investigation; not part of the score yet.
          </p>
        </>
      ) : (
        <p className="mt-1 text-xs text-gray-500">No payee details: this payment was made before payee tracking started.</p>
      )}
    </section>
  );
}
