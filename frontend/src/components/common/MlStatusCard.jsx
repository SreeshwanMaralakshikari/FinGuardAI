/**
 * @file src/components/common/MlStatusCard.jsx
 * @description Phase 10: admin card — which engine scores payments now (GET /admin-api/ml-status) and how the
 *   last 24 hours were scored. Informational only: while loading, on an error or on an unexpected answer it
 *   renders nothing, so the dashboard never breaks because of it.
 */
import { useFetch } from '../../hooks/useFetch.js';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { CARD, formatDate } from '../../utils/common.js';

const fetchStatus = async (signal) => (await api.get(API_PATHS.ADMIN.ML_STATUS, { signal }))?.data?.data ?? null;

function engineText(s) {
  if (!s.enabled) return { title: 'Rule engine', detail: 'The ML model is switched off (ML_ENABLED is not true).' };
  if (s.coolingDown) {
    return {
      title: 'Rule engine (ML waking up)',
      detail: `The ML service did not answer${s.lastFailureCode ? ` (${s.lastFailureCode})` : ''}; the rules score payments until it does.`,
    };
  }
  return {
    title: `ML model${s.modelVersion ? ` ${s.modelVersion}` : ''}`,
    detail: `Rule engine takes over if ${s.serviceHost ?? 'the ML service'} does not answer within ${s.timeoutMs} ms.`,
  };
}

export default function MlStatusCard() {
  const { data } = useFetch(fetchStatus, []);
  if (!data || typeof data.enabled !== 'boolean' || !data.last24h) return null;
  const { title, detail } = engineText(data);
  const { ML = 0, RULES = 0, LEGACY = 0 } = data.last24h;

  return (
    <section className={`${CARD.base} ${CARD.body} mb-6`} aria-label="Fraud scoring engine" data-testid="ml-status">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Fraud scoring engine</p>
          <p className="mt-1 text-lg font-semibold text-gray-900">{title}</p>
          <p className="mt-1 text-sm text-gray-600">{detail}</p>
          {data.lastSuccessAt && <p className="mt-1 text-xs text-gray-500">Last ML answer: {formatDate(data.lastSuccessAt)}</p>}
        </div>
        <dl className="grid grid-cols-3 gap-4 text-center">
          <div><dt className="text-xs text-gray-500">ML (24 h)</dt><dd className="text-lg font-semibold tabular-nums text-gray-900">{ML}</dd></div>
          <div><dt className="text-xs text-gray-500">Rules (24 h)</dt><dd className="text-lg font-semibold tabular-nums text-gray-900">{RULES}</dd></div>
          <div><dt className="text-xs text-gray-500">Before Phase 10</dt><dd className="text-lg font-semibold tabular-nums text-gray-900">{LEGACY}</dd></div>
        </dl>
      </div>
    </section>
  );
}
