/**
 * @file src/components/common/ScenarioPresets.jsx
 * @description R4-03: buttons that fill the payment form with an example scenario (utils/scenarios.js).
 *   Nothing is submitted: the customer reviews the form and presses "Submit for fraud check".
 */
import { useState } from 'react';
import { SCENARIOS } from '../../utils/scenarios.js';

/** @param {{ onPick: (scenario: object) => void }} props */
export default function ScenarioPresets({ onPick }) {
  const [picked, setPicked] = useState(null);
  const active = SCENARIOS.find((s) => s.key === picked);
  return (
    <section aria-label="Example payments" className="rounded-xl border border-dashed border-gray-300 p-4">
      <p className="text-sm font-medium text-gray-900">Try an example</p>
      <p className="mt-0.5 text-xs text-gray-500">Fills the form below; nothing is sent until you press Submit. Results depend on your payment history.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={picked === s.key}
            onClick={() => { setPicked(s.key); onPick(s); }}
            className={`rounded-full border px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
              picked === s.key ? 'border-primary-600 bg-primary-50 text-primary-800' : 'border-gray-300 text-gray-700 hover:bg-gray-100'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {active && <p className="mt-3 text-sm text-gray-600" aria-live="polite">{active.hint}</p>}
    </section>
  );
}
