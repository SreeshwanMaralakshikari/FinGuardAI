/**
 * @file src/pages/customer/FraudAlerts.jsx
 * @description The customer's own fraud alerts. Alert fields (verified against the API):
 *   { _id, transactionId: { publicId, amount, merchantName, paymentMethod, status, timestamp },
 *     alertType, riskLevel, fraudScore, reasons[], status, createdAt } — the transaction id,
 *   amount and merchant live in `alert.transactionId`, the date is `createdAt`.
 *   N-02: a failed load shows the error + Retry — never "nothing suspicious" (which would be a
 *   false all-clear on a fraud page). An alert dismissed by an analyst after a case review is
 *   DISMISSED (false positive) and its transaction is APPROVED again.
 *   Statuses: OPEN, REVIEWED, DISMISSED and ACKNOWLEDGED (F-02: the customer confirmed a MEDIUM alert with
 *   "Acknowledge" -> PATCH /customer-api/fraud-alerts/:id/acknowledge; HIGH / CRITICAL alerts are the fraud
 *   team's and have no button; an acknowledged alert is no longer counted as open).
 *   A-02: a "Timeline" tab shows GET /customer-api/timeline?limit=50 (payments, alerts, case outcomes).
 */
import { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { fetchFraudAlertsThunk, acknowledgeAlertThunk } from '../../store/slices/fraudAlertSlice.js';
import toast from 'react-hot-toast';
import api from '../../api/axios.js';
import { BTN, CARD, INPUT, formatCurrency, formatDate } from '../../utils/common.js';
import { API_PATHS, PAGINATION, RISK_LEVELS } from '../../utils/constants.js';
import { useFetch } from '../../hooks/useFetch.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Pagination from '../../components/common/Pagination.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import Alert from '../../components/common/Alert.jsx';
import Modal from '../../components/common/Modal.jsx';
import FraudTimeline from '../../components/common/FraudTimeline.jsx';
import BusyRegion from '../../components/common/BusyRegion.jsx';
import { RiskBadge, AlertStatusBadge, TxStatusBadge } from '../../components/common/Badges.jsx';

const ALERT_STATUSES = ['OPEN', 'REVIEWED', 'DISMISSED', 'ACKNOWLEDGED'];
const TIMELINE_LIMIT = 50;

/** A-02: mounted only while the Timeline tab is open, so the feed is fetched on demand and always fresh. */
function TimelineTab() {
  const { data, loading, error, reload } = useFetch(
    async (signal) => (await api.get(API_PATHS.CUSTOMER.TIMELINE, { params: { limit: TIMELINE_LIMIT }, signal })).data.data ?? [],
    [],
  );
  if (error) return <LoadError message={error} onRetry={reload} />;
  if (loading && !data) return <Spinner />;
  if (!data || data.length === 0) return <EmptyState title="No activity yet" message="Your payments, fraud alerts and case outcomes will appear here." />;
  return (
    <div>
      <p className="mb-4 text-xs text-gray-500">Your {data.length} most recent events, newest first. Times are India time (IST).</p>
      <FraudTimeline events={data} />
    </div>
  );
}

export default function FraudAlerts() {
  const dispatch = useAppDispatch();
  const { alerts, pagination, loading, error } = useAppSelector((s) => s.fraudAlerts);
  const [riskLevel, setRiskLevel] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0); // Retry re-runs the load effect
  const [tab, setTab] = useState('alerts');
  const [ackTarget, setAckTarget] = useState(null); // MEDIUM alert awaiting "I recognise this payment"
  const [ackBusy, setAckBusy] = useState(false);
  const [ackError, setAckError] = useState('');

  const confirmAck = async () => {
    setAckBusy(true);
    setAckError('');
    const action = await dispatch(acknowledgeAlertThunk(ackTarget._id));
    setAckBusy(false);
    if (acknowledgeAlertThunk.fulfilled.match(action)) {
      toast.success('Alert acknowledged');
      setAckTarget(null);
    } else {
      setAckError(action.payload ?? 'Could not acknowledge the alert');
    }
  };

  useEffect(() => {
    const params = { page, limit: PAGINATION.DEFAULT_LIMIT_STANDARD };
    if (riskLevel) params.riskLevel = riskLevel;
    if (status) params.status = status;
    dispatch(fetchFraudAlertsThunk(params));
  }, [dispatch, page, riskLevel, status, attempt]);

  return (
    <div>
      <PageHeader title="Fraud alerts" subtitle="Payments our engine flagged as suspicious, and why." />

      <div role="tablist" aria-label="Fraud alerts views" className="mb-4 flex gap-2 border-b border-gray-200">
        {[['alerts', 'Alerts'], ['timeline', 'Timeline']].map(([key, text]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`fa-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`fa-panel-${key}`}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === key ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-600 hover:text-gray-900'}`}
            onClick={() => setTab(key)}
          >
            {text}
          </button>
        ))}
      </div>

      {tab === 'timeline' ? (
        <div role="tabpanel" id="fa-panel-timeline" aria-labelledby="fa-tab-timeline"><TimelineTab /></div>
      ) : (
      <div role="tabpanel" id="fa-panel-alerts" aria-labelledby="fa-tab-alerts">
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-xl">
        <div>
          <label htmlFor="a-risk" className={INPUT.label}>Risk level</label>
          <select id="a-risk" className={INPUT.select} value={riskLevel} onChange={(e) => { setPage(1); setRiskLevel(e.target.value); }}>
            <option value="">All</option>
            {Object.values(RISK_LEVELS).filter((r) => r !== 'LOW').map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="a-status" className={INPUT.label}>Status</label>
          <select id="a-status" className={INPUT.select} value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">All</option>
            {ALERT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {error ? (
        <LoadError message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : loading && alerts.length === 0 ? <Spinner /> : alerts.length === 0 ? (
        <EmptyState title="No fraud alerts" message="Great news — nothing suspicious matches these filters." />
      ) : (
        <BusyRegion busy={loading}>
          <ul className="space-y-3">
            {alerts.map((a) => (
              <li key={a._id} className={`${CARD.base} p-5`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">
                      {a.transactionId?.merchantName ?? 'Transaction'}{' '}
                      <span className="font-normal text-gray-500">· {a.transactionId?.publicId}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {a.alertType?.replaceAll('_', ' ')} · {formatDate(a.createdAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <RiskBadge level={a.riskLevel} />
                    <AlertStatusBadge status={a.status} />
                    {a.transactionId?.status && <TxStatusBadge status={a.transactionId.status} />}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                  <p><span className="text-gray-500">Amount: </span><span className="font-medium">{formatCurrency(a.transactionId?.amount)}</span></p>
                  <p><span className="text-gray-500">Fraud score: </span><span className="font-medium">{a.fraudScore}/100</span></p>
                </div>
                {a.reasons?.length > 0 && (
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-700">
                    {a.reasons.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                )}
                {a.riskLevel === 'MEDIUM' && a.status === 'OPEN' && (
                  <div className="mt-3">
                    <button
                      type="button"
                      className={`${BTN.base} ${BTN.secondary} ${BTN.sm}`}
                      aria-label={`Acknowledge alert for ${a.transactionId?.merchantName ?? 'this payment'}`}
                      onClick={() => { setAckError(''); setAckTarget(a); }}
                    >
                      Acknowledge
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </BusyRegion>
      )}

      {!error && <Pagination page={page} limit={pagination.limit} total={pagination.total} onChange={setPage} />}
      </div>
      )}

      <Modal
        open={ackTarget !== null}
        title="Acknowledge alert"
        onClose={() => setAckTarget(null)}
        dismissible={!ackBusy}
        footer={(
          <>
            <button type="button" disabled={ackBusy} className={`${BTN.base} ${BTN.secondary} ${BTN.md}`} onClick={() => setAckTarget(null)}>Cancel</button>
            <button type="button" disabled={ackBusy} className={`${BTN.base} ${BTN.primary} ${BTN.md}`} onClick={confirmAck}>
              {ackBusy ? 'Saving…' : 'I recognise this payment'}
            </button>
          </>
        )}
      >
        <div className="space-y-3">
          <Alert tone="error">{ackError}</Alert>
          <p className="text-sm text-gray-700">
            Only confirm if you recognise this payment
            {ackTarget?.transactionId?.merchantName ? <> to <span className="font-semibold">{ackTarget.transactionId.merchantName}</span></> : null}
            {ackTarget?.transactionId?.amount != null ? <> of <span className="font-semibold">{formatCurrency(ackTarget.transactionId.amount)}</span></> : null}.
            The alert will be marked ACKNOWLEDGED and no longer counted as open. If you do not recognise it, leave it open and contact support.
          </p>
        </div>
      </Modal>
    </div>
  );
}
