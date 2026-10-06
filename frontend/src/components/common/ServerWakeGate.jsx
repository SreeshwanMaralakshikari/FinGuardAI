/**
 * @file src/components/common/ServerWakeGate.jsx
 * @description Blocks rendering of <App /> until the backend answers GET /health.
 *
 *   Why: on the Render free tier the API sleeps after inactivity. App.jsx
 *   dispatches checkAuthThunk on mount; against a sleeping server that
 *   request would time out and a logged-in user would be treated as logged
 *   out. Gating App behind a health check means checkAuthThunk only runs
 *   once the server can answer.
 *
 *   States:
 *     checking → one quick probe; a warm server passes in well under a second.
 *                Nothing is drawn for the first 400 ms, so a warm server
 *                never flashes a spinner.
 *     waking   → friendly "starting up" screen with elapsed seconds
 *     ready    → render children
 *     failed   → message + Retry button (server still down after ~90 s)
 * @phase Phase 9 — Deployment
 */
import { useCallback, useEffect, useState } from 'react';
import { pingServer, waitForServer } from '../../api/serverHealth.js';
import { WAKE_GATE } from '../../utils/common.js';

const QUICK_PROBE_TIMEOUT_MS = 4_000;
const MAX_WAKE_WAIT_MS = 90_000;
const SPINNER_DELAY_MS = 400;

export default function ServerWakeGate({ children }) {
  const [status, setStatus] = useState('checking');
  const [elapsed, setElapsed] = useState(0);
  const [attemptKey, setAttemptKey] = useState(0);
  const [showSpinner, setShowSpinner] = useState(false);

  const retry = useCallback(() => {
    setShowSpinner(true);
    setElapsed(0);
    setStatus('checking');
    setAttemptKey((k) => k + 1);
  }, []);

  // Probe → wake loop. Re-runs when the user presses Retry.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (await pingServer(QUICK_PROBE_TIMEOUT_MS)) {
        if (!cancelled) setStatus('ready');
        return;
      }
      if (cancelled) return;
      setStatus('waking');

      const ready = await waitForServer({ maxWaitMs: MAX_WAKE_WAIT_MS });
      if (!cancelled) setStatus(ready ? 'ready' : 'failed');
    })();

    return () => {
      cancelled = true;
    };
  }, [attemptKey]);

  // Delay the 'checking' spinner so a warm server renders the app with no flash
  useEffect(() => {
    const timer = setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  // Elapsed-seconds counter while waking
  useEffect(() => {
    if (status !== 'waking') return undefined;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1_000);
    return () => clearInterval(timer);
  }, [status]);

  if (status === 'ready') return children;

  if (status === 'checking') {
    if (!showSpinner) return null;
    // Neutral loader — avoids flashing the "waking" copy on a warm server
    return (
      <div className={WAKE_GATE.screen} role="status" aria-live="polite">
        <div className={WAKE_GATE.spinner} aria-hidden="true" />
        <span className={WAKE_GATE.srOnly}>Connecting to FinGuardAI…</span>
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className={WAKE_GATE.screen}>
        <div className={WAKE_GATE.card} role="alert">
          <div className={WAKE_GATE.errorIcon} aria-hidden="true">!</div>
          <h1 className={WAKE_GATE.title}>We can’t reach the FinGuardAI server</h1>
          <p className={WAKE_GATE.text}>
            The server did not respond in time. It may be restarting or temporarily unavailable.
          </p>
          <button type="button" className={WAKE_GATE.button} onClick={retry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  // status === 'waking'
  return (
    <div className={WAKE_GATE.screen}>
      <div className={WAKE_GATE.card} role="status" aria-live="polite">
        <div className={WAKE_GATE.spinner} aria-hidden="true" />
        <h1 className={WAKE_GATE.title}>Starting the secure server…</h1>
        <p className={WAKE_GATE.text}>
          FinGuardAI’s API sleeps when it hasn’t been used for a while. Waking it up usually
          takes under a minute — this page will continue automatically.
        </p>
        <p className={WAKE_GATE.meta}>{elapsed}s elapsed</p>
      </div>
    </div>
  );
}
