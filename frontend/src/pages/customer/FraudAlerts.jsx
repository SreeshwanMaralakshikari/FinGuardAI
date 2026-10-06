/**
 * @file src/pages/customer/FraudAlerts.jsx
 * @description The customer's own fraud alerts. Alert fields (verified against the API):
 *   { _id, transactionId: { publicId, amount, merchantName, paymentMethod, status, timestamp },
 *     alertType, riskLevel, fraudScore, reasons[], status, createdAt } — the transaction id,
 *   amount and merchant live in `alert.transactionId`, the date is `createdAt`.
 *   N-02: a failed load shows the error + Retry — never "nothing suspicious" (which would be a
 *   false all-clear on a fraud page). An alert dismissed by an analyst after a case review is
 *   DISMISSED (false positive) and its transaction is APPROVED again.
 */
import { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import { fetchFraudAlertsThunk } from '../../store/slices/fraudAlertSlice.js';
import { CARD, INPUT, formatCurrency, formatDate } from '../../utils/common.js';
import { PAGINATION, RISK_LEVELS } from '../../utils/constants.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Pagination from '../../components/common/Pagination.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import BusyRegion from '../../components/common/BusyRegion.jsx';
import { RiskBadge, AlertStatusBadge, TxStatusBadge } from '../../components/common/Badges.jsx';

const ALERT_STATUSES = ['OPEN', 'REVIEWED', 'DISMISSED'];

export default function FraudAlerts() {
  const dispatch = useAppDispatch();
  const { alerts, pagination, loading, error } = useAppSelector((s) => s.fraudAlerts);
  const [riskLevel, setRiskLevel] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0); // Retry re-runs the load effect

  useEffect(() => {
    const params = { page, limit: PAGINATION.DEFAULT_LIMIT_STANDARD };
    if (riskLevel) params.riskLevel = riskLevel;
    if (status) params.status = status;
    dispatch(fetchFraudAlertsThunk(params));
  }, [dispatch, page, riskLevel, status, attempt]);

  return (
    <div>
      <PageHeader title="Fraud alerts" subtitle="Payments our engine flagged as suspicious, and why." />

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
              </li>
            ))}
          </ul>
        </BusyRegion>
      )}

      {!error && <Pagination page={page} limit={pagination.limit} total={pagination.total} onChange={setPage} />}
    </div>
  );
}
