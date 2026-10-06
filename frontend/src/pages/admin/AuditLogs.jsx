/**
 * @file src/pages/admin/AuditLogs.jsx
 * @description Audit trail (local state + api, C-P7-04). GET /admin-api/audit-logs with filters
 *   actorRole, entityType, startDate, endDate (sent as IST bounds), page, limit 50.
 *   Item: { actorId: { name, email, role }, actorRole, action, entityType, entityId, metadata,
 *   ipAddress, timestamp }. Action badge colours come from the local ACTION_COLOR map.
 *   N-02: a failed load shows the error + Retry (not "No audit entries"); refetching dims the rows.
 */
import { useState } from 'react';
import api from '../../api/axios.js';
import { API_PATHS, PAGINATION, ROLES } from '../../utils/constants.js';
import { BTN, INPUT, TABLE, badgeClass, CASE_STATUS_COLORS, TX_STATUS_COLORS, RISK_COLORS, formatDate } from '../../utils/common.js';
import { dateRangeParams } from '../../utils/dates.js';
import { useFetch } from '../../hooks/useFetch.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Pagination from '../../components/common/Pagination.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import BusyRegion from '../../components/common/BusyRegion.jsx';

const ENTITY_TYPES = ['User', 'Transaction', 'FraudAlert', 'FraudCase', 'SystemConfig'];

// Look-up of complete class sets by keyword in the action name
const colorFor = (action = '') => {
  if (/DEACTIVATED|BLOCK|FAILED/.test(action)) return RISK_COLORS.CRITICAL;
  if (/THRESHOLD|SIMULATION|PASSWORD/.test(action)) return RISK_COLORS.MEDIUM;
  if (/CASE|NOTE/.test(action)) return CASE_STATUS_COLORS.UNDER_REVIEW;
  if (/ACTIVATED|LOGIN|REGISTER|SUBMITTED|PROFILE/.test(action)) return TX_STATUS_COLORS.APPROVED;
  return CASE_STATUS_COLORS.OPEN;
};

const EMPTY = { actorRole: '', entityType: '', startDate: '', endDate: '' };

export default function AuditLogs() {
  const [filters, setFilters] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [openRow, setOpenRow] = useState(null);

  const { data, loading, error, reload } = useFetch(async () => {
    const params = { page, limit: PAGINATION.DEFAULT_LIMIT_ADMIN, ...dateRangeParams(filters.startDate, filters.endDate) };
    if (filters.actorRole) params.actorRole = filters.actorRole;
    if (filters.entityType) params.entityType = filters.entityType;
    const res = await api.get(API_PATHS.ADMIN.AUDIT_LOGS, { params });
    return { logs: res.data.data, pagination: res.data.pagination };
  }, [page, filters]);

  const set = (k) => (e) => { setPage(1); setFilters((f) => ({ ...f, [k]: e.target.value })); };
  const logs = data?.logs ?? [];
  const pagination = data?.pagination ?? { page: 1, limit: PAGINATION.DEFAULT_LIMIT_ADMIN, total: 0 };

  return (
    <div>
      <PageHeader title="Audit logs" subtitle="Who did what, and when." />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label htmlFor="al-role" className={INPUT.label}>Actor role</label>
          <select id="al-role" className={INPUT.select} value={filters.actorRole} onChange={set('actorRole')}>
            <option value="">All</option>{Object.values(ROLES).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="al-entity" className={INPUT.label}>Entity type</label>
          <select id="al-entity" className={INPUT.select} value={filters.entityType} onChange={set('entityType')}>
            <option value="">All</option>{ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="al-from" className={INPUT.label}>From</label>
          <input id="al-from" type="date" className={INPUT.base} value={filters.startDate} max={filters.endDate || undefined} onChange={set('startDate')} />
        </div>
        <div>
          <label htmlFor="al-to" className={INPUT.label}>To</label>
          <input id="al-to" type="date" className={INPUT.base} value={filters.endDate} min={filters.startDate || undefined} onChange={set('endDate')} />
        </div>
        <div className="flex items-end">
          <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.md} w-full`} onClick={() => { setPage(1); setFilters(EMPTY); }}>Clear filters</button>
        </div>
      </div>

      {error ? (
        <LoadError message={error} onRetry={reload} />
      ) : loading && !data ? <Spinner /> : logs.length === 0 ? (
        <EmptyState title="No audit entries" message="Nothing matches these filters." />
      ) : (
        <BusyRegion busy={loading}>
          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <thead className={TABLE.thead}>
                <tr>{['Time', 'Actor', 'Action', 'Entity', 'IP', ''].map((h) => <th key={h || 'a'} className={TABLE.th}>{h}</th>)}</tr>
              </thead>
              <tbody className={TABLE.tbody}>
                {logs.map((l) => (
                  <tr key={l._id} className={TABLE.tr}>
                    <td className={TABLE.td}>{formatDate(l.timestamp)}</td>
                    <td className={TABLE.td}>{l.actorId?.name ?? '—'} <span className="text-xs text-gray-500">{l.actorRole}</span></td>
                    <td className={TABLE.td}><span className={badgeClass(colorFor(l.action))}>{l.action.replaceAll('_', ' ')}</span></td>
                    <td className={TABLE.td}>{l.entityType} <span className="text-gray-500">{l.entityId}</span></td>
                    <td className={TABLE.td}>{l.ipAddress ?? '—'}</td>
                    <td className={TABLE.td}>
                      {l.metadata && Object.keys(l.metadata).length > 0 && (
                        <button type="button" className={`${BTN.base} ${BTN.ghost} ${BTN.sm}`} aria-expanded={openRow === l._id} onClick={() => setOpenRow(openRow === l._id ? null : l._id)}>
                          {openRow === l._id ? 'Hide' : 'Details'}
                        </button>
                      )}
                      {openRow === l._id && (
                        <pre className="mt-2 max-w-md overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs text-gray-700">{JSON.stringify(l.metadata, null, 2)}</pre>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </BusyRegion>
      )}

      {!error && <Pagination page={page} limit={pagination.limit} total={pagination.total} onChange={setPage} />}
    </div>
  );
}
