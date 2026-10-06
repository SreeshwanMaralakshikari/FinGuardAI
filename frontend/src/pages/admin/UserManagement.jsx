/**
 * @file src/pages/admin/UserManagement.jsx
 * @description Admin user list (local state + api — no Redux user slice, C-P7-04).
 *   GET /admin-api/users?role&isActive&search&page&limit(50) and
 *   PATCH /admin-api/users/:id/status with body { isActive: !currentActive } (C-P7-07).
 *   ADMIN accounts cannot be toggled (the API answers 403) and you cannot deactivate yourself.
 *   N-02: a failed load shows the error + Retry (not "No users found"); N-07: the confirm dialog
 *   cannot be dismissed while the request is running.
 */
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../api/axios.js';
import { getErrorMessage } from '../../api/errors.js';
import { useAppSelector } from '../../store/hooks.js';
import { API_PATHS, PAGINATION, ROLES } from '../../utils/constants.js';
import { BTN, INPUT, TABLE, badgeClass, CASE_STATUS_COLORS, TX_STATUS_COLORS, formatDate } from '../../utils/common.js';
import { useFetch } from '../../hooks/useFetch.js';
import PageHeader from '../../components/common/PageHeader.jsx';
import Pagination from '../../components/common/Pagination.jsx';
import EmptyState from '../../components/common/EmptyState.jsx';
import Spinner from '../../components/common/Spinner.jsx';
import Alert from '../../components/common/Alert.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import BusyRegion from '../../components/common/BusyRegion.jsx';
import Modal from '../../components/common/Modal.jsx';

export default function UserManagement() {
  const me = useAppSelector((s) => s.auth.user);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState(null); // user awaiting confirmation
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => { setPage(1); setQ(search.trim()); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const { data, loading, error, reload } = useFetch(async () => {
    const params = { page, limit: PAGINATION.DEFAULT_LIMIT_ADMIN };
    if (q) params.search = q;
    if (role) params.role = role;
    if (active) params.isActive = active;
    const res = await api.get(API_PATHS.ADMIN.USERS, { params });
    return { users: res.data.data, pagination: res.data.pagination };
  }, [page, q, role, active]);

  const confirm = async () => {
    setBusy(true);
    setActionError('');
    try {
      await api.patch(`${API_PATHS.ADMIN.TOGGLE_USER}/${target._id}/status`, { isActive: !target.isActive });
      toast.success(`${target.name} ${target.isActive ? 'deactivated' : 'activated'}`);
      setTarget(null);
      reload();
    } catch (err) {
      setActionError(getErrorMessage(err, 'Could not update the user'));
    } finally {
      setBusy(false);
    }
  };

  const users = data?.users ?? [];
  const pagination = data?.pagination ?? { page: 1, limit: PAGINATION.DEFAULT_LIMIT_ADMIN, total: 0 };

  return (
    <div>
      <PageHeader title="User management" subtitle="Search accounts and activate or deactivate them." />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="u-search" className={INPUT.label}>Search name or email</label>
          <input id="u-search" type="search" className={INPUT.base} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div>
          <label htmlFor="u-role" className={INPUT.label}>Role</label>
          <select id="u-role" className={INPUT.select} value={role} onChange={(e) => { setPage(1); setRole(e.target.value); }}>
            <option value="">All roles</option>
            {Object.values(ROLES).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="u-active" className={INPUT.label}>Status</label>
          <select id="u-active" className={INPUT.select} value={active} onChange={(e) => { setPage(1); setActive(e.target.value); }}>
            <option value="">All</option>
            <option value="true">Active</option>
            <option value="false">Deactivated</option>
          </select>
        </div>
      </div>

      {error ? (
        <LoadError message={error} onRetry={reload} />
      ) : loading && !data ? <Spinner /> : users.length === 0 ? (
        <EmptyState title="No users found" message="Try different filters." />
      ) : (
        <BusyRegion busy={loading}>
          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <thead className={TABLE.thead}>
                <tr>{['Name', 'Email', 'Role', 'Trust', 'Status', 'Joined', 'Last sign-in', ''].map((h) => <th key={h || 'a'} className={TABLE.th}>{h}</th>)}</tr>
              </thead>
              <tbody className={TABLE.tbody}>
                {users.map((u) => {
                  const locked = u.role === ROLES.ADMIN || u._id === me?.id;
                  return (
                    <tr key={u._id} className={TABLE.tr}>
                      <td className={TABLE.td}>{u.name}</td>
                      <td className={TABLE.td}>{u.email}</td>
                      <td className={TABLE.td}>{u.role}</td>
                      <td className={TABLE.td}>{u.trustScore}</td>
                      <td className={TABLE.td}>
                        <span className={badgeClass(u.isActive ? TX_STATUS_COLORS.APPROVED : CASE_STATUS_COLORS.DISMISSED)}>{u.isActive ? 'Active' : 'Deactivated'}</span>
                      </td>
                      <td className={TABLE.td}>{formatDate(u.createdAt)}</td>
                      <td className={TABLE.td}>{formatDate(u.lastLogin)}</td>
                      <td className={TABLE.td}>
                        <button
                          type="button"
                          disabled={locked}
                          aria-label={`${u.isActive ? 'Deactivate' : 'Activate'} ${u.name}`}
                          title={locked ? 'Admin accounts and your own account cannot be changed here' : undefined}
                          className={`${BTN.base} ${u.isActive ? BTN.secondary : BTN.primary} ${BTN.sm}`}
                          onClick={() => { setActionError(''); setTarget(u); }}
                        >
                          {u.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </BusyRegion>
      )}

      {!error && <Pagination page={page} limit={pagination.limit} total={pagination.total} onChange={setPage} />}

      <Modal
        open={target !== null}
        title={target?.isActive ? 'Deactivate user' : 'Activate user'}
        onClose={() => setTarget(null)}
        dismissible={!busy}
        footer={(
          <>
            <button type="button" disabled={busy} className={`${BTN.base} ${BTN.secondary} ${BTN.md}`} onClick={() => setTarget(null)}>Cancel</button>
            <button type="button" disabled={busy} className={`${BTN.base} ${target?.isActive ? BTN.danger : BTN.primary} ${BTN.md}`} onClick={confirm}>
              {busy ? 'Saving…' : target?.isActive ? 'Deactivate' : 'Activate'}
            </button>
          </>
        )}
      >
        <div className="space-y-3">
          <Alert tone="error">{actionError}</Alert>
          <p className="text-sm text-gray-700">
            {target?.isActive
              ? <>Deactivating <span className="font-semibold">{target?.name}</span> blocks their next requests immediately.</>
              : <>Re-activating <span className="font-semibold">{target?.name}</span> lets them sign in again.</>}
          </p>
        </div>
      </Modal>
    </div>
  );
}
