# Running FinGuardAI offline (exam-day backup)

The live site needs the internet: Vercel, two Render services (which may be asleep) and MongoDB Atlas. This guide puts **all four parts on your laptop**: the database (MongoDB), the API (Node.js), the ML model (Python) and the website. The demo then works with Wi-Fi switched off.

Your normal setup is not touched. The live site and your `backend/.env` (Atlas) keep working exactly as before; offline mode uses its own file, `backend/.env.offline`, and its own local database, `finguardai_offline`.

| Part | Where it runs offline |
|---|---|
| Database | MongoDB Community Server on your laptop, `127.0.0.1:27017`, database `finguardai_offline` |
| ML model | `ml-service` with Python, `127.0.0.1:5001` |
| API | `backend` with Node.js, `127.0.0.1:5000` |
| Website | `frontend` with Vite, **http://localhost:3000** |

---

## Part 1: one-time preparation (needs internet, do it a few days before)

### 1. Install MongoDB Community Server

1. Download the Windows MSI installer: <https://www.mongodb.com/try/download/community> (version 8.0, platform Windows, package msi).
2. Run it and choose **Complete**. Keep **"Install MongoD as a Service"** ticked (the default), so MongoDB starts by itself with Windows.
3. MongoDB Compass (offered by the installer) is optional. It lets you look at the data.

You also need **Node.js 24** and **Python 3.13**, which you already used for this project.

### 2. Install the packages (PowerShell, in the project folder)

```powershell
cd backend
npm ci
cd ..\frontend
npm ci
cd ..\ml-service
py -3.13 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
```

### 3. Create the offline settings

```powershell
cd backend
npm run offline:setup
```

This writes `backend/.env.offline`. Your **admin login and analyst invite code are copied from `.env`**, so offline you sign in with the same accounts as on the live site. The JWT secret and the ML key are new random values used only on this laptop. The file is git-ignored; never commit it.

### 4. Put data in the local database (pick one)

**A. Copy the live data (recommended).** The laptop then shows exactly what the live site shows: the same accounts, payments, alerts, cases, audit log and thresholds.

```powershell
npm run offline:copy        # still in backend\, internet on
```

Atlas is only read, never changed. The local copy is replaced each time, so run it again any time to refresh it (for example the evening before the exam).

**B. Fresh demo data.** Use this if you'd rather start clean. You get the admin, 5 demo customers, 2 demo analysts, payments at every risk level, and 3 cases (fraud confirmed, under review, false alarm).

```powershell
npm run seed:admin:offline
# start the app (Part 2), then in a new PowerShell window:
cd backend
npm run seed:demo:offline   # demo password for all of them: Demo@12345
```

More payments any time: sign in as admin → **Simulation** → *Generate demo transactions*.

### 5. Rehearse once with Wi-Fi off

Turn Wi-Fi off and follow Part 2. If Windows asks whether to let Node.js or Python through the firewall, either answer is fine, because everything talks over `localhost`. "Private networks" is the usual choice.

---

## Part 2: on exam day

1. Double-click **`start-offline.cmd`** in the project folder.
2. It checks MongoDB, then opens three windows: **FinGuardAI ML service**, **FinGuardAI API** and **FinGuardAI website**. The ML service starts first, so the first payment is already scored by the model.
3. The browser opens **http://localhost:3000**. Sign in as usual.
4. To stop: close the three FinGuardAI windows. Running `start-offline.cmd` again is safe, because parts that are already running are left alone.

The admin dashboard's *Fraud scoring engine* card should say **ML model fg-xgb-1.1.0** at `127.0.0.1:5001`.

### Starting by hand (if you prefer three terminals)

```powershell
# Window 1: ML service (use the ML_API_KEY value from backend\.env.offline)
cd ml-service
$env:ML_API_KEY = "<ML_API_KEY from backend\.env.offline>"
.venv\Scripts\python.exe wsgi.py

# Window 2: API
cd backend
npm run start:offline

# Window 3: website
cd frontend
$env:VITE_DEV_BACKEND_URL = "http://127.0.0.1:5000"
npm run dev
```

---

## Which accounts and passwords?

```powershell
cd backend
npm run offline:accounts
```

This lists every account in the offline database (role, name, email) and where its password comes from:
- **Admin:** the `ADMIN_PASSWORD` line in `backend/.env.offline` (the same as your live admin), unless you changed it in the app.
- **Demo accounts** (`demo.…@example.com`): `Demo@12345`.
- **Accounts you registered yourself:** the password you chose. Passwords are stored as one-way hashes, so they can't be shown, only replaced. To give one a new password **in the offline copy only** (the live site keeps the old one):

```powershell
node --env-file=.env.offline scripts/offlineAccounts.mjs reset 'someone@example.com' 'New-Pass-123'
```

Use single quotes around both values. If you run `npm run offline:copy` again later, it brings back the live passwords.

---

## What works offline, and what doesn't

Everything in the demo works offline: sign-in for all three roles, payments with ML scoring and SHAP explanations, "Was this you?", alerts, notifications, analyst cases, admin dashboard, trends, model insights, thresholds, simulation, audit log, the model card and both themes.

Two things need the internet:
- **Uploading a profile picture.** Pictures are stored on Cloudinary. Pictures uploaded earlier show as initials while offline.
- **The live links** (Vercel / Render) themselves, of course.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "MongoDB is not running on port 27017" | Open the Windows **Services** app, find **MongoDB Server (MongoDB)**, click **Start**. If it is missing, MongoDB was installed without "as a Service": reinstall with that box ticked. |
| "backend\.env.offline is missing" | `cd backend` then `npm run offline:setup`. |
| "ml-service\.venv is missing" | Step 2 above (the Python lines). |
| The ML window shows a red "development server" warning | Normal for a local run; ignore it. |
| The ML window says `ML_API_KEY must be set` | Start with `start-offline.cmd`, or set `$env:ML_API_KEY` as shown above. |
| Dashboard card says "Rule engine (ML waking up)" | The ML window was closed or crashed (payments still work, scored by the rules). Start it again with `start-offline.cmd`; payments go back to the model within about a minute. |
| `npm run offline:copy` says it cannot reach the live database | It needs internet. On some Windows networks Atlas's `mongodb+srv` address is blocked: see the Atlas note in the main README. |
| You changed the admin password on the live site | Run `npm run offline:copy` again (it copies the accounts, with their passwords). |
| You want brand-new offline secrets | `npm run offline:setup -- --force`, then sign in again. |

## Commands added for offline mode (in `backend/`)

| Command | What it does |
|---|---|
| `npm run offline:setup` | Creates `.env.offline` (local database, local ML service, same logins as `.env`) |
| `npm run offline:copy` | Copies the live database (Atlas, from `.env`) into the local one |
| `npm run seed:admin:offline` | Creates the admin and default thresholds in the local database |
| `npm run seed:demo:offline` | Fills the running local API with demo customers, analysts, payments and cases |
| `npm run start:offline` | Starts the API against the local database and local ML service |
| `npm run offline:accounts` | Lists every offline account and where its password comes from (`reset` sets a new one, offline only) |
