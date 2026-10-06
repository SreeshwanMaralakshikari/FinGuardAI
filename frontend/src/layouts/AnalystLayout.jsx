/**
 * @file src/layouts/AnalystLayout.jsx
 * @description ANALYST shell. Live notifications + unread badge (D-P7-02).
 */
import { useEffect } from 'react';
import { useAppDispatch } from '../store/hooks.js';
import { fetchUnreadCountThunk } from '../store/slices/notificationSlice.js';
import { useNotifications } from '../hooks/useNotifications.js';
import AppShell from '../components/shared/AppShell.jsx';
import { ANALYST_NAV } from '../utils/navigation.js';

export default function AnalystLayout() {
  const dispatch = useAppDispatch();
  useNotifications();

  useEffect(() => {
    dispatch(fetchUnreadCountThunk());
  }, [dispatch]);

  return <AppShell navItems={ANALYST_NAV} />;
}
