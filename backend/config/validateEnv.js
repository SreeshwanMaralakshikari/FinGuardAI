/**
 * @file config/validateEnv.js
 * @description Fail-fast validation of required environment variables.
 *   Called once from server.js before connecting to MongoDB. A missing or
 *   unsafe variable on Render then produces one clear log line and a failed
 *   deploy, instead of a server that boots and breaks (or runs insecurely).
 *
 *   Fix-round additions: APP_TIME_ZONE (N-11), COOKIE_MODE / COOKIE_DOMAIN
 *   (D-02), database name in MONGODB_URI (D-04), RENDER without
 *   NODE_ENV=production (D-05), placeholder JWT_SECRET (D-10),
 *   ANALYST_INVITE_CODE (L-11).
 * @phase Phase 9 — Deployment
 */
import { COOKIE_MODES } from './cookieOptions.js';
import { getMongoDbName } from './mongoUri.js';
import { isValidTimeZone } from './timeZone.js';

const ALWAYS_REQUIRED = ['MONGODB_URI', 'JWT_SECRET'];

const PRODUCTION_REQUIRED = [
  'FRONTEND_URL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];

const MIN_JWT_SECRET_LENGTH = 32;
const MIN_INVITE_CODE_LENGTH = 8;
const HOSTNAME_PATTERN = /^\.?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * Throws an Error listing every problem found (not just the first one).
 * Non-fatal findings are printed with console.warn.
 * @returns {void}
 */
const validateEnv = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  const required = isProduction
    ? [...ALWAYS_REQUIRED, ...PRODUCTION_REQUIRED]
    : ALWAYS_REQUIRED;

  const problems = required
    .filter((key) => !process.env[key] || !process.env[key].trim())
    .map((key) => `${key} is missing`);

  // D-05: Render always sets RENDER=true. Without NODE_ENV=production the
  // cookie silently becomes SameSite=Lax/not Secure and every request after
  // login 401s from the Vercel site.
  if (process.env.RENDER && !isProduction) {
    problems.push(
      `NODE_ENV must be "production" on Render (it is "${process.env.NODE_ENV ?? ''}") — ` +
      'without it cookies are not Secure/SameSite=None and login breaks'
    );
  }

  const secret = process.env.JWT_SECRET ?? '';
  if (isProduction && secret) {
    if (secret.length < MIN_JWT_SECRET_LENGTH) {
      problems.push(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters in production`);
    }
    // D-10: the .env.example placeholder is 33 characters long and public.
    if (/replace-with|change-me|changeme/i.test(secret)) {
      problems.push('JWT_SECRET is still the placeholder from .env.example — generate a random one');
    }
  }

  // A connection string copied from a template still contains <password> / <db>.
  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri && /[<>]/.test(mongoUri)) {
    problems.push('MONGODB_URI still contains a <placeholder> — replace <password> / <dbname> with real values');
  }

  // D-04: an Atlas URI without a database name silently uses "test".
  if (mongoUri && mongoUri.trim() && !getMongoDbName(mongoUri)) {
    const message = 'MONGODB_URI has no database name (…mongodb.net/<dbname>?…) — the driver would silently use "test"';
    if (isProduction) problems.push(message);
    else console.warn(`[validateEnv] WARNING: ${message}`);
  }

  // N-11: an invalid zone would make every $hour/$dateToString aggregation fail.
  const zone = process.env.APP_TIME_ZONE;
  if (zone !== undefined && zone.trim() !== '' && !isValidTimeZone(zone.trim())) {
    problems.push(`APP_TIME_ZONE "${zone}" is not a valid IANA time zone (e.g. Asia/Kolkata)`);
  }

  // D-02: cookie topology.
  const rawMode = (process.env.COOKIE_MODE ?? '').trim().toLowerCase();
  if (rawMode && !COOKIE_MODES.includes(rawMode)) {
    problems.push(`COOKIE_MODE must be one of: ${COOKIE_MODES.join(', ')} (got "${process.env.COOKIE_MODE}")`);
  }
  const cookieDomain = (process.env.COOKIE_DOMAIN ?? '').trim();
  if (cookieDomain) {
    if (!HOSTNAME_PATTERN.test(cookieDomain)) {
      problems.push(`COOKIE_DOMAIN must be a bare domain such as ".example.com" (got "${cookieDomain}")`);
    } else if (isProduction && rawMode !== 'same-site') {
      console.warn('[validateEnv] WARNING: COOKIE_DOMAIN is ignored unless COOKIE_MODE=same-site');
    }
  }

  // L-11: analyst self-registration is gated by an invite code.
  const inviteCode = process.env.ANALYST_INVITE_CODE ?? '';
  if (isProduction) {
    if (!inviteCode.trim()) {
      console.warn('[validateEnv] WARNING: ANALYST_INVITE_CODE is not set — analyst registration is disabled');
    } else if (inviteCode.trim().length < MIN_INVITE_CODE_LENGTH) {
      problems.push(`ANALYST_INVITE_CODE must be at least ${MIN_INVITE_CODE_LENGTH} characters`);
    }
  }

  if (isProduction && process.env.FRONTEND_URL) {
    // Each entry must be a bare https origin — exactly what browsers send in
    // the Origin header (no path, no trailing slash), or it will never match.
    const isHttpsOrigin = (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.origin === value;
      } catch {
        return false;
      }
    };
    const invalid = process.env.FRONTEND_URL
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o && !isHttpsOrigin(o));
    if (invalid.length > 0) {
      problems.push(
        `FRONTEND_URL entries must be https origins with no path or trailing slash: ${invalid.join(', ')}`
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
  }
};

export default validateEnv;
