/**
 * @file src/components/shared/AppShell.jsx
 * @description Sidebar + Navbar + routed content, shared by the three role layouts (D-P7-01).
 *   Content is wrapped in an ErrorBoundary keyed by the route, so a crash on one
 *   page does not survive navigation to another.
 *   F-05: a "Skip to main content" link (first tab stop) and focus moved to the page <h1> after
 *   every route change (utils/routeFocus.js; PageHeader does the focusing).
 */
import { Suspense, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Navbar from './Navbar.jsx';
import ErrorBoundary from '../common/ErrorBoundary.jsx';
import Spinner from '../common/Spinner.jsx';
import { requestRouteFocus } from '../../utils/routeFocus.js';

export default function AppShell({ navItems }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const mainRef = useRef(null);
  const firstRender = useRef(true);

  // A LAYOUT effect: it must run before the new page's PageHeader (a passive effect in the same
  // commit when the page chunk is already loaded) looks for the request.
  useLayoutEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; } // not on the initial load
    requestRouteFocus();
  }, [pathname]);

  const skipToMain = (e) => {
    e.preventDefault();
    mainRef.current?.focus();
  };

  return (
    <div className="min-h-screen bg-gray-50 bg-watch-grid">
      <a
        href="#main-content"
        onClick={skipToMain}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-700 focus:shadow-lg focus:ring-2 focus:ring-primary-500"
      >
        Skip to main content
      </a>
      <Sidebar navItems={navItems} open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="lg:pl-64">
        <Navbar onMenuClick={() => setMenuOpen(true)} />
        <main id="main-content" ref={mainRef} tabIndex={-1} className="mx-auto max-w-7xl px-4 py-6 sm:px-6 focus:outline-none">
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
