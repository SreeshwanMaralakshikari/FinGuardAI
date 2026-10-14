/**
 * @file src/components/landing/ScoringReplay.jsx
 * @description Round 4 (R4-02): the landing page's signature element — a "scoring console" that replays three
 *   real results of the live system (recorded end to end with the real backend and ML service, 14 Oct 2026):
 *   a normal payment, an account takeover and a casino payment raised by the rule floor. It is labelled as
 *   sample data; nothing here calls the API.
 *   Motion: the two score meters fill when a sample is shown, and the samples advance every 7 s — but only
 *   until the visitor picks one themselves, and never under prefers-reduced-motion.
 */
import { useEffect, useState } from 'react';
import { SAMPLES } from './samples.js';


const LEVEL_STYLE = {
  LOW:      'border-chrome-ok/40 bg-chrome-ok/10 text-chrome-ok',
  MEDIUM:   'border-chrome-warn/40 bg-chrome-warn/10 text-chrome-warn',
  CRITICAL: 'border-chrome-bad/40 bg-chrome-bad/10 text-chrome-bad',
};

const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function Meter({ label, value, tone }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-chrome-muted">{label}</span>
        <span className="font-display text-2xl font-bold tabular-nums text-chrome-ink">{value}</span>
      </div>
      <div className="mt-1.5 h-2 rounded-full bg-chrome-hover" aria-hidden="true">
        <div className={`h-2 rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${tone}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

export default function ScoringReplay() {
  const [index, setIndex] = useState(1); // opens on the account takeover: the clearest example
  const [auto, setAuto] = useState(() => !prefersReducedMotion());
  // meters start empty for each newly shown sample, then fill (one orchestrated moment)
  const [filledIndex, setFilledIndex] = useState(-1);
  const shown = filledIndex === index;

  useEffect(() => {
    const t = setTimeout(() => setFilledIndex(index), 60);
    return () => clearTimeout(t);
  }, [index]);

  useEffect(() => {
    if (!auto) return undefined;
    const t = setTimeout(() => setIndex((i) => (i + 1) % SAMPLES.length), 7000);
    return () => clearTimeout(t);
  }, [auto, index]);

  const s = SAMPLES[index];
  const pick = (i) => { setAuto(false); setIndex(i); };

  return (
    <figure className="rounded-2xl border border-chrome-line bg-chrome p-5 shadow-2xl shadow-black/20 sm:p-6" aria-label="Sample scoring results">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Sample payments">
        {SAMPLES.map((x, i) => (
          <button
            key={x.key}
            type="button"
            role="tab"
            aria-selected={i === index}
            onClick={() => pick(i)}
            className={`rounded-full px-3 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
              i === index ? 'bg-primary-500 text-chrome' : 'text-chrome-muted hover:bg-chrome-hover hover:text-chrome-ink'
            }`}
          >
            {x.tab}
          </button>
        ))}
      </div>

      <div className="mt-5" role="tabpanel" aria-live={auto ? 'off' : 'polite'}>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-chrome-ink">
            <span className="font-medium">{s.merchant}</span>
          </p>
          <p className="font-display text-3xl font-bold tabular-nums text-chrome-ink">{s.amount}</p>
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-chrome-muted">
          {s.facts.map((f) => <li key={f}>{f}</li>)}
        </ul>

        <div className="mt-5 space-y-4">
          <Meter label="Rule engine" value={shown ? s.rules : 0} tone="bg-chrome-muted" />
          <Meter label="ML model (XGBoost)" value={shown ? s.ml : 0} tone="bg-primary-400" />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-chrome-line pt-4">
          <span className={`rounded-md border px-2.5 py-1 text-sm font-semibold ${LEVEL_STYLE[s.level]}`}>
            {s.level} · {s.final}/100
          </span>
          <span className="font-medium text-chrome-ink">{s.outcome}</span>
        </div>
        <p className="mt-3 text-sm text-chrome-muted">{s.note}</p>
      </div>
      <figcaption className="mt-4 text-xs text-chrome-muted">
        Sample results recorded from the live system, replayed here. Sign in to score your own payments.
      </figcaption>
    </figure>
  );
}
