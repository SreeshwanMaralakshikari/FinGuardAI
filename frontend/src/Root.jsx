/**
 * @file src/Root.jsx
 * @description R4-02: chooses what renders under the router.
 *   "/" (landing page) and "/model" (R4-09 model card) are public pages, rendered OUTSIDE the server wake gate
 *   so they appear at once while a sleeping backend starts (the landing page wakes it in the background). Every other route goes through
 *   <ServerWakeGate> and <App /> as before (Phase 9).
 */
import { Suspense, lazy } from 'react';
import { useLocation } from 'react-router-dom';
import App from './App.jsx';
import ServerWakeGate from './components/common/ServerWakeGate.jsx';
import Spinner from './components/common/Spinner.jsx';

const Landing = lazy(() => import('./pages/public/Landing.jsx'));
const ModelCard = lazy(() => import('./pages/public/ModelCard.jsx'));

/** Static public pages: no session, no API call needed to show them. */
const PUBLIC_PAGES = { '/': Landing, '/model': ModelCard };

export default function Root() {
  const { pathname } = useLocation();
  const Page = PUBLIC_PAGES[pathname.replace(/(.)\/+$/, '$1')];
  if (Page) {
    return (
      <Suspense fallback={<Spinner className="min-h-screen" />}>
        <Page />
      </Suspense>
    );
  }
  return (
    <ServerWakeGate>
      <App />
    </ServerWakeGate>
  );
}
