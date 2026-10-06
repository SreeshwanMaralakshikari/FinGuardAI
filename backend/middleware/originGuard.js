/**
 * @file middleware/originGuard.js
 * @description CSRF defence for cross-site cookies.
 *
 *   With SameSite=None the browser attaches the auth cookie to requests made
 *   by ANY site — including a malicious page that auto-submits an HTML form
 *   to POST /customer-api/transactions. CORS does not stop that: the request
 *   is still sent and processed; CORS only hides the response.
 *
 *   Browsers always send an Origin header on cross-site POST/PATCH/PUT/DELETE,
 *   so for state-changing methods we reject any request whose Origin is not
 *   on the allowlist. Requests without an Origin header (curl, Postman,
 *   server-to-server) are not browser CSRF vectors and are allowed.
 * @phase Phase 9 — Deployment
 */
import { isOriginAllowed } from '../config/corsOptions.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const originGuard = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  if (!origin || isOriginAllowed(origin)) return next();

  return res.status(403).json({
    success: false,
    message: 'Request origin is not allowed.',
  });
};

export default originGuard;
