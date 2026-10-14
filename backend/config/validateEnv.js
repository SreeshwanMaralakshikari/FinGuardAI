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
 *   ANALYST_INVITE_CODE (L-11), PORT and the invite-code length in every mode (D-10),
 *   secure-by-default NODE_ENV (D-03: anything but development|test is production-like),
 *   ML_ENABLED / ML_SERVICE_URL / ML_API_KEY / ML_TIMEOUT_MS / ML_COOLDOWN_MS (Phase 10).
 * @phase Phase 9 — Deployment
 */
import { COOKIE_MODES } from './cookieOptions.js';
import { getMongoDbName } from './mongoUri.js';
import { isValidTimeZone } from './timeZone.js';
import { isProductionLike } from './environment.js';
import { validateOpsSettings } from './opsSettings.js';
import { validateMlSettings } from './mlSettings.js';

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
 * R-07: warnings about NODE_ENV itself — unset or anything but development / test / production is treated as
 * production-like (D-03), which surprises local developers (Secure cookies, no localhost CORS).
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]}
 */
export const getNodeEnvWarnings = (env = process.env) => {
  const raw = (env.NODE_ENV ?? '').trim();
  if (['development', 'test', 'production'].includes(raw.toLowerCase())) return [];
  return [
    `NODE_ENV is ${raw ? `"${raw}"` : 'not set'}, so production rules apply (Secure cookies, no localhost CORS origins) — ` +
    'for local development set NODE_ENV=development in .env',
  ];
};

/**
 * Throws an Error listing every problem found (not just the first one).
 * Non-fatal findings are printed with console.warn.
 * @returns {void}
 */
const validateEnv = () => {
  for (const warning of getNodeEnvWarnings(process.env)) console.warn(`[validateEnv] WARNING: ${warning}`);

  // D-03: production-like unless NODE_ENV is exactly 'development' or 'test'.
  const isProduction = isProductionLike();
  const required = isProduction
    ? [...ALWAYS_REQUIRED, ...PRODUCTION_REQUIRED]
    : ALWAYS_REQUIRED;

  const problems = required
    .filter((key) => !process.env[key] || !process.env[key].trim())
    .map((key) => `${key} is missing`);
  if (problems.length > 0 && !(process.env.NODE_ENV ?? '').trim()) {
    // D-03: an unset NODE_ENV is production-like, which is what makes a local checkout without
    // a .env complain about Cloudinary / FRONTEND_URL — say how to opt into development.
    problems.push('NODE_ENV is not set, so production rules apply — for local development set NODE_ENV=development in .env');
  }

  // D-05: Render always sets RENDER=true. Without NODE_ENV=production the
  // cookie silently becomes SameSite=Lax/not Secure and every request after
  // login 401s from the Vercel site. (Exactly 'production' is required here:
  // Render deployments must be explicit, even though D-03 is secure by default.)
  if (process.env.RENDER && (process.env.NODE_ENV ?? '').trim().toLowerCase() !== 'production') {
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
  // D-10: when a code is set, its minimum length applies in EVERY mode (as the README says);
  // only the "not set" warning is production-only.
  const inviteCode = process.env.ANALYST_INVITE_CODE ?? '';
  if (inviteCode.trim()) {
    if (inviteCode.trim().length < MIN_INVITE_CODE_LENGTH) {
      problems.push(`ANALYST_INVITE_CODE must be at least ${MIN_INVITE_CODE_LENGTH} characters`);
    }
  } else if (isProduction) {
    console.warn('[validateEnv] WARNING: ANALYST_INVITE_CODE is not set — analyst registration is disabled');
  }

  // D-10: `PORT=abc` used to fall back to 5000 silently (Number(x) || 5000).
  const port = (process.env.PORT ?? '').trim();
  if (port && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    problems.push(`PORT must be an integer between 1 and 65535 (got "${process.env.PORT}")`);
  }

  // C-04 / C-08: retention and device-cap settings.
  problems.push(...validateOpsSettings(process.env));

  // Phase 10: ML scoring service (only checked when ML_ENABLED=true).
  problems.push(...validateMlSettings(process.env));

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
