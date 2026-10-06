/**
 * @file src/components/shared/AppShell.jsx
 * @description Sidebar + Navbar + routed content, shared by the three role layouts (D-P7-01).
 *   Content is wrapped in an ErrorBoundary keyed by the route, so a crash on one
 *   page does not survive navigation to another.
 */
import { Suspense, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Navbar from './Navbar.jsx';
import ErrorBoundary from '../common/ErrorBoundary.jsx';
import Spinner from '../common/Spinner.jsx';

export default function AppShell({ navItems }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar navItems={navItems} open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="lg:pl-64">
        <Navbar onMenuClick={() => setMenuOpen(true)} />
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
          <ErrorBoundary key={pathname}>
            <Suspense fallback={<Spinner />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
