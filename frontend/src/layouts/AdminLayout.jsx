/**
 * @file src/layouts/AdminLayout.jsx
 * @description ADMIN shell. Opens the admin socket (fraud_alert, simulation_*) via
 *   useSocket() — NOT useNotifications(): ADMIN has no notification feed (D-P4-09).
 */
import { useSocket } from '../hooks/useSocket.js';
import AppShell from '../components/shared/AppShell.jsx';
import { ADMIN_NAV } from '../utils/navigation.js';

export default function AdminLayout() {
  useSocket();
  return <AppShell navItems={ADMIN_NAV} />;
}
