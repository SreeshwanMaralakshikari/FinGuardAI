/**
 * @file src/Root.jsx
 * @description R4-02: chooses what renders under the router.
 *   "/" is the public landing page, rendered OUTSIDE the server wake gate so it appears at once while a
 *   sleeping backend starts (the page wakes it in the background). Every other route goes through
 *   <ServerWakeGate> and <App /> as before (Phase 9).
 */
import { Suspense, lazy } from 'react';
import { useLocation } from 'react-router-dom';
import App from './App.jsx';
import ServerWakeGate from './components/common/ServerWakeGate.jsx';
import Spinner from './components/common/Spinner.jsx';

const Landing = lazy(() => import('./pages/public/Landing.jsx'));

export default function Root() {
  const { pathname } = useLocation();
  if (pathname === '/') {
    return (
      <Suspense fallback={<Spinner className="min-h-screen" />}>
        <Landing />
      </Suspense>
    );
  }
  return (
    <ServerWakeGate>
      <App />
    </ServerWakeGate>
  );
}
