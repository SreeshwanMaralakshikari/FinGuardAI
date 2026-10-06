# FinGuardAI: Intelligent Fraud Detection System

MERN application that scores every payment for fraud risk in real time. Three roles: **CUSTOMER** (submit payments, see alerts and trust score), **ANALYST** (investigate flagged transactions, manage cases), **ADMIN** (analytics, users, thresholds, audit log, simulation).

```
finguardai-backend/    Express 5 · Mongoose 9 · Socket.io · Jest          (deploy: Render)
finguardai-frontend/   React 19 · Vite 8 · Tailwind 4 · Redux Toolkit · Vitest   (deploy: Vercel)
docs/                  Notes from the frontend build
FIX_LOG.md             What was fixed in the two review rounds, and what is still open
```

## Requirements
- Node 24 (see `finguardai-backend/.nvmrc`; Node 22 also ran the tests), npm 10+
- MongoDB (Atlas or local) and, for profile pictures, a Cloudinary account

## Run locally
```bash
# 1. Backend
cd finguardai-backend
cp .env.example .env            # then edit: MONGODB_URI (with a database name), JWT_SECRET, CLOUDINARY_*
npm ci
npm run seed:admin              # creates the ADMIN user and the SystemConfig document
npm run dev                     # http://localhost:5000

# 2. Frontend (second terminal)
cd finguardai-frontend
npm ci
npm run dev                     # http://localhost:3000, proxies /api and /socket.io to :5000
```
To let people register as **ANALYST** set `ANALYST_INVITE_CODE` (8+ characters) in the backend `.env`; without it analyst sign-up is disabled (403). Customers can always register.

## Test
```bash
cd finguardai-backend  && npm test        # 231 tests, needs mongodb-memory-server OR MONGO_URI_TEST
cd finguardai-frontend && npm run lint && npm test && VITE_API_URL=https://example.com npm run build
```
- `MONGO_URI_TEST` must point to a database whose name contains `test` and that is NOT the database in `MONGODB_URI`; the suite wipes it and refuses to run otherwise.
- Five backend tests check true concurrency (`tests/helpers/dbAtomicity.js`). They skip themselves with a warning on emulators such as FerretDB. Run them once against real MongoDB (Atlas or `mongodb-memory-server`) before trusting the velocity/lock behaviour.

## Environment variables
Backend (`finguardai-backend/.env.example` has comments for each):
`NODE_ENV`, `PORT`, `MONGODB_URI` (must include the database name), `JWT_SECRET` (32+ random chars), `FRONTEND_URL` (exact origin, no trailing slash; comma-separate several), `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET`, `ANALYST_INVITE_CODE`, `COOKIE_MODE` (`cross-site` default or `same-site`), `COOKIE_DOMAIN`, `APP_TIME_ZONE` (default `Asia/Kolkata`), `TRUST_PROXY`, and for the seed script `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD`.
Frontend: `VITE_API_URL` (bare https origin of the API; required for `vite build`), optional `VITE_SOCKET_URL`, `VITE_API_TIMEOUT_MS`, and for dev only `VITE_DEV_BACKEND_URL`.

In production the server refuses to start when: `NODE_ENV` is not `production` on Render, `MONGODB_URI` has no database name, `JWT_SECRET` is a placeholder or too short, `COOKIE_MODE`/`APP_TIME_ZONE` are invalid, or the Cloudinary variables are missing. In every mode it refuses a `MONGODB_URI` that still contains a `<placeholder>` such as `<password>`.

## Deploy checklist
1. **Atlas**: database user with `readWrite` on the `finguardai` database; Network Access allows Render; URI has the form `mongodb+srv://USER:ENCODED_PW@cluster.mongodb.net/finguardai?retryWrites=true&w=majority` (percent-encode special characters in the password).
2. **Render** (web service): root `finguardai-backend`; build `npm ci --omit=dev`; start `node server.js` (not `npm start`: npm does not forward SIGTERM, so graceful shutdown would not run); health check `/health`; env `NODE_ENV=production`, `NODE_VERSION=24`, `MONGODB_URI`, `JWT_SECRET`, `FRONTEND_URL`, `CLOUDINARY_*`, `ANALYST_INVITE_CODE` (optional). Do not set `PORT`.
3. **Vercel** (frontend): root `finguardai-frontend`; `VITE_API_URL=https://<your-render-host>`; do not set `NODE_ENV`.
4. Put the exact Vercel production URL into Render's `FRONTEND_URL`, redeploy.
5. From your own computer run the seed against Atlas with a strong `ADMIN_PASSWORD` (12+ chars), single-quoted in the shell, then close that terminal: `npm run seed:admin`.
6. Verify: login, a hard refresh on a deep link, a transaction after the server has been idle, an ADMIN live alert (WebSocket) and, on an iPhone/Safari, that login survives a page reload (see the cookie note below).

### Cookies and Safari/iPhone
Default (`COOKIE_MODE=cross-site`) is the Vercel + Render setup: `HttpOnly; Secure; SameSite=None; Partitioned`. Chrome, Edge and Firefox accept it; **Safari/iOS may reject third-party cookies**. If it does, put the frontend and API on one registrable domain you own (for example `app.example.com` and `api.example.com`), set `COOKIE_MODE=same-site` (and optionally `COOKIE_DOMAIN=.example.com`) and `FRONTEND_URL=https://app.example.com`.

## Security notes
- Analyst registration needs the invite code; admins are created only by the seed script.
- Rate limits are in memory per server instance (login failures, registrations, password changes, transactions). Behind more than one instance they would need a shared store.
- Device reputation is keyed by the device id the client sends and is shared across users (known limitation).
- The scoring rules are intentionally conservative: soft signals alone (velocity, odd hour, new city) cannot reach MEDIUM with the default thresholds. Tune them on the Thresholds page.

See `FIX_LOG.md` for the full list of fixes and the remaining known issues.
