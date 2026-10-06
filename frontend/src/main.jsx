/**
 * @file src/main.jsx
 * @description React 19 entry point.
 *   - Uses createRoot() API (React 18+/19 standard)
 *   - Wraps app in Redux Provider and BrowserRouter
 *   - [P9] <ServerWakeGate> delays <App /> (and its checkAuthThunk) until the
 *     backend answers /health — handles Render cold starts
 *   - Toaster stays outside the gate so toasts work on every screen
 *   - [P9] 'vite:preloadError' handler reloads once after a redeploy
 * @phase Phase 6 (original) → Phase 9 (ServerWakeGate) [P9]
 * @decision D-P6-08
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';

import { store } from './store/index.js';
import App from './App.jsx';
import ServerWakeGate from './components/common/ServerWakeGate.jsx'; // [P9]

import './index.css';

// [P9] Stale-chunk recovery. Every page is lazy-loaded (D-P6-09). After a
// redeploy, the hashed chunk files of the previous build no longer exist on
// Vercel, so a tab opened before the deploy fails when it navigates to a page
// it has not loaded yet. Reload once to pick up the new index.html. The
// timestamp guard prevents a reload loop if the chunk is genuinely broken.
const CHUNK_RELOAD_KEY = 'finguard:chunk-reload-at';
const CHUNK_RELOAD_GUARD_MS = 10_000;

window.addEventListener('vite:preloadError', (event) => {
  try {
    const lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0);
    if (Date.now() - lastReload < CHUNK_RELOAD_GUARD_MS) return; // just reloaded — let the error surface
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    return; // storage unavailable → cannot guard against loops, so don't auto-reload
  }
  event.preventDefault();
  window.location.reload();
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Provider store={store}>
      <BrowserRouter>
        <ServerWakeGate>
          <App />
        </ServerWakeGate>
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              borderRadius: '8px',
              background: '#1e293b',
              color: '#f1f5f9',
              fontSize: '14px',
            },
            success: { iconTheme: { primary: '#22c55e', secondary: '#fff' } },
            error:   { iconTheme: { primary: '#ef4444', secondary: '#fff' } },
          }}
        />
      </BrowserRouter>
    </Provider>
  </StrictMode>,
);
