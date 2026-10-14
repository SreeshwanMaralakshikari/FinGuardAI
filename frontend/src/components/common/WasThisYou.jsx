/**
 * @file src/components/common/WasThisYou.jsx
 * @description Round 4: asks the customer about one of their HELD or BLOCKED payments — "Was this you?".
 *   The answer goes to the fraud team as evidence (POST /customer-api/transactions/:id/response); it does not
 *   release or block anything by itself, and the text says so. Shown until answered; afterwards (or when the
 *   transaction already carries an answer) it shows what the customer said.
 */
import { useState } from 'react';
import api from '../../api/axios.js';
import { getErrorMessage } from '../../api/errors.js';
import { API_PATHS } from '../../utils/constants.js';
import { BTN, formatDate } from '../../utils/common.js';
import Alert from './Alert.jsx';

const ASKABLE = ['HELD', 'BLOCKED'];

const ANSWERED_TEXT = {
  CONFIRMED: 'You told the fraud team that you made this payment.',
  DISPUTED: 'You told the fraud team that you did not make this payment.',
};

/** @param {{ transaction: { id?: string, _id?: string, status: string, customerResponse?: object|null } }} props */
export default function WasThisYou({ transaction }) {
  const [response, setResponse] = useState(transaction.customerResponse ?? null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = transaction.id ?? transaction._id;

  if (response?.answer) {
    return (
      <section className="rounded-xl border border-gray-200 bg-gray-50 p-4" aria-label="Your answer" data-testid="was-this-you">
        <p className="text-sm font-medium text-gray-900">{ANSWERED_TEXT[response.answer]}</p>
        {response.note && <p className="mt-1 text-sm text-gray-600">Your note: {response.note}</p>}
        {response.respondedAt && <p className="mt-1 text-xs text-gray-500">{formatDate(response.respondedAt)}</p>}
      </section>
    );
  }
  if (!ASKABLE.includes(transaction.status) || !id) return null;

  const answer = async (value) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`${API_PATHS.CUSTOMER.TRANSACTION_BY_ID}/${id}/${API_PATHS.CUSTOMER.RESPONSE_SUFFIX}`, {
        answer: value,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setResponse(res.data?.data?.customerResponse ?? { answer: value, note: note.trim() });
    } catch (err) {
      setError(getErrorMessage(err, 'Your answer could not be sent. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4" aria-labelledby="was-this-you-title" data-testid="was-this-you">
      <h2 id="was-this-you-title" className="font-display text-xl font-bold text-gray-900">Was this you?</h2>
      <p className="mt-1 text-sm text-gray-700">
        This payment was {transaction.status === 'BLOCKED' ? 'blocked' : 'held'} as possible fraud. Tell the fraud team whether
        you made it. Your answer helps the analyst decide; it does not release or block the payment by itself.
      </p>
      <label htmlFor="was-this-you-note" className="mt-3 block text-sm font-medium text-gray-700">Note for the fraud team (optional)</label>
      <input
        id="was-this-you-note"
        type="text"
        maxLength={300}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className="mt-1 block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
        placeholder="e.g. I bought a new phone yesterday"
      />
      <div className="mt-3"><Alert tone="error">{error}</Alert></div>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" disabled={busy} onClick={() => answer('CONFIRMED')} className={`${BTN.base} ${BTN.secondary} ${BTN.md}`}>
          Yes, I made this payment
        </button>
        <button type="button" disabled={busy} onClick={() => answer('DISPUTED')} className={`${BTN.base} ${BTN.danger} ${BTN.md}`}>
          No, I did not make it
        </button>
      </div>
    </section>
  );
}
