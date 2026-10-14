/**
 * @file src/components/common/MlStatusCard.jsx
 * @description Phase 10: admin card — which engine scores payments now (GET /admin-api/ml-status) and how the
 *   last 24 hours were scored. Informational only: while loading, on an error or on an unexpected answer it
 *   renders nothing, so the dashboard never breaks because of it.
 *   D-2: loading the card also makes the backend wake a sleeping ML service; while it is waking (or cooling
 *   down after a failure) the card re-checks every 10 seconds, up to 2 minutes, so it turns to "ML model"
 *   by itself once the service answers.
 *   E-07: the cool-down text depends on WHY the ML service is not used: a wrong API key (AUTH) or a rejected
 *   answer (INVALID_RESPONSE) will not fix itself by waiting, unlike a sleeping service.
 */
import { useEffect, useRef } from 'react';
import { useFetch } from '../../hooks/useFetch.js';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { CARD, formatDate } from '../../utils/common.js';

const fetchStatus = async (signal) => (await api.get(API_PATHS.ADMIN.ML_STATUS, { signal }))?.data?.data ?? null;

const POLL_MS = 10_000;
const MAX_POLLS = 12;

const COOLDOWN_TEXT = {
  AUTH: {
    title: 'Rule engine (ML key rejected)',
    detail: 'The ML service rejected the API key. ML_API_KEY must be exactly the same on the backend and on the ML service; the rules score payments until it is fixed.',
  },
  INVALID_RESPONSE: {
    title: 'Rule engine (ML answer rejected)',
    detail: 'The ML service sent an answer the backend could not validate, so the rules score payments for now. Check that the backend and the ML service are the same version.',
  },
};

/** The last failure was a contract mismatch (422) and nothing succeeded since — CONTRACT causes no cool-down. */
const contractProblem = (s) => s.lastFailureCode === 'CONTRACT'
  && (!s.lastSuccessAt || new Date(s.lastFailureAt) > new Date(s.lastSuccessAt));

function engineText(s) {
  if (!s.enabled) return { title: 'Rule engine', detail: 'The ML model is switched off (ML_ENABLED is not true).' };
  if (s.coolingDown) {
    return COOLDOWN_TEXT[s.lastFailureCode] ?? {
      title: 'Rule engine (ML waking up)',
      detail: `The ML service did not answer${s.lastFailureCode ? ` (${s.lastFailureCode})` : ''}; the rules score payments until it does.`,
    };
  }
  if (s.waking) {
    return {
      title: `ML model${s.modelVersion ? ` ${s.modelVersion}` : ''} (waking up)`,
      detail: 'The ML service sleeps after 15 minutes without payments and is starting now (usually under a minute). Until it answers, payments are scored by the rule engine.',
    };
  }
  return {
    title: `ML model${s.modelVersion ? ` ${s.modelVersion}` : ''}`,
    detail: `Rule engine takes over if ${s.serviceHost ?? 'the ML service'} does not answer within ${s.timeoutMs} ms.`,
  };
}

export default function MlStatusCard() {
  const { data, reload } = useFetch(fetchStatus, []);
  const polls = useRef(0);
  const unsettled = Boolean(data?.enabled && (data.waking || data.coolingDown));

  useEffect(() => {
    if (!unsettled || polls.current >= MAX_POLLS) return undefined;
    const timer = setTimeout(() => { polls.current += 1; reload(); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [unsettled, data, reload]);

  if (!data || typeof data.enabled !== 'boolean' || !data.last24h) return null;
  const { title, detail } = engineText(data);
  const { ML = 0, RULES = 0, LEGACY = 0 } = data.last24h;

  return (
    <section className={`${CARD.base} ${CARD.body} mb-6`} aria-label="Fraud scoring engine" data-testid="ml-status">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Fraud scoring engine</p>
          <p className="mt-1 text-lg font-semibold text-gray-900" aria-live="polite">{title}</p>
          <p className="mt-1 text-sm text-gray-600">{detail}</p>
          {data.enabled && contractProblem(data) && (
            <p className="mt-1 text-sm text-red-700">The last payment sent to the ML service was rejected as a contract mismatch (422): the backend and the ML service expect different features.</p>
          )}
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
