/**
 * @file config/loadEnv.js
 * @description Loads variables from a local .env file into process.env and
 *   fixes the process time zone. MUST be the very first import in server.js
 *   (and seed/seedAdmin.js). ES Module imports are hoisted and evaluated in
 *   order, so any module that reads process.env at import time
 *   (cloudinary.js, app.js) only sees the values if this runs first.
 *
 *   - Local dev: reads finguardai-backend/.env
 *   - Render:    no .env file exists; variables come from the dashboard.
 *                dotenv never overrides a variable that is already set.
 *   - Time zone: process.env.TZ is ALWAYS set to APP_TIME_ZONE (default
 *                Asia/Kolkata), even when the host presets TZ=UTC (N-11:
 *                `||=` used to let a preset TZ silently win). Business code
 *                also formats with Intl + APP_TIME_ZONE explicitly
 *                (config/timeZone.js), so this only keeps logs consistent.
 *                An invalid APP_TIME_ZONE is reported by validateEnv.
 * @phase Phase 9 — Deployment (TZ added in the Phase 1–9 audit)
 */
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const { APP_TIME_ZONE } = await import('./timeZone.js'); // after dotenv, so APP_TIME_ZONE from .env is honoured
process.env.TZ = APP_TIME_ZONE;
