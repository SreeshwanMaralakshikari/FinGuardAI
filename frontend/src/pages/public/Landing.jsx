/**
 * @file src/pages/public/Landing.jsx
 * @description Round 4 (R4-02): the public home page at "/".
 *   Rendered OUTSIDE the server wake gate (main.jsx), so it appears at once even while the free Render
 *   backend is asleep. While the visitor reads, it pings GET /health in the background (one shared polling
 *   loop, api/serverHealth.waitForServer); the backend wakes the ML service when it starts. By the time the
 *   visitor clicks "Sign in" the system is usually ready. It never runs on a timer: only real visits wake it.
 *   Signed-in visitors are not redirected from here (the session is only checked behind the gate); "Sign in"
 *   takes them straight to their dashboard.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { waitForServer } from '../../api/serverHealth.js';
import { BTN } from '../../utils/common.js';
import Icon from '../../components/common/Icon.jsx';
import ShieldMark from '../../components/common/ShieldMark.jsx';
import ScoringReplay from '../../components/landing/ScoringReplay.jsx';
import { PublicHeader, PublicFooter } from '../../components/landing/PublicChrome.jsx';

const STATUS_TEXT = {
  checking: 'Checking the servers…',
  waking:   'Starting the servers (free hosting sleeps when idle; this takes about a minute)…',
  online:   'Servers online. Ready to sign in.',
  offline:  'The servers did not answer. Try again in a minute.',
};
const STATUS_DOT = {
  checking: 'bg-gray-400',
  waking:   'bg-amber-500 animate-pulse motion-reduce:animate-none',
  online:   'bg-emerald-500',
  offline:  'bg-red-500',
};

/** Wakes the backend on visit and reports progress. */
function useServerStatus() {
  const [status, setStatus] = useState('checking');
  useEffect(() => {
    let active = true;
    const slow = setTimeout(() => { if (active) setStatus((s) => (s === 'checking' ? 'waking' : s)); }, 2500);
    waitForServer({ maxWaitMs: 120_000 }).then((ok) => { if (active) setStatus(ok ? 'online' : 'offline'); });
    return () => { active = false; clearTimeout(slow); };
  }, []);
  return status;
}

const STEPS = [
  {
    title: 'A payment arrives',
    text: 'A customer submits a payment: amount, merchant, payment method, city and the device it comes from.',
  },
  {
    title: 'Two engines score it',
    text: 'A rule engine checks six known warning signs. An XGBoost model trained on 5.4 lakh simulated payments weighs 15 behaviour signals together and explains its score with SHAP values.',
  },
  {
    title: 'The score decides',
    text: 'Below 25 the payment goes through. 25–49 goes through with an alert to the customer. 50–74 is held for review. 75 and above is blocked. Admins can move these bands.',
  },
  {
    title: 'An analyst reviews',
    text: 'Held and blocked payments become cases. An analyst sees the evidence, the explanation and the device history, then confirms the fraud or releases the money.',
  },
];

const RESULTS = [
  { label: 'Fraud caught before money moves (held or blocked)', ml: 68, rules: 35, unit: '%' },
  { label: 'Honest payments wrongly held or blocked', ml: 47, rules: 241, unit: '', lowerIsBetter: true },
];

const ROLES = [
  { icon: 'user', title: 'Customers', text: 'Make payments, see each fraud score with its reasons, follow alerts on a timeline and watch their trust score.' },
  { icon: 'briefcase', title: 'Fraud analysts', text: 'Work a queue of flagged payments, open cases, add notes, and confirm fraud or release the payment.' },
  { icon: 'sliders', title: 'Administrators', text: 'Watch live alerts and trends, tune the risk bands with a what-if preview, manage users and read the audit log.' },
];

function ResultBar({ value, max, tone }) {
  return (
    <div className="h-2 flex-1 rounded-full bg-gray-200" aria-hidden="true">
      <div className={`h-2 rounded-full ${tone}`} style={{ width: `${Math.max(2, (value / max) * 100)}%` }} />
    </div>
  );
}

export default function Landing() {
  const status = useServerStatus();

  useEffect(() => {
    const previous = document.title;
    document.title = 'FinGuardAI · Fraud detection for digital payments';
    return () => { document.title = previous; };
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <PublicHeader />

      <main>
        <section className="bg-watch-grid">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-6 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pb-24 lg:pt-12">
            <div>
              <ShieldMark className="mb-6 h-20 w-20" scanning />
              <h1 className="max-w-xl text-5xl font-bold leading-[1.05] sm:text-6xl">
                Every payment, checked before the money moves.
              </h1>
              <p className="mt-5 max-w-lg text-lg text-gray-600">
                FinGuardAI scores each digital payment in real time with a machine-learning model and a rule engine,
                holds or blocks the suspicious ones, and shows customers and analysts exactly why.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/register" className={`${BTN.base} ${BTN.primary} ${BTN.lg}`}>Create a customer account</Link>
                <Link to="/login" className={`${BTN.base} ${BTN.secondary} ${BTN.lg}`}>Sign in</Link>
              </div>
              <p className="mt-6 flex items-center gap-2 text-sm text-gray-600" role="status" data-testid="server-status">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
                {STATUS_TEXT[status]}
              </p>
            </div>
            <ScoringReplay />
          </div>
        </section>

        <section className="border-t border-gray-200 bg-white" aria-labelledby="how-title">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="how-title" className="text-3xl font-bold">How a payment is checked</h2>
            <ol className="mt-10 grid gap-8 md:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, i) => (
                <li key={step.title} className="border-l-2 border-primary-500 pl-4">
                  <span className="font-display text-sm font-semibold text-primary-700">Step {i + 1}</span>
                  <h3 className="mt-1 font-display text-xl font-bold">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-600">{step.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-t border-gray-200" aria-labelledby="results-title">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <h2 id="results-title" className="text-3xl font-bold">What the model adds</h2>
              <p className="mt-4 text-gray-600">
                Both engines scored the same 1,13,574 payments from 1,200 customers the model never saw during training.
                The model catches about twice as much fraud before the money moves and wrongly stops five times fewer
                honest payments.
              </p>
              <p className="mt-4 text-sm text-gray-500">
                The data is simulated in FinGuardAI&apos;s own format, because public fraud datasets lack signals such as
                usual cities, known devices and device trust. These numbers show the method works; they are not a
                measurement on real bank traffic.
              </p>
              <p className="mt-4 text-sm">
                <Link to="/model" className="font-medium text-primary-700 underline-offset-2 hover:underline">
                  Read the model card: data, results by fraud type, fairness and limits
                </Link>
              </p>
            </div>
            <div className="space-y-8">
              {RESULTS.map((r) => {
                const max = Math.max(r.ml, r.rules);
                return (
                  <div key={r.label}>
                    <p className="font-medium">{r.label}</p>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex items-center gap-3">
                        <dt className="w-28 shrink-0 text-gray-600">ML model</dt>
                        <ResultBar value={r.ml} max={max} tone="bg-primary-600" />
                        <dd className="w-14 text-right font-display text-xl font-bold tabular-nums">{r.ml}{r.unit}</dd>
                      </div>
                      <div className="flex items-center gap-3">
                        <dt className="w-28 shrink-0 text-gray-600">Rule engine</dt>
                        <ResultBar value={r.rules} max={max} tone="bg-gray-400" />
                        <dd className="w-14 text-right font-display text-xl font-bold tabular-nums">{r.rules}{r.unit}</dd>
                      </div>
                    </dl>
                    {r.lowerIsBetter && <p className="mt-1 text-xs text-gray-500">Lower is better.</p>}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="border-t border-gray-200 bg-white" aria-labelledby="roles-title">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="roles-title" className="text-3xl font-bold">One system, three kinds of user</h2>
            <ul className="mt-10 grid gap-10 md:grid-cols-3">
              {ROLES.map((role) => (
                <li key={role.title}>
                  <Icon name={role.icon} className="h-6 w-6 text-primary-600" />
                  <h3 className="mt-3 font-display text-xl font-bold">{role.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-600">{role.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
