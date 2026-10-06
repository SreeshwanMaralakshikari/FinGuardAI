/**
 * @file src/layouts/CustomerLayout.jsx
 * @description CUSTOMER shell. Starts live notifications once per session (D-P7-02)
 *   and loads the unread badge.
 */
import { useEffect } from 'react';
import { useAppDispatch } from '../store/hooks.js';
import { fetchUnreadCountThunk } from '../store/slices/notificationSlice.js';
import { useNotifications } from '../hooks/useNotifications.js';
import AppShell from '../components/shared/AppShell.jsx';
import { CUSTOMER_NAV } from '../utils/navigation.js';

export default function CustomerLayout() {
  const dispatch = useAppDispatch();
  useNotifications();

  useEffect(() => {
    dispatch(fetchUnreadCountThunk());
  }, [dispatch]);

  return <AppShell navItems={CUSTOMER_NAV} />;
}
