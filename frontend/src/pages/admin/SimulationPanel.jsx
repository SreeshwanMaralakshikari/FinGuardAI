/**
 * @file src/pages/admin/SimulationPanel.jsx
 * @description Start / stop the live-monitoring simulation session (startSimulationThunk /
 *   stopSimulationThunk; state is updated by the server's `simulation_start` / `simulation_stop`
 *   socket events via useSocket in AdminLayout).
 *   API facts: transactionCount is an integer 1–100 (default 10) and must be omitted when
 *   blank; there is no risk-bias option and no status endpoint — the "running" flag lives in
 *   the browser and is lost on reload. The backend broadcasts the signal only: it does not
 *   generate transactions, so the feed shows REAL alerts that arrive while the session runs.
 */
import { useForm } from 'react-hook-form';
import toast from 'react-hot-toast';
import { useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { startSimulationThunk, stopSimulationThunk, clearSimulationEvents } from '../../store/slices/simulationSlice.js';
import { BTN, CARD, formatCurrency, formatDate } from '../../utils/common.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import FormField from '../../components/common/FormField.jsx';
import Alert from '../../components/common/Alert.jsx';
import { RiskBadge } from '../../components/common/Badges.jsx';

export default function SimulationPanel() {
  const dispatch = useAppDispatch();
  const { isRunning, events, stats } = useAppSelector((s) => s.simulation);
  const [serverError, setServerError] = useState('');
  const [stopping, setStopping] = useState(false);
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

  return (
    <div className="max-w-3xl">
      <PageHeader title="Fraud simulation" subtitle="Run a live-monitoring session and watch alerts arrive in real time." />

      <section className={`${CARD.base} ${CARD.body} space-y-5`} aria-label="Simulation controls">
        <div className="flex items-center gap-3">
          <span className={`h-3 w-3 rounded-full ${isRunning ? 'bg-emerald-500' : 'bg-gray-300'}`} aria-hidden="true" />
          <p className="text-sm font-medium text-gray-900">{isRunning ? 'Simulation running' : 'Simulation idle'}</p>
          {isRunning && stats?.transactionCount && <span className="text-xs text-gray-500">target: {stats.transactionCount} transactions</span>}
        </div>

        <Alert tone="info">
          The server broadcasts the start/stop signal to all admins. It does not create transactions itself — alerts below
          are real ones raised while the session is running (for example, when a customer submits a risky payment).
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
