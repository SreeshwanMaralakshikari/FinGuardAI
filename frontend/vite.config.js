/**
 * @file vite.config.js
 * @description Vite 8 configuration for FinGuardAI frontend.
 *   - @tailwindcss/vite plugin (Tailwind CSS v4, no PostCSS needed)
 *   - DEV: proxies /api/* → backend (prefix stripped) and /socket.io → backend
 *     (WebSocket upgrade enabled), so the browser only ever talks to
 *     localhost:3000 — same origin, no CORS, first-party cookie.
 *   - BUILD (any mode): fails fast if VITE_API_URL is missing or not a bare https origin
 *     (VITE_SOCKET_URL too, when set), because the value is baked into the bundle at build time.
 * @phase Phase 6 (original) → Phase 9 (env-aware proxy + build guard) [P9]
 * @decision D-P6-18
 */

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Abort a build that would bake a missing / malformed backend URL into the bundle (N-23).
 * Runs for EVERY `vite build`, whatever the mode (a `--mode staging` build used to skip it and
 * ship an empty URL). Requires a bare origin: https://host[:port], no path, no trailing slash,
 * no spaces. http://localhost / 127.0.0.1 is accepted only outside `production` mode.
 * The dev server (`vite`, `vite preview`) is not checked — it proxies and needs no URL.
 * @param {string|undefined} value  the value of the variable
 * @param {string} mode             vite mode
 * @param {string} [name]           variable name used in messages
 */
export function assertBuildApiUrl(value, mode, name = 'VITE_API_URL') {
  if (!value) {
    throw new Error(
      `[vite.config] ${name} is not set. Add it in Vercel → Project → Settings → ` +
      'Environment Variables (e.g. https://finguardai-api.onrender.com) and redeploy.',
    );
  }
  if (/\s/.test(value)) {
    throw new Error(`[vite.config] ${name} must not contain spaces (got "${value}").`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`[vite.config] ${name} is not a valid URL: "${value}"`);
  }

  const isLocal = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  const localHttpAllowed = isLocal && parsed.protocol === 'http:' && mode !== 'production';
  if (parsed.protocol !== 'https:' && !localHttpAllowed) {
    throw new Error(
      `[vite.config] ${name} must use https:// (got "${value}"). ` +
      'Secure, SameSite=None cookies are only sent over HTTPS' +
      `${isLocal ? '; http://localhost is only allowed in non-production modes' : ''}.`,
    );
  }
  if (value.endsWith('/') || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password
    || value !== parsed.origin /* catches "https://x.com?", "HTTPS://…", ":443" */) {
    throw new Error(
      `[vite.config] ${name} must be a bare origin like https://api.example.com — ` +
      `no path, query, credentials, trailing slash or default port, lower-case (got "${value}").`,
    );
  }
}

export default defineConfig(({ command, mode }) => {
  // Loads .env, .env.[mode], .env.[mode].local AND matching process.env
  // variables (Vercel injects dashboard variables into process.env).
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const devBackend = env.VITE_DEV_BACKEND_URL || 'http://localhost:5000';

  if (command === 'build') {
    assertBuildApiUrl(env.VITE_API_URL, mode);
    if (env.VITE_SOCKET_URL) assertBuildApiUrl(env.VITE_SOCKET_URL, mode, 'VITE_SOCKET_URL');
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
    ],

    server: {
      port: 3000,
      strictPort: true, // backend CORS/dev defaults expect exactly :3000
      proxy: {
        '/api': {
          target: devBackend,
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
        // [P9] Socket.io in dev goes through the same origin as the page
        '/socket.io': {
          target: devBackend,
          changeOrigin: true,
          ws: true,
        },
      },
    },

    preview: {
      port: 4173,
    },

    build: {
      outDir: 'dist',
      sourcemap: false, // N-23: no .map files in the public bundle
      // [P9 — C-P9-02] Vite 8 bundles with Rolldown, which does NOT support
      // Rollup's object form of `manualChunks` (the Phase 6 config failed
      // `vite build` with "TypeError: manualChunks is not a function").
      // `rolldownOptions.output.codeSplitting.groups` is the Vite 8 equivalent
      // and produces the same three vendor chunks.
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'vendor',
                test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
                priority: 30,
              },
              {
                name: 'redux',
                test: /[\\/]node_modules[\\/](@reduxjs[\\/]toolkit|react-redux|redux|redux-thunk|immer|reselect)[\\/]/,
                priority: 20,
              },
              {
                name: 'charts',
                test: /[\\/]node_modules[\\/](recharts|recharts-scale|victory-vendor|d3-[^\\/]+)[\\/]/,
                priority: 10,
              },
            ],
          },
        },
      },
    },
  };
});
