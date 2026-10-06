/**
 * @file src/pages/customer/SubmitTransaction.jsx
 * @description Submit a payment for real-time fraud scoring (react-hook-form v7).
 *   API contract (verified): amount > 0, merchantName, paymentMethod and deviceId are REQUIRED;
 *   merchantCategory / location.city / location.country are optional but must not be empty
 *   strings → blanks are stripped before sending. The result is FLAT (C-P6-33).
 *   The deviceId defaults to a stable per-browser id (utils/device.js); change it to
 *   simulate a different device.
 *   N-18: the API accepts ANY merchantCategory string (no enum), and admins can add categories on
 *   the Thresholds page, so the field is free text with a suggestion list (datalist) instead of
 *   a closed <select>. City is trimmed and sent as typed (the backend normalises its case).
 */
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { useAppDispatch } from '../../store/hooks.js';
import { submitTransactionThunk } from '../../store/slices/transactionSlice.js';
import { BTN, CARD, formatCurrency, formatDate } from '../../utils/common.js';
import { PAYMENT_METHODS } from '../../utils/constants.js';
import { getDeviceId } from '../../utils/device.js';
import { stripBlank } from '../../utils/forms.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import FormField from '../../components/common/FormField.jsx';
import Alert from '../../components/common/Alert.jsx';
import DetailRow from '../../components/common/DetailRow.jsx';
import ScoreBar from '../../components/common/ScoreBar.jsx';
import { RiskBadge, TxStatusBadge } from '../../components/common/Badges.jsx';

// Suggestions only — any category may be typed (N-18)
const CATEGORIES = [
  'GENERAL', 'RETAIL', 'GROCERY', 'FOOD', 'TRAVEL', 'UTILITIES', 'ELECTRONICS',
  'CASINO', 'GAMBLING', 'CRYPTO_EXCHANGE', 'ADULT', 'OFFSHORE_BETTING',
];

const ACTION_TEXT = {
  APPROVE: 'Approved — no unusual signals.',
  OTP:     'Approved with extra verification recommended.',
  HOLD:    'Held for review by a fraud analyst.',
  BLOCK:   'Blocked — too risky to process.',
};

export default function SubmitTransaction() {
  const dispatch = useAppDispatch();
  const deviceId = useMemo(() => getDeviceId(), []);
  const [result, setResult] = useState(null);
  const [serverError, setServerError] = useState('');
  const {
    register, handleSubmit, reset, formState: { errors, isSubmitting },
  } = useForm({
    defaultValues: {
      amount: '', merchantName: '', merchantCategory: '', paymentMethod: 'UPI',
      deviceId, city: '', country: '',
    },
  });

  const onSubmit = async (values) => {
    setServerError('');
    const payload = stripBlank({
      amount: values.amount,
      merchantName: values.merchantName,
      merchantCategory: values.merchantCategory,
      paymentMethod: values.paymentMethod,
      deviceId: values.deviceId,
      location: { city: values.city, country: values.country },
    });
    const action = await dispatch(submitTransactionThunk(payload));
    if (submitTransactionThunk.fulfilled.match(action)) {
      setResult(action.payload); // FLAT — no .transaction sub-key (C-P6-33)
    } else {
      setServerError(action.payload ?? 'Transaction submission failed');
    }
  };

  const another = () => {
    setResult(null);
    reset({ amount: '', merchantName: '', merchantCategory: '', paymentMethod: 'UPI', deviceId, city: '', country: '' });
  };

  if (result) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Transaction result" subtitle={ACTION_TEXT[result.recommendedAction] ?? ''} />
        <section className={`${CARD.base} ${CARD.body} space-y-6`} aria-label="Fraud analysis result">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <DetailRow label="Transaction ID">{result.publicId}</DetailRow>
            <DetailRow label="Amount">{formatCurrency(result.amount)}</DetailRow>
            <DetailRow label="Status"><TxStatusBadge status={result.status} /></DetailRow>
            <DetailRow label="Risk"><RiskBadge level={result.riskLevel} /></DetailRow>
            <DetailRow label="Merchant">{result.merchantName}</DetailRow>
            <DetailRow label="Recommended action">{result.recommendedAction}</DetailRow>
            <DetailRow label="Estimated loss at risk">{formatCurrency(result.estimatedLoss)}</DetailRow>
            <DetailRow label="Time">{formatDate(result.timestamp)}</DetailRow>
          </dl>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Fraud score</p>
            <ScoreBar value={result.fraudScore} label="Fraud score" />
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Signals</p>
            {result.reasons?.length ? (
              <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">{result.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            ) : <p className="text-sm text-gray-500">No risk signals were triggered.</p>}
          </div>
          {result.fraudAlert && (
            <Alert tone="warning">
              An alert was created for this payment.{' '}
              <Link to="/customer/fraud-alerts" className="font-medium underline">View fraud alerts</Link>
            </Alert>
          )}
          <div className="flex gap-3">
            <button type="button" className={`${BTN.base} ${BTN.primary} ${BTN.md}`} onClick={another}>Submit another</button>
            <Link to="/customer/transactions" className={`${BTN.base} ${BTN.secondary} ${BTN.md}`}>View history</Link>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title="Submit a transaction" subtitle="Your payment is scored for fraud risk the moment you submit it." />
      <form onSubmit={handleSubmit(onSubmit)} noValidate className={`${CARD.base} ${CARD.body} space-y-5`}>
        <Alert tone="error">{serverError}</Alert>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <FormField
            name="amount"
            label="Amount (₹)"
            errors={errors}
            render={(p) => (
              <input
                {...p}
                type="number"
                step="0.01"
                inputMode="decimal"
                placeholder="0.00"
                {...register('amount', {
                  required: 'Amount is required',
                  valueAsNumber: true,
                  validate: (v) => (Number.isFinite(v) && v > 0) || 'Amount must be greater than 0',
                  max: { value: 1_000_000_000, message: 'Amount cannot exceed ₹100 crore' },
                })}
              />
            )}
          />
          <FormField
            name="paymentMethod"
            label="Payment method"
            errors={errors}
            render={(p) => (
              <select {...p} {...register('paymentMethod', { required: 'Choose a payment method' })}>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
              </select>
            )}
          />
          <FormField
            name="merchantName"
            label="Merchant name"
            errors={errors}
            render={(p) => (
              <input
                {...p}
                type="text"
                {...register('merchantName', {
                  required: 'Merchant name is required',
                  maxLength: { value: 200, message: 'Merchant name cannot exceed 200 characters' },
                  validate: (v) => v.trim().length > 0 || 'Merchant name is required',
                })}
              />
            )}
          />
          <FormField
            name="merchantCategory"
            label="Merchant category (optional)"
            errors={errors}
            hint="Pick a suggestion or type your own, e.g. CASINO or ELECTRONICS."
            render={(p) => (
              <>
                <input
                  {...p}
                  type="text"
                  list="merchant-category-options"
                  autoComplete="off"
                  placeholder="GENERAL"
                  {...register('merchantCategory', { maxLength: { value: 50, message: 'Category cannot exceed 50 characters' } })}
                />
                <datalist id="merchant-category-options">
                  {CATEGORIES.map((c) => <option key={c} value={c} label={c.replaceAll('_', ' ')} />)}
                </datalist>
              </>
            )}
          />
          <FormField
            name="city"
            label="City (optional)"
            errors={errors}
            render={(p) => <input {...p} type="text" placeholder="e.g. Mumbai" {...register('city', { maxLength: { value: 100, message: 'City is too long' } })} />}
          />
          <FormField
            name="country"
            label="Country (optional)"
            errors={errors}
            render={(p) => <input {...p} type="text" placeholder="e.g. India" {...register('country', { maxLength: { value: 100, message: 'Country is too long' } })} />}
          />
        </div>

        <FormField
          name="deviceId"
          label="Device ID"
          errors={errors}
          hint="Identifies this browser. Change it to see how a new, unrecognised device is scored."
          render={(p) => (
            <input
              {...p}
              type="text"
              {...register('deviceId', {
                required: 'Device ID is required',
                maxLength: { value: 128, message: 'Device ID cannot exceed 128 characters' },
                validate: (v) => v.trim().length > 0 || 'Device ID is required',
              })}
            />
          )}
        />

        <button type="submit" disabled={isSubmitting} className={`${BTN.base} ${BTN.primary} ${BTN.lg}`}>
          {isSubmitting ? 'Analysing…' : 'Submit for fraud check'}
        </button>
      </form>
    </div>
  );
}
