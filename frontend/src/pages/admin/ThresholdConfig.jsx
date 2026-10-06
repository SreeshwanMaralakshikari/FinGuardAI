/**
 * @file src/pages/admin/ThresholdConfig.jsx
 * @description Fraud-engine thresholds (local state + api, C-P7-04). GET/PATCH /admin-api/thresholds.
 *   Fields (Phase 3/4/5 SystemConfig): amountThreshold; velocityLimit.maxPerHour / maxPerDay;
 *   scoreThresholds.mediumMin / highMin / criticalMin; newDeviceWeight (0–100);
 *   locationDeviationKm (stored, not yet used by the rule engine); highRiskMerchants (list,
 *   saved upper-case). Client rules mirror the server: ordering mediumMin < highMin < criticalMin
 *   (N-03), maxPerHour ≤ maxPerDay. A 404 means the config was never seeded — the form then starts
 *   from the engine defaults and saving creates it.
 *   FieldRow resolves nested RHF errors via getNestedError (C-P7-06).
 *   N-04: if loading fails with anything but 404 the page shows ONLY the error and a Retry button —
 *   no form, no Save, so the engine defaults can never be saved over the real settings.
 *   N-13: field rules are identical to the server's: mediumMin 1–98, highMin 2–99, criticalMin 3–100
 *   (integers, ascending), maxPerHour / maxPerDay integers ≥ 1 with maxPerDay ≥ maxPerHour,
 *   newDeviceWeight integer 0–100, amountThreshold 0–1e9, at most 50 merchant categories of ≤ 50 characters.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import api from '../../api/axios.js';
import { getErrorMessage } from '../../api/errors.js';
import { API_PATHS } from '../../utils/constants.js';
import { BTN, CARD } from '../../utils/common.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import FormField from '../../components/common/FormField.jsx';
import Alert from '../../components/common/Alert.jsx';
import LoadError from '../../components/common/LoadError.jsx';

const DEFAULTS = {
  amountThreshold: 50000,
  velocityLimit: { maxPerHour: 5, maxPerDay: 20 },
  scoreThresholds: { mediumMin: 25, highMin: 50, criticalMin: 75 },
  locationDeviationKm: 500,
  newDeviceWeight: 20,
  highRiskMerchants: ['CASINO', 'GAMBLING', 'CRYPTO_EXCHANGE', 'ADULT', 'OFFSHORE_BETTING'],
};

const toFormValues = (cfg) => ({
  amountThreshold: cfg.amountThreshold,
  velocityLimit: { maxPerHour: cfg.velocityLimit?.maxPerHour, maxPerDay: cfg.velocityLimit?.maxPerDay },
  scoreThresholds: {
    mediumMin: cfg.scoreThresholds?.mediumMin,
    highMin: cfg.scoreThresholds?.highMin,
    criticalMin: cfg.scoreThresholds?.criticalMin,
  },
  locationDeviationKm: cfg.locationDeviationKm,
  newDeviceWeight: cfg.newDeviceWeight,
  highRiskMerchants: (cfg.highRiskMerchants ?? []).join(', '),
});

const parseMerchants = (text) => [...new Set(
  text.split(/[,\n]/)
    // same key the server stores (utils/normalize.js): upper-case, spaces → "_", everything but A–Z 0–9 _ dropped
    .map((s) => s.trim().toUpperCase().replaceAll(' ', '_').replace(/[^A-Z0-9_]/g, ''))
    .filter(Boolean),
)];

const num = { valueAsNumber: true };
const isInt = (x) => Number.isInteger(x) || 'Whole number required';
const MAX_MERCHANTS = 50;
const MAX_MERCHANT_LEN = 50;

export default function ThresholdConfig() {
  const [state, setState] = useState({ loading: true, error: '', unseeded: false });
  const [saveError, setSaveError] = useState('');
  const [attempt, setAttempt] = useState(0); // Retry re-runs the load effect
  const {
    register, handleSubmit, reset, getValues, formState: { errors, isSubmitting },
  } = useForm({ defaultValues: toFormValues(DEFAULTS) });

  useEffect(() => {
    let active = true;
    api.get(API_PATHS.ADMIN.THRESHOLDS)
      .then((res) => {
        if (!active) return;
        reset(toFormValues(res.data.data));
        setState({ loading: false, error: '', unseeded: false });
      })
      .catch((err) => {
        if (!active) return;
        if (err?.response?.status === 404) setState({ loading: false, error: '', unseeded: true });
        else setState({ loading: false, error: getErrorMessage(err, 'Could not load thresholds'), unseeded: false });
      });
    return () => { active = false; };
  }, [reset, attempt]);

  const retry = () => {
    setState({ loading: true, error: '', unseeded: false });
    setAttempt((n) => n + 1);
  };

  const onSubmit = async (v) => {
    setSaveError('');
    const payload = {
      amountThreshold: v.amountThreshold,
      velocityLimit: { maxPerHour: v.velocityLimit.maxPerHour, maxPerDay: v.velocityLimit.maxPerDay },
      scoreThresholds: { mediumMin: v.scoreThresholds.mediumMin, highMin: v.scoreThresholds.highMin, criticalMin: v.scoreThresholds.criticalMin },
      locationDeviationKm: v.locationDeviationKm,
      newDeviceWeight: v.newDeviceWeight,
      highRiskMerchants: parseMerchants(v.highRiskMerchants),
    };
    try {
      const res = await api.patch(API_PATHS.ADMIN.THRESHOLDS, payload);
      if (res?.data?.data) reset(toFormValues(res.data.data));
      setState((s) => ({ ...s, unseeded: false }));
      toast.success('Thresholds saved');
    } catch (err) {
      setSaveError(getErrorMessage(err, 'Could not save thresholds'));
    }
  };

  if (state.loading) return <Spinner />;

  if (state.error) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Fraud thresholds" subtitle="Tune how aggressively the engine flags transactions. Changes apply to new transactions immediately." />
        <LoadError message={state.error} onRetry={retry} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title="Fraud thresholds" subtitle="Tune how aggressively the engine flags transactions. Changes apply to new transactions immediately." />

      <div className="mb-4 space-y-2">
        <Alert tone="warning">{state.unseeded ? 'The system configuration has not been created yet. Saving will create it with the values below.' : ''}</Alert>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
        <Alert tone="error">{saveError}</Alert>

        <section className={`${CARD.base} ${CARD.body}`} aria-labelledby="th-amount">
          <h2 id="th-amount" className="mb-4 text-base font-semibold text-gray-900">Amount &amp; device</h2>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            <FormField name="amountThreshold" label="High-value amount (₹)" errors={errors}
              render={(p) => <input {...p} type="number" step="any" {...register('amountThreshold', { ...num, required: 'Required', min: { value: 0, message: 'Must be 0 or more' }, max: { value: 1e9, message: 'Cannot exceed 1,000,000,000' } })} />} />
            <FormField name="newDeviceWeight" label="New-device penalty (0–100)" errors={errors}
              render={(p) => <input {...p} type="number" step={1} {...register('newDeviceWeight', { ...num, required: 'Required', min: { value: 0, message: 'Must be 0 or more' }, max: { value: 100, message: 'Cannot exceed 100' }, validate: isInt })} />} />
            <FormField name="locationDeviationKm" label="Location deviation (km)" errors={errors} hint="Stored for later; the engine compares city names today."
              render={(p) => <input {...p} type="number" step="any" {...register('locationDeviationKm', { ...num, required: 'Required', min: { value: 0, message: 'Must be 0 or more' }, max: { value: 1_000_000, message: 'Cannot exceed 1,000,000' } })} />} />
          </div>
        </section>

        <section className={`${CARD.base} ${CARD.body}`} aria-labelledby="th-velocity">
          <h2 id="th-velocity" className="mb-4 text-base font-semibold text-gray-900">Velocity limits</h2>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <FormField name="velocityLimit.maxPerHour" label="Max transactions per hour" errors={errors}
              render={(p) => (
                <input {...p} type="number" step={1} {...register('velocityLimit.maxPerHour', {
                  ...num, required: 'Required', min: { value: 1, message: 'Must be at least 1' }, max: { value: 100_000, message: 'Cannot exceed 100,000' },
                  validate: isInt,
                  deps: ['velocityLimit.maxPerDay'],
                })} />
              )} />
            <FormField name="velocityLimit.maxPerDay" label="Max transactions per day" errors={errors}
              render={(p) => (
                <input {...p} type="number" step={1} {...register('velocityLimit.maxPerDay', {
                  ...num, required: 'Required', min: { value: 1, message: 'Must be at least 1' }, max: { value: 100_000, message: 'Cannot exceed 100,000' },
                  validate: {
                    integer: isInt,
                    order: (x) => !(x < getValues('velocityLimit.maxPerHour')) || 'Must not be less than the hourly limit',
                  },
                })} />
              )} />
          </div>
        </section>

        <section className={`${CARD.base} ${CARD.body}`} aria-labelledby="th-score">
          <h2 id="th-score" className="text-base font-semibold text-gray-900">Risk bands (fraud score 0–100)</h2>
          <p className="mb-4 mt-1 text-sm text-gray-500">Score thresholds must be in ascending order: medium &lt; high &lt; critical.</p>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            <FormField name="scoreThresholds.mediumMin" label="MEDIUM from" errors={errors}
              render={(p) => (
                <input {...p} type="number" step={1} {...register('scoreThresholds.mediumMin', {
                  ...num, required: 'Required',
                  min: { value: 1, message: 'Must be at least 1' }, max: { value: 98, message: 'Cannot exceed 98' },
                  validate: {
                    integer: isInt,
                    order: (x) => x < getValues('scoreThresholds.highMin') || 'Medium minimum must be less than the high minimum',
                  },
                  deps: ['scoreThresholds.highMin'],
                })} />
              )} />
            <FormField name="scoreThresholds.highMin" label="HIGH from" errors={errors}
              render={(p) => (
                <input {...p} type="number" step={1} {...register('scoreThresholds.highMin', {
                  ...num, required: 'Required',
                  min: { value: 2, message: 'Must be at least 2' }, max: { value: 99, message: 'Cannot exceed 99' },
                  validate: {
                    integer: isInt,
                    order: (x) => x < getValues('scoreThresholds.criticalMin') || 'High minimum must be less than the critical minimum',
                  },
                  deps: ['scoreThresholds.criticalMin'],
                })} />
              )} />
            <FormField name="scoreThresholds.criticalMin" label="CRITICAL from" errors={errors}
              render={(p) => (
                <input {...p} type="number" step={1} {...register('scoreThresholds.criticalMin', {
                  ...num, required: 'Required',
                  min: { value: 3, message: 'Must be at least 3' }, max: { value: 100, message: 'Cannot exceed 100' },
                  validate: isInt,
                })} />
              )} />
          </div>
        </section>

        <section className={`${CARD.base} ${CARD.body}`} aria-labelledby="th-merch">
          <h2 id="th-merch" className="mb-4 text-base font-semibold text-gray-900">High-risk merchant categories</h2>
          <FormField name="highRiskMerchants" label="Categories (comma separated)" errors={errors} hint="Saved in upper case, e.g. CASINO, CRYPTO_EXCHANGE."
            render={(p) => (
              <textarea {...p} rows={3} {...register('highRiskMerchants', {
                validate: (text) => {
                  const list = parseMerchants(text);
                  if (list.length > MAX_MERCHANTS) return `At most ${MAX_MERCHANTS} categories`;
                  if (list.some((m) => m.length > MAX_MERCHANT_LEN)) return `Each category must be ${MAX_MERCHANT_LEN} characters or fewer`;
                  return true;
                },
              })} />
            )} />
        </section>

        <button type="submit" disabled={isSubmitting} className={`${BTN.base} ${BTN.primary} ${BTN.lg}`}>
          {isSubmitting ? 'Saving…' : 'Save thresholds'}
        </button>
      </form>
    </div>
  );
}
