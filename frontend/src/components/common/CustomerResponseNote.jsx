/**
 * @file src/components/common/CustomerResponseNote.jsx
 * @description Round 4: for analysts — what the customer answered to "Was this you?" on a flagged payment.
 *   Renders nothing when the customer has not answered.
 */
import { formatDate } from '../../utils/common.js';

const TEXT = {
  CONFIRMED: { title: 'Customer says: "Yes, I made this payment"', tone: 'border-emerald-300 bg-emerald-50 text-emerald-900' },
  DISPUTED: { title: 'Customer says: "No, I did not make it"', tone: 'border-red-300 bg-red-50 text-red-900' },
};

/** @param {{ response?: { answer: string, note?: string, respondedAt?: string }|null }} props */
export default function CustomerResponseNote({ response }) {
  const t = response?.answer ? TEXT[response.answer] : null;
  if (!t) return null;
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${t.tone}`} data-testid="customer-response">
      <p className="font-semibold">{t.title}</p>
      {response.note && <p className="mt-1">Note: {response.note}</p>}
      {response.respondedAt && <p className="mt-1 text-xs opacity-80">Answered {formatDate(response.respondedAt)}</p>}
    </div>
  );
}
