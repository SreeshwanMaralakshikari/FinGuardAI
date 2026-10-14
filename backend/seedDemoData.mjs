/**
 * @file scripts/seedDemoData.mjs
 * @description Fills a running FinGuardAI API with demo data by calling the REAL
 *   API (register, login, submit transactions, open and work cases), so scoring,
 *   alerts, notifications, device reputation, trust scores and audit logs are all
 *   produced by the normal business rules — nothing is written to MongoDB directly
 *   and no database credentials are needed.
 *
 *   Usage (Node 18+):
 *     API_URL=https://your-api.onrender.com ANALYST_INVITE_CODE=<the code set on the server> npm run seed:demo
 *   PowerShell:
 *     $env:API_URL="https://your-api.onrender.com"; $env:ANALYST_INVITE_CODE="<code>"; npm run seed:demo
 *
 *   Creates 5 demo customers and 2 demo analysts (password: DEMO_PASSWORD, default
 *   "Demo@12345"), their transactions (LOW, MEDIUM, HIGH, CRITICAL) and a few cases
 *   (one resolved, one under review, one dismissed as a false positive).
 *   Safe to run again: existing demo users are logged in instead of re-created, and a
 *   customer that already has transactions is skipped. The admin account is NOT
 *   created here — use `npm run seed:admin`.
 *   Everything is stamped "now" (the API sets transaction times itself).
 */
const API_URL = (process.env.API_URL ?? 'http://localhost:5000').replace(/\/+$/, '');
const INVITE = (process.env.ANALYST_INVITE_CODE ?? '').trim();
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo@12345';
const TIMEOUT_MS = 120_000; // a sleeping free-tier server needs up to ~60 s for the first request

class Session {
  constructor(label) { this.label = label; this.token = ''; }

  async call(method, path, body, { retries = 2 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await fetch(`${API_URL}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', ...(this.token ? { Cookie: `token=${this.token}` } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const fromHeader = res.headers.getSetCookie?.().map((c) => /^token=([^;]*)/.exec(c)?.[1]).find(Boolean);
        if (fromHeader) this.token = fromHeader;
        const json = await res.json().catch(() => ({}));
        if (res.status === 429) { await sleep(20_000); continue; }
        return { status: res.status, body: json };
      } catch (err) {
        if (attempt >= retries) throw new Error(`${method} ${path}: ${err.message}`);
        await sleep(5_000);
      }
    }
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const must = (res, what, okStatuses = [200, 201]) => {
  if (!okStatuses.includes(res.status)) throw new Error(`${what} failed (${res.status}): ${res.body?.message ?? JSON.stringify(res.body)}`);
  return res.body.data ?? res.body;
};

async function signIn({ name, email, role }) {
  const s = new Session(email);
  const reg = await s.call('POST', '/auth/register', { name, email, password: PASSWORD, role, ...(role === 'ANALYST' ? { inviteCode: INVITE } : {}) });
  if (reg.status === 201) console.log(`  + created ${role.toLowerCase()} ${email}`);
  else if (!(reg.status === 400 && /already exists/i.test(reg.body?.message ?? ''))) must(reg, `register ${email}`);
  else console.log(`  = ${email} already exists`);
  must(await s.call('POST', '/auth/login', { email, password: PASSWORD }), `login ${email}`);
  return s;
}

// ── Demo data ────────────────────────────────────────────────────────────────
const domain = 'example.com';
const tx = (amount, merchantName, merchantCategory, paymentMethod, deviceId, city, country = 'India') =>
  ({ amount, merchantName, merchantCategory, paymentMethod, deviceId, location: { city, country } });

/** Four ordinary payments on the customer's usual device and city teach the "normal" profile (and stay under the velocity limit). */
const baseline = (tag, city) => [
  tx(450, 'BigBasket', 'GROCERY', 'UPI', `${tag}-phone`, city),
  tx(1200, 'Myntra', 'FASHION', 'CARD', `${tag}-phone`, city),
  tx(800, 'Swiggy', 'FOOD', 'UPI', `${tag}-phone`, city),
  tx(2500, 'Croma', 'ELECTRONICS', 'NET_BANKING', `${tag}-phone`, city),
];

const CUSTOMERS = [
  { name: 'Aarav Sharma', email: `demo.aarav@${domain}`, tag: 'aarav', city: 'Mumbai',
    risky: (t) => [tx(3000, 'Reliance Digital', 'ELECTRONICS', 'CARD', `${t}-laptop`, 'Bengaluru'),   // MEDIUM: new device + new city
                   tx(60000, 'Casino Royale', 'CASINO', 'CARD', `${t}-phone`, 'Mumbai')] },            // HIGH
  { name: 'Diya Patel', email: `demo.diya@${domain}`, tag: 'diya', city: 'Ahmedabad',
    risky: (t) => [tx(85000, 'CoinSwap Exchange', 'CRYPTO_EXCHANGE', 'NET_BANKING', `${t}-unknown`, 'Dubai', 'UAE')] }, // CRITICAL
  { name: 'Rohan Iyer', email: `demo.rohan@${domain}`, tag: 'rohan', city: 'Chennai',
    risky: (t) => [tx(12000, 'BitMart India', 'CRYPTO_EXCHANGE', 'UPI', `${t}-tablet`, 'Chennai')] },     // HIGH (a false positive)
  { name: 'Meera Nair', email: `demo.meera@${domain}`, tag: 'meera', city: 'Kochi',
    risky: (t) => [tx(4500, 'Lulu Mall', 'RETAIL', 'CARD', `${t}-guest-tablet`, 'Kochi')] },            // MEDIUM
  { name: 'Karan Singh', email: `demo.karan@${domain}`, tag: 'karan', city: 'Delhi', risky: () => [] },  // clean customer
];
const ANALYSTS = [
  { name: 'Priya Menon', email: `demo.priya@${domain}` },
  { name: 'Vikram Rao', email: `demo.vikram@${domain}` },
];

async function main() {
  console.log(`FinGuardAI demo data -> ${API_URL}`);
  if (!INVITE) console.warn('ANALYST_INVITE_CODE is not set: demo analysts cannot be created (customers, transactions and alerts still are).');
  console.log('Waking the server / checking health ...');
  const health = await new Session('health').call('GET', '/health', undefined, { retries: 4 });
  if (health.status !== 200) throw new Error(`/health answered ${health.status}; is API_URL correct?`);

  console.log('Customers and transactions:');
  for (const c of CUSTOMERS) {
    const s = await signIn({ name: c.name, email: c.email, role: 'CUSTOMER' });
    const existing = must(await s.call('GET', '/customer-api/transactions?limit=1'), 'list transactions', [200]);
    const already = Array.isArray(existing) ? existing.length : 0;
    if (already > 0) { console.log(`  = ${c.name} already has transactions, skipped`); continue; }
    for (const t of [...baseline(c.tag, c.city), ...c.risky(c.tag)]) {
      const r = must(await s.call('POST', '/customer-api/transactions', t), `transaction for ${c.email}`);
      console.log(`    ${c.name.padEnd(13)} Rs ${String(t.amount).padStart(6)}  ${r.riskLevel.padEnd(8)} ${r.status}`);
    }
  }

  if (!INVITE) { console.log('Done (without analysts).'); return; }

  console.log('Analysts and cases:');
  const sessions = [];
  for (const a of ANALYSTS) sessions.push(await signIn({ ...a, role: 'ANALYST' }));
  const [priya, vikram] = sessions;

  const flagged = must(await priya.call('GET', '/analyst-api/flagged-transactions?limit=50'), 'list flagged');
  const plan = {
    'demo.aarav': { by: priya, steps: ['UNDER_REVIEW', 'RESOLVED'], summary: 'Customer confirmed they did not make this payment. Card blocked; fraud confirmed.' },
    'demo.diya': { by: priya, steps: ['UNDER_REVIEW'], note: 'Foreign crypto purchase from an unknown device. Waiting for the customer to call back.' },
    'demo.rohan': { by: vikram, steps: ['DISMISSED'], summary: 'Customer verified the purchase by phone. False positive; payment released.' },
  };
  for (const item of flagged) {
    const key = Object.keys(plan).find((k) => (item.userId?.email ?? '').startsWith(k));
    if (!key) continue;
    const detail = must(await priya.call('GET', `/analyst-api/flagged-transactions/${item._id}`), 'flagged detail');
    if (detail.existingCase) { console.log(`  = ${item.publicId} already has case ${detail.existingCase.publicId}`); continue; }
    const { by, steps, summary, note } = plan[key];
    const made = must(await by.call('POST', '/analyst-api/cases', { fraudAlertId: detail.fraudAlert._id, initialNote: 'Opened from the flagged transactions list.' }), 'create case');
    must(await by.call('PATCH', `/analyst-api/cases/${made._id}/assign`, {}), 'assign case');
    if (note) must(await by.call('POST', `/analyst-api/cases/${made._id}/notes`, { text: note }), 'add note');
    for (const status of steps) {
      const closing = status === 'RESOLVED' || status === 'DISMISSED';
      must(await by.call('PATCH', `/analyst-api/cases/${made._id}/status`, { status, ...(closing ? { resolutionSummary: summary } : {}) }), `set ${status}`);
    }
    console.log(`  + ${made.publicId} for ${item.publicId}: ${steps[steps.length - 1]}`);
  }

  console.log(`\nDone. Demo logins (password "${PASSWORD}"): ${[...CUSTOMERS, ...ANALYSTS].map((u) => u.email).join(', ')}`);
}

main().catch((err) => { console.error(`\nDemo seed failed: ${err.message}`); process.exit(1); });
