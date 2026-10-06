/**
 * @file src/components/shared/NotificationPanel.jsx
 * @description Bell + dropdown for CUSTOMER and ANALYST (ADMIN has no notifications — D-P4-09).
 *   Items are keyed and marked-read by `n._id` (AUD-08: live items are normalised to _id).
 *   N-15: the bell is a disclosure button (aria-expanded + aria-controls, no aria-haspopup); the panel
 *   closes on Escape (focus returns to the bell), on a click outside and when focus moves away;
 *   the unread dot carries visually hidden text. N-02: a failed load shows the error + Retry.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../../store/hooks.js';
import {
  fetchNotificationsThunk, markNotificationReadThunk, markAllReadThunk,
} from '../../store/slices/notificationSlice.js';
import { NOTIFICATION_COLORS, formatDate } from '../../utils/common.js';
import { PAGINATION } from '../../utils/constants.js';
import Icon from '../common/Icon.jsx';

const PANEL_ID = 'notification-panel';

/** Where a notification should take the user. */
function targetFor(n, role) {
  if (n.relatedEntityType === 'FRAUD_CASE' && n.relatedEntityId) return `/analyst/cases/${n.relatedEntityId}`;
  if (role === 'CUSTOMER') return '/customer/fraud-alerts';
  return null;
}

export default function NotificationPanel() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const role = useAppSelector((s) => s.auth.user?.role);
  const { notifications, unreadCount, loading, error } = useAppSelector((s) => s.notifications);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const bellRef = useRef(null);

  const load = useCallback(() => {
    dispatch(fetchNotificationsThunk({ limit: PAGINATION.DEFAULT_LIMIT_CASES }));
  }, [dispatch]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      bellRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onItem = (n) => {
    if (!n.isRead) dispatch(markNotificationReadThunk(n._id));
    const to = targetFor(n, role);
    setOpen(false);
    if (to) navigate(to);
  };

  // Focus moving to another focusable element outside the widget closes it (a click on plain
  // text inside has no relatedTarget and must not).
  const onBlur = (e) => {
    if (open && e.relatedTarget && !rootRef.current?.contains(e.relatedTarget)) setOpen(false);
  };

  return (
    <div className="relative" ref={rootRef} onBlur={onBlur}>
      <button
        ref={bellRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-lg p-2 text-gray-600 hover:bg-gray-100"
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
        aria-controls={PANEL_ID}
      >
        <Icon name="bell" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-bold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div id={PANEL_ID} className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white shadow-lg" role="region" aria-label="Notifications">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <p className="text-sm font-semibold text-gray-900">Notifications</p>
            <button
              type="button"
              className="text-xs font-medium text-primary-600 hover:underline disabled:text-gray-400 disabled:no-underline"
              disabled={unreadCount === 0}
              onClick={() => dispatch(markAllReadThunk())}
            >
              Mark all read
            </button>
          </div>
          <ul className="max-h-96 divide-y divide-gray-100 overflow-y-auto">
            {error && (
              <li className="flex items-center justify-between gap-3 px-4 py-4 text-sm text-red-700" role="alert">
                <span>{error}</span>
                <button type="button" className="shrink-0 text-xs font-medium text-primary-600 hover:underline" onClick={load}>Retry</button>
              </li>
            )}
            {!error && loading && notifications.length === 0 && <li className="px-4 py-6 text-center text-sm text-gray-500">Loading…</li>}
            {!error && !loading && notifications.length === 0 && <li className="px-4 py-6 text-center text-sm text-gray-500">You’re all caught up.</li>}
            {notifications.map((n) => (
              <li key={n._id}>
                <button
                  type="button"
                  onClick={() => onItem(n)}
                  className={`flex w-full gap-3 px-4 py-3 text-left hover:bg-gray-50 ${n.isRead ? '' : 'bg-primary-50/60'}`}
                >
                  <span className={`mt-0.5 ${NOTIFICATION_COLORS[n.type]?.icon ?? 'text-gray-500'}`}>
                    <Icon name={n.type === 'FRAUD_ALERT' ? 'alert' : 'briefcase'} className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900">{n.title}</span>
                    <span className="mt-0.5 block text-xs text-gray-600">{n.message}</span>
                    <span className="mt-1 block text-[11px] text-gray-500">{formatDate(n.createdAt)}</span>
                  </span>
                  {!n.isRead && (
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary-600">
                      <span className="sr-only">Unread</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
