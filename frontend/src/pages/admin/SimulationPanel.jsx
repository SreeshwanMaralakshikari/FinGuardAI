/**
 * @file src/pages/admin/SimulationPanel.jsx
 * @description Start / stop the live-monitoring simulation session (startSimulationThunk /
 *   stopSimulationThunk; state is updated by the server's `simulation_start` / `simulation_stop`
 *   socket events via useSocket in AdminLayout).
 *   API facts: transactionCount is an integer 1–100 (default 10) and must be omitted when
 *   blank; there is no risk-bias option and no status endpoint — the "running" flag lives in
 *   the browser and is lost on reload. Start / Stop only broadcasts the signal: it does not
 *   generate transactions, so the feed shows REAL alerts that arrive while the session runs.
 *   A-08 "Demo data": POST /admin-api/simulation/generate {count 1-100} creates simulated customers and
 *   transactions that go through the real fraud engine (marked isSimulated, removable); DELETE
 *   /admin-api/simulation/data removes all of it. Errors: 400 (cap / count), 429 (10 per hour), 409 (clash).
 *   After either call the analytics state is refreshed.
 */
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import {
  SIM_NO_ANSWER_MESSAGE, SIM_CLEAR_NO_ANSWER_MESSAGE, startSimulationThunk, stopSimulationThunk, clearSimulationEvents, generateSimulationThunk, clearSimulationDataThunk,
} from '../../store/slices/simulationSlice.js';
import { fetchAnalyticsThunk } from '../../store/slices/analyticsSlice.js';
import { BTN, CARD, INPUT, formatCurrency, formatDate } from '../../utils/common.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import FormField from '../../components/common/FormField.jsx';
import Modal from '../../components/common/Modal.jsx';
import Alert from '../../components/common/Alert.jsx';
import { RiskBadge } from '../../components/common/Badges.jsx';

const DEFAULT_DEMO_COUNT = 30;
const MAX_PER_CLICK = 50; // the API allows 100; 50 keeps one request well inside the timeout
const RISKS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const CLEARED_LABELS = [
  ['users', 'users'], ['transactions', 'transactions'], ['fraudAlerts', 'alerts'], ['cases', 'cases'],
  ['notifications', 'notifications'], ['deviceReputations', 'device records'], ['behaviorProfiles', 'behaviour profiles'],
];

export default function SimulationPanel() {
  const dispatch = useAppDispatch();
  const { isRunning, events, stats } = useAppSelector((s) => s.simulation);
  const [serverError, setServerError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [demoCount, setDemoCount] = useState(String(DEFAULT_DEMO_COUNT));
  const [generating, setGenerating] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [demoError, setDemoError] = useState('');
  const [demoResult, setDemoResult] = useState(null); // { kind: 'generated'|'cleared', data }
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ defaultValues: { transactionCount: '' } });

  const onStart = async ({ transactionCount }) => {
    setServerError('');
    const payload = transactionCount === '' || transactionCount == null ? {} : { transactionCount: Number(transactionCount) };
    const action = await dispatch(startSimulationThunk(payload));
    if (startSimulationThunk.fulfilled.match(action)) toast.success('Simulation started');
    else setServerError(action.payload ?? 'Could not start the simulation');
  };

  const onStop = async () => {
    setServerError('');
    setStopping(true);
    const action = await dispatch(stopSimulationThunk());
    setStopping(false);
    if (stopSimulationThunk.fulfilled.match(action)) toast.success('Simulation stopped');
    else setServerError(action.payload ?? 'Could not stop the simulation');
  };

  const countNumber = Number(demoCount);
  const countValid = demoCount.trim() !== '' && Number.isInteger(countNumber) && countNumber >= 1 && countNumber <= MAX_PER_CLICK;

  const onGenerate = async (e) => {
    e.preventDefault();
    if (!countValid) { setDemoError(`Enter a whole number from 1 to ${MAX_PER_CLICK} (at most ${MAX_PER_CLICK} per click)`); return; }
    setDemoError('');
    setDemoResult(null);
    setGenerating(true);
    const action = await dispatch(generateSimulationThunk(countNumber));
    setGenerating(false);
    if (generateSimulationThunk.fulfilled.match(action)) {
      setDemoResult({ kind: 'generated', data: action.payload });
      toast.success(`Generated ${action.payload?.generated ?? countNumber} demo transactions`);
      dispatch(fetchAnalyticsThunk());
    } else {
      setDemoError(action.payload ?? 'Could not generate demo data');
      if (action.payload === SIM_NO_ANSWER_MESSAGE) dispatch(fetchAnalyticsThunk()); // it may have finished anyway
    }
  };

  const onClearDemo = async () => {
    setDemoError('');
    setDemoResult(null);
    setClearing(true);
    const action = await dispatch(clearSimulationDataThunk());
    setClearing(false);
    setConfirmClear(false);
    if (clearSimulationDataThunk.fulfilled.match(action)) {
      setDemoResult({ kind: 'cleared', data: action.payload });
      toast.success('Demo data cleared');
      dispatch(fetchAnalyticsThunk());
    } else {
      setDemoError(action.payload ?? 'Could not clear demo data');
      if (action.payload === SIM_CLEAR_NO_ANSWER_MESSAGE) dispatch(fetchAnalyticsThunk());
    }
  };

  return (
    <div className="max-w-3xl">
      <PageHeader title="Fraud simulation" subtitle="Create demo transactions, or run a live-monitoring session and watch alerts arrive in real time." />

      <section className={`${CARD.base} ${CARD.body} space-y-5`} aria-label="Simulation controls">
        <div className="flex items-center gap-3">
          <span className={`h-3 w-3 rounded-full ${isRunning ? 'bg-emerald-500' : 'bg-gray-300'}`} aria-hidden="true" />
          <p className="text-sm font-medium text-gray-900">{isRunning ? 'Simulation running' : 'Simulation idle'}</p>
          {isRunning && stats?.transactionCount && <span className="text-xs text-gray-500">target: {stats.transactionCount} transactions</span>}
        </div>

        <Alert tone="info">
          Start / Stop only broadcasts a signal to all admins; it does not create transactions. Alerts below are real
          ones raised while the session is running (for example, when a customer submits a risky payment).
          To create sample transactions, use “Demo data” further down.
        </Alert>
        <Alert tone="error">{serverError}</Alert>

        <form onSubmit={handleSubmit(onStart)} noValidate className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="sm:w-64">
            <FormField
              name="transactionCount"
              label="Transaction count (optional)"
              errors={errors}
              hint="1–100. Leave blank for the default (10)."
              render={(p) => (
                <input
                  {...p}
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  {...register('transactionCount', {
                    validate: (v) => v === '' || v == null || (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 100) || 'Enter a whole number from 1 to 100',
                  })}
                />
              )}
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={isSubmitting || isRunning} className={`${BTN.base} ${BTN.primary} ${BTN.md}`}>{isSubmitting ? 'Starting…' : 'Start'}</button>
            <button type="button" disabled={stopping} className={`${BTN.base} ${BTN.danger} ${BTN.md}`} onClick={onStop}>Stop</button>
          </div>
        </form>
      </section>

      <section className={`${CARD.base} ${CARD.body} mt-6 space-y-4`} aria-labelledby="sim-demo">
        <div>
          <h2 id="sim-demo" className="text-base font-semibold text-gray-900">Demo data</h2>
          <p className="mt-1 text-sm text-gray-600">
            Creates simulated customers and payments that run through the real fraud engine, so charts, alerts and cases
            have something to show. They are real records in this database, tagged “Simulated”, and can be cleared again.
            Limits: 50 per click, 10 requests per hour, and a cap on the total number of simulated payments.
          </p>
        </div>
        <Alert tone="error">{demoError}</Alert>
        <form onSubmit={onGenerate} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:w-48">
            <label htmlFor="demo-count" className={INPUT.label}>Transactions to generate</label>
            <input id="demo-count" type="number" min={1} max={MAX_PER_CLICK} step={1} className={INPUT.base} value={demoCount} onChange={(e) => setDemoCount(e.target.value)} disabled={generating || clearing} />
          </div>
          <button type="submit" disabled={generating || clearing} className={`${BTN.base} ${BTN.primary} ${BTN.md}`}>
            {generating ? 'Generating…' : 'Generate demo transactions'}
          </button>
          <button type="button" disabled={generating || clearing} className={`${BTN.base} ${BTN.danger} ${BTN.md}`} onClick={() => { setDemoError(''); setConfirmClear(true); }}>
            Clear demo data
          </button>
        </form>
        {generating && <p className="text-sm text-gray-600" role="status">Running {countNumber} payments through the fraud engine. This can take up to a minute. Keep this page open.</p>}
        {demoResult?.kind === 'generated' && (
          <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800" role="status">
            <p className="font-medium">Generated {demoResult.data.generated} simulated transactions ({demoResult.data.simulatedTransactionsTotal} simulated in total).</p>
            <p className="mt-1">By risk: {RISKS.map((r) => `${r} ${demoResult.data.byRiskLevel?.[r] ?? 0}`).join(', ')}.</p>
            <p>By status: {['APPROVED', 'HELD', 'BLOCKED'].map((st) => `${st} ${demoResult.data.byStatus?.[st] ?? 0}`).join(', ')}.</p>
          </div>
        )}
        {demoResult?.kind === 'cleared' && (
          <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800" role="status">
            <p className="font-medium">Demo data cleared.</p>
            <p className="mt-1">Removed: {CLEARED_LABELS.map(([k, label]) => `${demoResult.data[k] ?? 0} ${label}`).join(', ')}.</p>
          </div>
        )}
      </section>

      <Modal
        open={confirmClear}
        title="Clear demo data"
        onClose={() => setConfirmClear(false)}
        dismissible={!clearing}
        footer={(
          <>
            <button type="button" disabled={clearing} className={`${BTN.base} ${BTN.secondary} ${BTN.md}`} onClick={() => setConfirmClear(false)}>Cancel</button>
            <button type="button" disabled={clearing} className={`${BTN.base} ${BTN.danger} ${BTN.md}`} onClick={onClearDemo}>
              {clearing ? 'Clearing…' : 'Delete demo data'}
            </button>
          </>
        )}
      >
        <p className="text-sm text-gray-700">
          This permanently deletes all simulated users and their transactions, alerts, cases, notifications and device records.
          Real accounts and data are not touched. This cannot be undone.
        </p>
      </Modal>

      <section className={`${CARD.base} mt-6`} aria-labelledby="sim-events">
        <div className={`${CARD.header} flex items-center justify-between`}>
          <h2 id="sim-events" className="text-base font-semibold text-gray-900">Live events ({events.length})</h2>
          <button type="button" className={`${BTN.base} ${BTN.ghost} ${BTN.sm}`} disabled={events.length === 0} onClick={() => dispatch(clearSimulationEvents())}>Clear</button>
        </div>
        {events.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-gray-500">{isRunning ? 'Waiting for alerts…' : 'Start a session to see events.'}</p>
        ) : (
          <ul className="max-h-96 divide-y divide-gray-100 overflow-y-auto">
            {[...events].reverse().map((e, i) => (
              <li key={`${e.transactionId ?? e.timestamp}-${i}`} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm">
                <span className="font-medium text-gray-900">{e.merchantName ?? 'Event'} <span className="font-normal text-gray-500">{e.publicId}</span></span>
                <span>{formatCurrency(e.amount)}</span>
                <RiskBadge level={e.riskLevel} />
                <span className="text-xs text-gray-500">{formatDate(e.timestamp)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
