/**
 * @file src/pages/analyst/FraudPatterns.jsx
 * @description Shared IP / shared device / repeat high-risk merchant clusters (HIGH + CRITICAL
 *   transactions only). Each cluster reports `userCount`: a "shared" cluster with userCount 1 is
 *   one customer's repeated attempts, not several accounts sharing a device or IP (AUD-39).
 *   Cluster transaction items use `id` (not `_id`); the API lists at most 10 per cluster, so a cluster
 *   with a larger `count` says "Showing 10 of N" (N-21). N-02: a failed load shows error + Retry.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/axios.js';
import { API_PATHS } from '../../utils/constants.js';
import { BTN, CARD, formatCurrency, formatDate } from '../../utils/common.js';
import { useFetch } from '../../hooks/useFetch.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import { RiskBadge } from '../../components/common/Badges.jsx';

function ClusterList({ title, hint, clusters, keyField, renderKey }) {
  const [openKey, setOpenKey] = useState(null);
  return (
    <section aria-label={title}>
      <h2 className="text-base font-semibold text-gray-900">{title}</h2>
      <p className="mb-3 mt-0.5 text-sm text-gray-500">{hint}</p>
      {clusters.length === 0 ? <EmptyState title="No clusters found" /> : (
        <ul className="space-y-3">
          {clusters.map((c) => {
            const key = c[keyField];
            const expanded = openKey === key;
            return (
              <li key={key} className={`${CARD.base} p-4`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-all text-sm font-semibold text-gray-900">{renderKey(c)}</p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {c.count} high-risk transactions ·{' '}
                      {c.userCount > 1
                        ? <span className="font-semibold text-red-600">{c.userCount} different customers</span>
                        : <span>1 customer (repeated attempts, not a shared pattern)</span>}
                    </p>
                  </div>
                  <button type="button" className={`${BTN.base} ${BTN.ghost} ${BTN.sm}`} onClick={() => setOpenKey(expanded ? null : key)} aria-expanded={expanded}>
                    {expanded ? 'Hide' : 'Show'} transactions
                  </button>
                </div>
                {expanded && (
                  <>
                    {c.count > c.transactions.length && (
                      <p className="mt-3 text-xs text-gray-500">Showing {c.transactions.length} of {c.count} transactions</p>
                    )}
                    <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-100">
                      {c.transactions.map((t) => (
                        <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span className="text-gray-700">{t.publicId}</span>
                          <span className="text-gray-700">{formatCurrency(t.amount)}</span>
                          <RiskBadge level={t.riskLevel} />
                          <span className="text-xs text-gray-500">{formatDate(t.timestamp)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default function FraudPatterns() {
  const { data, loading, error, reload } = useFetch(
    async () => (await api.get(API_PATHS.ANALYST.FRAUD_PATTERNS)).data.data,
    [],
  );

  return (
    <div>
      <PageHeader
        title="Fraud patterns"
        subtitle="Links between high-risk transactions: same IP, same device, same merchant."
        actions={<button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.sm}`} onClick={reload}>Refresh</button>}
      />
      {loading && <Spinner />}
      <LoadError message={error} onRetry={reload} />
      {data && !loading && (
        <div className="space-y-10">
          <ClusterList
            title="Shared IP addresses"
            hint="The same IP address behind two or more high-risk transactions."
            clusters={data.sharedIpClusters ?? []}
            keyField="ipAddress"
            renderKey={(c) => c.ipAddress}
          />
          <ClusterList
            title="Shared devices"
            hint="The same device fingerprint behind two or more high-risk transactions."
            clusters={data.sharedDeviceClusters ?? []}
            keyField="deviceId"
            renderKey={(c) => (
              <Link className="text-primary-600 hover:underline" to={`/analyst/device-reputation?deviceId=${encodeURIComponent(c.deviceId)}`}>{c.deviceId}</Link>
            )}
          />
          <ClusterList
            title="High-risk merchants"
            hint="Merchants with three or more high-risk transactions."
            clusters={data.highRiskMerchantClusters ?? []}
            keyField="merchantName"
            renderKey={(c) => c.merchantName}
          />
        </div>
      )}
    </div>
  );
}
