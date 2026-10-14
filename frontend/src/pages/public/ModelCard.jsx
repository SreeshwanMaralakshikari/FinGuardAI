/**
 * @file src/pages/public/ModelCard.jsx
 * @description R4-09: public model card for the fraud model (/model), in the spirit of "Model Cards for Model
 *   Reporting" (Mitchell et al., 2019): what the model is, what it is for and not for, the data, how well it
 *   works overall and per fraud type, what it looks at, fairness and privacy, limitations, and how the app uses
 *   it. Static content (components/modelcard/modelFacts.js); rendered outside the server wake gate like "/".
 */
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { PublicHeader, PublicFooter } from '../../components/landing/PublicChrome.jsx';
import { MODEL, DATASET, METRICS, SCENARIOS, CALIBRATION, IMPORTANCE } from '../../components/modelcard/modelFacts.js';

const pct = (v, digits = 0) => `${(v * 100).toFixed(digits)} %`;
const num = (v) => v.toLocaleString('en-IN');

function Section({ id, title, children }) {
  return (
    <section aria-labelledby={id} className="border-t border-gray-200 py-10">
      <h2 id={id} className="text-2xl font-bold">{title}</h2>
      <div className="mt-4 space-y-4 text-gray-700">{children}</div>
    </section>
  );
}

function PairBar({ label, ml, rules, max = 1 }) {
  return (
    <div>
      <p className="text-sm font-medium text-gray-900">{label}</p>
      <dl className="mt-1.5 space-y-1 text-sm">
        {[['ML model', ml, 'bg-primary-600'], ['Rule engine', rules, 'bg-gray-400']].map(([name, v, tone]) => (
          <div key={name} className="flex items-center gap-3">
            <dt className="w-24 shrink-0 text-gray-600">{name}</dt>
            <div className="h-2 flex-1 rounded-full bg-gray-200" aria-hidden="true">
              <div className={`h-2 rounded-full ${tone}`} style={{ width: `${Math.max(1, (v / max) * 100)}%` }} />
            </div>
            <dd className="w-14 text-right tabular-nums">{pct(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function ModelCard() {
  useEffect(() => {
    const previous = document.title;
    document.title = `Model card ${MODEL.version} · FinGuardAI`;
    return () => { document.title = previous; };
  }, []);
  const top = IMPORTANCE[0].value;

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <PublicHeader />
      <main className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        <div className="pb-8 pt-6">
          <p className="font-display text-lg font-semibold text-primary-700">Model card</p>
          <h1 className="mt-1 text-4xl font-bold sm:text-5xl">FinGuardAI fraud model {MODEL.version}</h1>
          <p className="mt-4 text-lg text-gray-600">
            What the model behind FinGuardAI&apos;s fraud scores is, what it was trained on, how well it works and where it
            falls short. Written for examiners, analysts and anyone deciding how far to trust a score.
          </p>
        </div>

        <dl className="grid gap-x-8 gap-y-4 rounded-xl border border-gray-200 bg-white p-6 text-sm sm:grid-cols-2">
          {[
            ['Model', MODEL.algorithm],
            ['Version and date', `${MODEL.version}, trained ${MODEL.trainedAt} (XGBoost ${MODEL.xgboostVersion})`],
            ['Input', `${MODEL.inputs} facts about one payment and the customer's own history (${MODEL.modelColumns} columns after encoding)`],
            ['Output', 'Probability that the payment is fraud, shown as a score from 0 to 100'],
            ['Explanation', 'SHAP values for every payment (exact TreeSHAP), shown as bars and reasons'],
            ['Monotonic rules', 'A riskier value can never lower the score (for example a larger amount ratio or a new device)'],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="font-medium text-gray-900">{k}</dt>
              <dd className="mt-0.5 text-gray-600">{v}</dd>
            </div>
          ))}
        </dl>

        <Section id="use" title="What it is for">
          <p>
            Scoring payments in this student demonstration of fraud detection for Indian digital payments (UPI, cards,
            net banking and wallets), so that suspicious payments are alerted, held or blocked before the money moves, and
            an analyst can see why.
          </p>
          <p className="font-medium text-gray-900">Not for</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Real banking decisions. It was trained on simulated data only.</li>
            <li>Judging a person. The score describes one payment against that customer&apos;s own history.</li>
            <li>Acting alone. Holds and blocks go to an analyst, and the customer can answer &quot;Was this you?&quot;.</li>
          </ul>
        </Section>

        <Section id="data" title="Training data">
          <p>
            Public fraud datasets do not contain the signals FinGuardAI uses (usual cities, usual hours, known devices,
            device trust), so the data was simulated in FinGuardAI&apos;s own format: {num(DATASET.payments)} payments from{' '}
            {num(DATASET.customers)} customers over 120 days, {pct(DATASET.fraudRate, 2)} of them fraud.
          </p>
          <p>
            Fraud comes from seven scenarios (account takeover, SIM swap, card testing, mule cash-out, new-account fraud,
            social engineering, low-and-slow), and a little label noise imitates disputed chargebacks. Labels come from
            the scenario, never from the rule engine, so the model does not simply copy the rules.
          </p>
          <p>
            Customers were split 70 / 15 / 15 so that no customer appears in two parts: {num(DATASET.trainPayments)}{' '}
            payments for training, {num(DATASET.validationPayments)} for tuning, and {num(DATASET.testPayments)} payments
            from {num(DATASET.testCustomers)} unseen customers for every result below.
          </p>
        </Section>

        <Section id="results" title="How well it works">
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Test-set results of the ML model, the model with the policy floor, and the rule engine</caption>
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Test set ({num(DATASET.testPayments)} payments)</th>
                  <th scope="col" className="px-4 py-3 font-medium">ML model</th>
                  <th scope="col" className="px-4 py-3 font-medium">ML + policy floor (live)</th>
                  <th scope="col" className="px-4 py-3 font-medium">Rule engine</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 tabular-nums">
                <tr><th scope="row" className="px-4 py-2.5 font-normal">ROC-AUC</th><td className="px-4">{METRICS.ml.rocAuc.toFixed(3)}</td><td className="px-4">—</td><td className="px-4">{METRICS.rules.rocAuc.toFixed(3)}</td></tr>
                <tr><th scope="row" className="px-4 py-2.5 font-normal">Fraud held or blocked (recall at HIGH)</th><td className="px-4">{pct(METRICS.ml.high.recall)}</td><td className="px-4">{pct(METRICS.floor.high.recall)}</td><td className="px-4">{pct(METRICS.rules.high.recall)}</td></tr>
                <tr><th scope="row" className="px-4 py-2.5 font-normal">Holds and blocks that were fraud (precision)</th><td className="px-4">{pct(METRICS.ml.high.precision)}</td><td className="px-4">{pct(METRICS.floor.high.precision)}</td><td className="px-4">{pct(METRICS.rules.high.precision)}</td></tr>
                <tr><th scope="row" className="px-4 py-2.5 font-normal">Honest payments held or blocked</th><td className="px-4">{METRICS.ml.high.fp}</td><td className="px-4">{METRICS.floor.high.fp}</td><td className="px-4">{METRICS.rules.high.fp}</td></tr>
                <tr><th scope="row" className="px-4 py-2.5 font-normal">Payments that raise an alert (MEDIUM or above)</th><td className="px-4">{pct(METRICS.ml.medium.flaggedShare, 2)}</td><td className="px-4">{pct(METRICS.floor.medium.flaggedShare, 2)}</td><td className="px-4">{pct(METRICS.rules.medium.flaggedShare, 2)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm text-gray-600">
            The live system adds a policy floor: a merchant on the admin&apos;s high-risk list, a blacklisted device or an
            amount above the high-value limit always raises an alert when the rules rate it MEDIUM. It does not change
            holds and blocks, which is why the HIGH columns are identical.
          </p>

          <h3 className="pt-4 font-display text-xl font-bold text-gray-900">By type of fraud (held or blocked)</h3>
          <div className="space-y-4">
            {SCENARIOS.map((s) => <PairBar key={s.key} label={`${s.label} (${s.payments} payments)`} ml={s.ml} rules={s.rules} />)}
          </div>
          <p className="text-sm text-gray-600">
            The rules catch more mule cash-outs; the policy floor turns most of them into alerts (85 % caught at MEDIUM).
            Social engineering and low-and-slow fraud look like normal payments to both engines: the victim pays from their
            own phone. That is what &quot;Was this you?&quot; and analyst review are for.
          </p>

          <h3 className="pt-4 font-display text-xl font-bold text-gray-900">Can the probability be trusted?</h3>
          <p>
            Mostly yes. Payments the model gives 75 % or more were fraud {pct(CALIBRATION[4].observed, 1)} of the time
            (Brier score {METRICS.ml.brier}).
          </p>
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm tabular-nums">
              <caption className="sr-only">Calibration on the test set</caption>
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Model probability</th>
                  <th scope="col" className="px-4 py-3 font-medium">Payments</th>
                  <th scope="col" className="px-4 py-3 font-medium">Average prediction</th>
                  <th scope="col" className="px-4 py-3 font-medium">Actually fraud</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {CALIBRATION.map((c) => (
                  <tr key={c.range}>
                    <th scope="row" className="px-4 py-2.5 font-normal">{c.range}</th>
                    <td className="px-4">{num(c.payments)}</td>
                    <td className="px-4">{pct(c.predicted, 1)}</td>
                    <td className="px-4">{pct(c.observed, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section id="inputs" title="What the model looks at">
          <p>Average influence of each input on the score (mean absolute SHAP value on the test set; longer means it mattered more).</p>
          <ul className="space-y-2">
            {IMPORTANCE.map((f) => (
              <li key={f.feature} className="grid grid-cols-[minmax(0,13rem)_1fr_3.5rem] items-center gap-3 text-sm">
                <span>{f.label}</span>
                <span className="h-2 rounded-full bg-gray-200" aria-hidden="true">
                  <span className="block h-2 rounded-full bg-primary-600" style={{ width: `${(f.value / top) * 100}%` }} />
                </span>
                <span className="text-right tabular-nums text-gray-600">{f.value.toFixed(2)}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-gray-600">
            &quot;Device blacklisted&quot; shows 0 because no simulated device fell below the blacklist line; the trust score
            carries that signal, and the rule engine and the policy floor still act on a blacklist.
          </p>
        </Section>

        <Section id="fairness" title="Fairness and privacy">
          <p>
            The model never sees a name, gender, age, religion, caste, language or address. Its inputs are the payment
            (amount, method, merchant category, hour) and comparisons with the customer&apos;s own past payments (usual
            cities, known devices, usual hours), plus the trust score of the device.
          </p>
          <p>
            That does not make it neutral. A customer who travels, moves for work, or changes phones often looks
            &quot;unusual&quot; and will see more alerts and holds than one who does not. A device shared by many people
            inherits their trust score. These are the reasons a hold is never final without an analyst, every score comes
            with its reasons, and the customer can answer &quot;Was this you?&quot; on any held or blocked payment.
          </p>
        </Section>

        <Section id="limits" title="Limitations">
          <ul className="list-disc space-y-2 pl-5">
            <li>The numbers come from simulated data designed by the project team. They show the method works; they are not a measurement on real bank traffic, and part of the gap between model and rules is built into the scenarios.</li>
            <li>Social engineering and low-and-slow fraud are close to invisible to both engines.</li>
            <li>On its own the model treats a casino payment or a very large payment from a known device as normal; the policy floor covers this in the live system.</li>
            <li>The model is static. It does not learn from analysts&apos; decisions until it is retrained.</li>
          </ul>
        </Section>

        <Section id="system" title="How FinGuardAI uses it">
          <ul className="list-disc space-y-2 pl-5">
            <li>The score is turned into a decision with the admin&apos;s risk bands: below 25 approve, 25–49 approve with an alert, 50–74 hold for an analyst, 75 and above block.</li>
            <li>The rule engine always runs as well. If the model does not answer within 2.5 seconds, or answers wrongly, the rule engine&apos;s score is used and the reason is stored.</li>
            <li>A policy floor makes sure admin policy (high-risk merchants, blacklisted devices, high-value amounts) always raises an alert.</li>
          </ul>
          <p className="text-sm">
            <Link to="/" className="font-medium text-primary-700 underline-offset-2 hover:underline">Back to the home page</Link>
          </p>
        </Section>
      </main>
      <PublicFooter />
    </div>
  );
}
