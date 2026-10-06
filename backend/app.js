/**
 * @file app.js
 * @description Express app factory — registers security middleware, CORS,
 *   CSRF origin guard, body/cookie parsers, health check, all 5 routers,
 *   JSON 404 and the global error handler. Exported without listen() so
 *   server.js (production) and Supertest (Phase 8) share the same app.
 * @phase Phase 4 (original) → Phase 9 (deployment changes marked [P9])
 */
import { readFileSync } from 'node:fs';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';

import { corsOptions } from './config/corsOptions.js';          // [P9]
import originGuard from './middleware/originGuard.js';          // [P9]
import CommonAPI from './routes/CommonAPI.js';
import CustomerAPI from './routes/CustomerAPI.js';
import AnalystAPI from './routes/AnalystAPI.js';
import AdminAPI from './routes/AdminAPI.js';
import NotificationAPI from './routes/NotificationAPI.js';
import errorHandler from './middleware/errorHandler.js';

const app = express();

// D-11: the version reported by /health. Read once; never fails the app.
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

// [P9] Render terminates TLS at its load balancer and forwards the request.
// Trusting exactly one proxy hop makes req.ip the real client IP (used by
// express-rate-limit keys and audit logs) and req.secure reflect HTTPS.
// Without this, every user shares the proxy's IP → one shared rate limit.
// Verify after deploy: the ipAddress in your USER_LOGIN audit log entry must
// equal your public IP. If it does not, set TRUST_PROXY to the hop count.
const isProduction = process.env.NODE_ENV === 'production';
const parseTrustProxy = () => {
  const hops = Number.parseInt(process.env.TRUST_PROXY ?? '', 10);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  return isProduction ? 1 : 0; // unset / invalid → safe default
};
app.set('trust proxy', parseTrustProxy());

// [P9] The API is consumed from a different site (Vercel), so resources must
// be readable cross-origin. All other helmet defaults stay on.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// [P9] Shared allowlist (FRONTEND_URL, comma-separated). Handles preflight
// OPTIONS automatically.
app.use(cors(corsOptions));

// [P9] CSRF defence required once the cookie is SameSite=None.
app.use(originGuard);

// The API speaks JSON (and multipart for the profile image, handled by multer
// inside that route) — there is no urlencoded form endpoint, so
// express.urlencoded was removed (L-15).
app.use(express.json());
// Express 5 leaves req.body undefined when a request has no body; handlers and
// validators destructure it, which turned e.g. an empty PATCH into a 500 (L-13).
app.use((req, res, next) => {
  req.body ??= {};
  next();
});
app.use(cookieParser());

// D-11: uptime monitors usually probe "/" — answer 200 instead of the JSON 404.
app.get('/', (req, res) => {
  res.status(200).json({ success: true, name: 'FinGuardAI API', status: 'ok' });
});

// [P9] Health check — used by Render (healthCheckPath) and by the frontend's
// cold-start wake-up gate. Returns 503 until MongoDB is connected so Render
// never routes traffic to an instance that cannot serve requests.
app.get('/health', (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.set('Cache-Control', 'no-store');
  res.status(dbConnected ? 200 : 503).json({
    success: dbConnected,
    status: dbConnected ? 'ok' : 'degraded',
    version: APP_VERSION,
    database: dbConnected ? 'connected' : 'disconnected',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.use('/auth',             CommonAPI);
app.use('/customer-api',     CustomerAPI);
app.use('/analyst-api',      AnalystAPI);
app.use('/admin-api',        AdminAPI);
app.use('/notification-api', NotificationAPI);

// [P9] JSON 404 for unknown routes (Express 5 default is an HTML page).
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use(errorHandler);

export default app;
