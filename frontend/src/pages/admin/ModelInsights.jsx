/**
 * @file src/pages/admin/ModelInsights.jsx
 * @description R4-08: how the ML model behaves in real use (GET /admin-api/model-insights?days=7|30|90):
 *   which engine scored payments and why the rules took over, ML-vs-rules band agreement (4 × 4), the biggest
 *   disagreements, what the model leaned on (mean |SHAP| of recent payments), and how analysts' case outcomes
 *   and customers' "Was this you?" answers line up. Links to the public model card.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFetch } from '../../hooks/useFetch.js';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { CARD, TABLE, formatCurrency, formatDate } from '../../utils/common.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import StatCard from '../../components/common/StatCard.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import { RiskBadge } from '../../components/common/Badges.jsx';

const WINDOWS = [7, 30, 90];
const LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const FALLBACK_LABELS = {
  TIMEOUT: 'did not answer in time',
  UNAVAILABLE: 'was unavailable or asleep',
  COOLDOWN: 'was starting up (skipped)',
  AUTH: 'rejected the API key',
  CONTRACT: 'rejected the features (contract)',
  INVALID_RESPONSE: 'sent an invalid answer',
  ERROR: 'failed unexpectedly',
};

const fetchInsights = (days) => async (signal) =>
  (await api.get(API_PATHS.ADMIN.MODEL_INSIGHTS, { params: { days }, signal }))?.data?.data ?? null;

const share = (part, total) => (total > 0 ? `${Math.round((part / total) * 100)} %` : '—');

function Card({ title, subtitle, children, id }) {
  return (
    <section className={`${CARD.base} min-w-0 p-5`} aria-labelledby={id}>
      <h2 id={id} className="text-base font-semibold text-gray-900">{title}</h2>
      {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function AgreementMatrix({ agreement }) {
  const max = Math.max(1, ...LEVELS.flatMap((a) => LEVELS.map((b) => agreement.matrix[a][b])));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[18rem] text-center text-sm tabular-nums">
        <caption className="sr-only">Payments by ML risk band (rows) and rule-engine risk band (columns)</caption>
        <thead>
          <tr>
            <th scope="col" className="p-2 text-left text-xs font-medium text-gray-500">ML ↓ / Rules →</th>
            {LEVELS.map((l) => <th key={l} scope="col" className="p-2 text-xs font-medium text-gray-500">{l}</th>)}
          </tr>
        </thead>
        <tbody>
          {LEVELS.map((a) => (
            <tr key={a}>
              <th scope="row" className="p-2 text-left text-xs font-medium text-gray-500">{a}</th>
              {LEVELS.map((b) => {
                const v = agreement.matrix[a][b];
                const same = a === b;
                return (
                  <td key={b} className="p-1">
                    <span
                      className={`block rounded-md py-2 ${v === 0 ? 'text-gray-400' : 'font-semibold text-gray-900'} ${same ? 'ring-1 ring-primary-500' : ''}`}
                      style={{ backgroundColor: v ? `color-mix(in oklab, var(--color-primary-500) ${Math.round(8 + (v / max) * 42)}%, transparent)` : undefined }}
                    >
                      {v}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ModelInsights() {
  const [days, setDays] = useState(30);
  const { data, loading, error, reload } = useFetch(fetchInsights(days), [days]);

  const picker = (
    <div className="flex gap-1" role="group" aria-label="Time window">
      {WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          aria-pressed={days === w}
          onClick={() => setDays(w)}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
            days === w ? 'bg-primary-600 text-on-accent' : 'text-gray-600 hover:bg-gray-100'
          }`}
        >
          {w} days
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <PageHeader title="Model insights" subtitle="How the ML model behaves on real payments, compared with the rule engine." actions={picker} />
      <LoadError message={error} onRetry={reload} />
      {!data && loading && <Spinner className="py-16" />}
      {data && (
        <div className="space-y-6" aria-busy={loading}>
          {(() => {
            const scored = data.engines.ML + data.engines.RULES + data.engines.LEGACY;
            const fallbackTotal = Object.values(data.fallbacks).reduce((s, n) => s + n, 0);
            const a = data.agreement;
            const mlCases = data.outcomes.ML.confirmed + data.outcomes.ML.dismissed;
            return (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <StatCard label="Scored by the model" value={share(data.engines.ML, scored)} hint={`${data.engines.ML} of ${scored} payments in ${data.windowDays} days`} />
                  <StatCard label="Same risk band as the rules" value={share(a.agree, a.total)} hint={`${a.agree} of ${a.total} model-scored payments`} />
                  <StatCard label="Raised by the policy floor" value={data.floorRaised} hint="High-risk merchant, blacklisted device or high-value amount" />
                  <StatCard
                    label="Model holds confirmed as fraud"
                    value={share(data.outcomes.ML.confirmed, mlCases)}
                    hint={`${data.outcomes.ML.confirmed} confirmed, ${data.outcomes.ML.dismissed} false alarms (closed cases)`}
                  />
                </div>

                <div className="grid gap-6 lg:grid-cols-2">
                  <Card id="agree-title" title="Model band vs rule band" subtitle={`Model-scored payments, current bands (MEDIUM ${data.bands.mediumMin}, HIGH ${data.bands.highMin}, CRITICAL ${data.bands.criticalMin}). Outlined cells: both agree.`}>
                    {a.total === 0 ? <p className="text-sm text-gray-500">No model-scored payments in this period.</p> : (
                      <>
                        <AgreementMatrix agreement={a} />
                        <p className="mt-3 text-sm text-gray-600">
                          The model rated {a.mlHigher} payment{a.mlHigher === 1 ? '' : 's'} higher than the rules and {a.rulesHigher} lower.
                        </p>
                      </>
                    )}
                  </Card>

                  <Card id="influence-title" title="What the model leaned on" subtitle={`Average influence (mean |SHAP|) over the last ${data.influence.payments} model-scored payments`}>
                    {data.influence.features.length === 0 ? <p className="text-sm text-gray-500">No explanations stored in this period.</p> : (
                      <ul className="space-y-2">
                        {data.influence.features.slice(0, 8).map((f) => (
                          <li key={f.feature} className="grid grid-cols-[minmax(0,1.3fr)_1fr_2.5rem] items-center sm:grid-cols-[minmax(0,12rem)_1fr_3rem] gap-3 text-sm">
                            <span className="truncate text-gray-700">{f.label}</span>
                            <span className="h-2 rounded-full bg-gray-200" aria-hidden="true">
                              <span className="block h-2 rounded-full bg-primary-600" style={{ width: `${(f.meanAbsShap / data.influence.features[0].meanAbsShap) * 100}%` }} />
                            </span>
                            <span className="text-right tabular-nums text-gray-600">{f.meanAbsShap.toFixed(2)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-3 text-xs text-gray-500">
                      Compare with the test-set ranking on the <Link to="/model" className="font-medium text-primary-700 hover:underline">model card</Link>.
                    </p>
                  </Card>
                </div>

                <Card id="disagree-title" title="Biggest disagreements" subtitle="Model-scored payments where the model and the rules put the payment in different bands">
                  {data.disagreements.length === 0 ? <p className="text-sm text-gray-500">No disagreements in this period.</p> : (
                    <div className={TABLE.wrapper}>
                      <table className={TABLE.table}>
                        <thead className={TABLE.thead}>
                          <tr>
                            {['Payment', 'Amount', 'Model', 'Rules', 'Final', 'When'].map((h) => <th key={h} scope="col" className={TABLE.th}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody className={TABLE.tbody}>
                          {data.disagreements.map((d) => (
                            <tr key={d.id} className={TABLE.tr}>
                              <td className={TABLE.td}><span className="font-medium text-gray-900">{d.publicId}</span><span className="block text-xs text-gray-500">{d.merchantName}</span></td>
                              <td className={TABLE.td}>{formatCurrency(d.amount)}</td>
                              <td className={`${TABLE.td} tabular-nums`}>{d.mlScore} · {d.mlBand}</td>
                              <td className={`${TABLE.td} tabular-nums`}>{d.ruleScore} · {d.ruleBand}</td>
                              <td className={TABLE.td}><RiskBadge level={d.riskLevel} />{d.ruleFloor && <span className="ml-2 text-xs text-gray-500">floor</span>}</td>
                              <td className={TABLE.td}>{formatDate(d.timestamp)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>

                <div className="grid gap-6 lg:grid-cols-2">
                  <Card id="fallback-title" title="When the rule engine took over" subtitle={`${data.engines.RULES} payments scored by the rules; ${data.engines.LEGACY} from before Phase 10`}>
                    {fallbackTotal === 0 ? <p className="text-sm text-gray-500">The model answered every payment it was asked about.</p> : (
                      <ul className="space-y-1 text-sm text-gray-700">
                        {Object.entries(data.fallbacks).sort((x, y) => y[1] - x[1]).map(([code, n]) => (
                          <li key={code} className="flex justify-between gap-4"><span>The ML service {FALLBACK_LABELS[code] ?? code}</span><span className="tabular-nums">{n}</span></li>
                        ))}
                      </ul>
                    )}
                  </Card>

                  <Card id="outcome-title" title="What analysts decided" subtitle="Cases closed in this period: fraud confirmed vs false alarm">
                    <table className="w-full text-left text-sm tabular-nums">
                      <caption className="sr-only">Closed cases by scoring engine and by the customer&apos;s answer</caption>
                      <thead className="text-xs text-gray-500">
                        <tr><th scope="col" className="py-1 font-medium" /><th scope="col" className="py-1 font-medium">Fraud confirmed</th><th scope="col" className="py-1 font-medium">False alarm</th></tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {[
                          ['Scored by the model', data.outcomes.ML],
                          ['Scored by the rules', data.outcomes.RULES],
                          ['Customer said "not me"', data.customerAnswers.DISPUTED],
                          ['Customer said "it was me"', data.customerAnswers.CONFIRMED],
                        ].map(([label, o]) => (
                          <tr key={label}><th scope="row" className="py-2 font-normal text-gray-700">{label}</th><td>{o.confirmed}</td><td>{o.dismissed}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
