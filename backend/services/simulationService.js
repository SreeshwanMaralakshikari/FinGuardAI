/**
 * @file services/simulationService.js
 * @description A-08: the admin "demo data" generator and its cleanup.
 *
 *   generateSimulation() runs synthetic payments of up to MAX_SIM_USERS synthetic customers through the REAL
 *   pipeline (services/transactionService.processTransaction), so scoring, alerts, notifications, audit
 *   entries, device reputation, trust scores and the live socket events are all genuine. Only three things mark
 *   the data as synthetic, and the cleanup filters on exactly those:
 *     • User.isSimulated = true (and the sim.customer.N@simulation.finguard.local address),
 *     • Transaction.isSimulated = true,
 *     • device ids starting with "sim-" that no real customer is associated with.
 *   clearSimulation() removes everything those users own. AuditLog rows are immutable and stay.
 *
 *   Scenario mix (largest-remainder rounding of the percentages): 60% normal repeat behaviour, 10% unusual city,
 *   10% very large amount, 8% new device, 6% rapid velocity burst, 6% high-risk merchant. The order is shuffled by
 *   a seeded PRNG (same database state + count → same run), every user gets a normal baseline payment first, and
 *   a burst is a block of back-to-back payments of ONE user, so each scenario shows up in the score breakdown.
 */
import { randomBytes } from 'node:crypto';
import { processTransaction } from './transactionService.js';
import { withUserLock } from '../utils/userLock.js';
import { PAYMENT_METHODS } from '../utils/enums.js';
import UserModel from '../models/UserModel.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import NotificationModel from '../models/NotificationModel.js';
import DeviceReputationModel from '../models/DeviceReputationModel.js';
import BehaviorProfileModel from '../models/BehaviorProfileModel.js';

export const SIM_EMAIL_DOMAIN = 'simulation.finguard.local';
export const SIM_DEVICE_PREFIX = 'sim-';
export const MAX_SIM_USERS = 6;
export const MAX_SIMULATED_TRANSACTIONS = 500;
export const DEFAULT_SIM_COUNT = 30;
/** Scenario name → share of the run in percent (sums to 100). */
export const SCENARIO_WEIGHTS = Object.freeze([
  ['normal', 60], ['unusualCity', 10], ['largeAmount', 10], ['newDevice', 8], ['burst', 6], ['highRiskMerchant', 6],
]);

/** An error the route turns into an HTTP response (everything else is a 500). */
export class SimulationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SimulationError';
    this.status = status;
  }
}

const HOME_CITIES = ['Mumbai', 'Delhi', 'Bengaluru', 'Chennai', 'Hyderabad', 'Pune'];
const FAR_CITIES = [
  { city: 'Dubai', country: 'AE' }, { city: 'Singapore', country: 'SG' }, { city: 'London', country: 'GB' },
  { city: 'Lagos', country: 'NG' }, { city: 'Moscow', country: 'RU' }, { city: 'Sydney', country: 'AU' },
];
const NORMAL_MERCHANTS = [
  ['BookStore', 'RETAIL'], ['Fresh Grocer', 'GROCERY'], ['Metro Cabs', 'TRAVEL'],
  ['City Pharmacy', 'HEALTH'], ['Chai Point', 'FOOD'], ['Power Bill Pay', 'UTILITIES'],
];
const RISKY_MERCHANTS = [['Royal Casino', 'CASINO'], ['CryptoMart Exchange', 'CRYPTO_EXCHANGE'], ['Lucky Gambling', 'GAMBLING']];
const BURST_PRECEDING_NORMALS = 4; // a burst block = up to 4 back-to-back normal payments + the burst payments

// ── deterministic helpers ───────────────────────────────────────────────────────────────────────────
/** mulberry32: small seeded PRNG → () => [0, 1). */
export const createRng = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = (list, rng) => list[Math.floor(rng() * list.length)];
const money = (value) => Math.round(value * 100) / 100;
const shuffle = (list, rng) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/**
 * How many payments each scenario gets for `count` (largest remainder: the quotas always add up to `count`).
 * @returns {Record<string, number>}
 */
export const scenarioQuotas = (count) => {
  const rows = SCENARIO_WEIGHTS.map(([name, weight], order) => {
    const exact = (count * weight) / 100;
    return { name, order, floor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = count - rows.reduce((sum, r) => sum + r.floor, 0);
  [...rows].sort((a, b) => b.remainder - a.remainder || a.order - b.order).forEach((row) => {
    if (left > 0) { row.floor += 1; left -= 1; }
  });
  return Object.fromEntries(rows.map((r) => [r.name, r.floor]));
};

// ── the synthetic customers ─────────────────────────────────────────────────────────────────────────
const simEmail = (n) => `sim.customer.${n}@${SIM_EMAIL_DOMAIN}`;

/** The profile of synthetic customer `n` (1-based): where they live, what they pay with and spend. */
const personaOf = (user, n) => ({
  user,
  n,
  homeCity: HOME_CITIES[(n - 1) % HOME_CITIES.length],
  homeDevice: `${SIM_DEVICE_PREFIX}u${n}-home`,
  paymentMethod: PAYMENT_METHODS[(n - 1) % PAYMENT_METHODS.length],
  base: 300 + 120 * n, // typical spend in rupees
  ip: `203.0.113.${n}`, // TEST-NET-3 documentation range: never a real client
});

/** Create or reuse sim.customer.1..n. A real account holding one of the reserved addresses is never touched (409). */
const ensureSimUsers = async (n) => {
  const personas = [];
  for (let i = 1; i <= n; i += 1) {
    let user = await UserModel.findOne({ email: simEmail(i) });
    if (user && user.isSimulated !== true) {
      throw new SimulationError(`The address ${simEmail(i)} belongs to a real account; the simulation cannot use it.`, 409);
    }
    if (!user) {
      user = await UserModel.create({
        name: `Sim Customer ${i}`,
        email: simEmail(i),
        password: randomBytes(24).toString('hex'), // random and never revealed: hashed by the model, nobody can log in
        role: 'CUSTOMER',
        isSimulated: true,
      });
    }
    personas.push(personaOf(user, i));
  }
  return personas;
};

// ── the plan ────────────────────────────────────────────────────────────────────────────────────────
/**
 * @param {number} count
 * @param {object[]} personas
 * @param {Set<string>} primed   user ids that already have a trusted baseline
 * @param {string|null} burstUserId
 * @param {() => number} rng
 * @returns {{ scenario: string, persona: object, variant: number }[]}
 */
export const planRun = (count, personas, primed, burstUserId, rng) => {
  const quotas = scenarioQuotas(count);
  let normals = quotas.normal;
  const plan = [];
  const step = (scenario, persona, variant = 0) => plan.push({ scenario, persona, variant });

  // 1. one normal payment for every user without a baseline, so the other scenarios have something to deviate from
  for (const persona of personas) {
    if (normals > 0 && !primed.has(String(persona.user._id))) { step('normal', persona); normals -= 1; }
  }

  // 2. the rest, shuffled; the burst is one contiguous block of a single user
  const burstPersona = personas.find((p) => String(p.user._id) === burstUserId) ?? pick(personas, rng);
  const rest = [];
  const variantCounter = {};
  const nextVariant = (name) => { variantCounter[name] = (variantCounter[name] ?? -1) + 1; return variantCounter[name]; };
  for (const name of ['unusualCity', 'largeAmount', 'newDevice', 'highRiskMerchant']) {
    for (let i = 0; i < quotas[name]; i += 1) rest.push({ scenario: name, persona: pick(personas, rng), variant: nextVariant(name) });
  }
  const leadNormals = quotas.burst > 0 ? Math.min(BURST_PRECEDING_NORMALS, normals) : 0;
  normals -= leadNormals;
  for (let i = 0; i < normals; i += 1) rest.push({ scenario: 'normal', persona: pick(personas, rng), variant: 0 });

  const shuffled = shuffle(rest, rng);
  const burstBlock = [
    ...Array.from({ length: leadNormals }, () => ({ scenario: 'normal', persona: burstPersona, variant: 0 })),
    ...Array.from({ length: quotas.burst }, (_, i) => ({ scenario: 'burst', persona: burstPersona, variant: i })),
  ];
  const at = Math.floor(rng() * (shuffled.length + 1));
  plan.push(...shuffled.slice(0, at), ...burstBlock, ...shuffled.slice(at));
  return plan;
};

/** The request payload of one planned payment. `serial` keeps new device ids unique across runs. */
export const buildPayload = ({ scenario, persona, variant }, rng, serial) => {
  const { base, homeCity, homeDevice, paymentMethod } = persona;
  const [merchantName, merchantCategory] = pick(NORMAL_MERCHANTS, rng);
  const payload = {
    amount: money(base * (0.7 + 0.6 * rng())),
    merchantName,
    merchantCategory,
    paymentMethod,
    location: { city: homeCity, country: 'IN' },
    deviceId: homeDevice,
  };
  const freshDevice = () => `${SIM_DEVICE_PREFIX}u${persona.n}-nd-${serial.toString(36)}`;

  switch (scenario) {
    case 'unusualCity': // far away AND a bigger purchase than usual
      payload.location = pick(FAR_CITIES, rng);
      payload.amount = money(base * 4);
      break;
    case 'largeAmount': // far above the high-value threshold and the customer's average
      payload.amount = money(55_000 + rng() * 43_000);
      payload.merchantName = 'Premium Electronics';
      payload.merchantCategory = 'ELECTRONICS';
      break;
    case 'newDevice': // even: just a new phone; odd: a new phone plus a bigger purchase
      payload.deviceId = freshDevice();
      if (variant % 2 === 1) payload.amount = money(base * 4.2);
      break;
    case 'burst': // rapid repeat payments: the velocity rule, with a slightly bigger ticket
      payload.amount = money(base * 3.5);
      break;
    case 'highRiskMerchant': {
      [payload.merchantName, payload.merchantCategory] = pick(RISKY_MERCHANTS, rng);
      payload.amount = money(55_000 + rng() * 25_000);
      if (variant % 2 === 1) payload.deviceId = freshDevice(); // unknown device on top → CRITICAL
      break;
    }
    default: // 'normal'
  }
  return payload;
};

const emptyTally = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

/**
 * Create `count` synthetic payments. Throws SimulationError (400 over the cap).
 * @param {{ count?: number, rng?: () => number }} [options]  `rng` is injectable for tests
 * @returns {Promise<{ generated: number, byRiskLevel: Record<string, number>, byStatus: Record<string, number>, simulatedTransactionsTotal: number }>}
 */
export const generateSimulation = ({ count = DEFAULT_SIM_COUNT, rng } = {}) =>
  withUserLock('simulation-data', async () => {
    const existing = await TransactionModel.countDocuments({ isSimulated: true });
    if (existing + count > MAX_SIMULATED_TRANSACTIONS) {
      throw new SimulationError(
        `Simulation limit reached: ${existing} simulated transactions already exist and at most ${MAX_SIMULATED_TRANSACTIONS} are allowed. ` +
        'Clear the simulation data first.'
      );
    }

    const random = rng ?? createRng(existing * 7919 + count);
    const personas = await ensureSimUsers(Math.min(MAX_SIM_USERS, Math.max(1, Math.ceil(count / 5))));
    const userIds = personas.map((p) => p.user._id);

    // who already has a baseline, and who was busiest in the last hour (the natural burst user)
    const [profiles, recent] = await Promise.all([
      BehaviorProfileModel.find({ userId: { $in: userIds } }).select('userId').lean(),
      TransactionModel.aggregate([
        { $match: { userId: { $in: userIds }, timestamp: { $gte: new Date(Date.now() - 60 * 60 * 1000) } } },
        { $group: { _id: '$userId', n: { $sum: 1 } } },
      ]),
    ]);
    const primed = new Set(profiles.map((p) => String(p.userId)));
    const busiest = [...recent].sort((a, b) => b.n - a.n || String(a._id).localeCompare(String(b._id)))[0];

    const plan = planRun(count, personas, primed, busiest ? String(busiest._id) : null, random);
    const byRiskLevel = emptyTally(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
    const byStatus = emptyTally(['APPROVED', 'HELD', 'BLOCKED']);
    let generated = 0;
    let firstError = null;
    const serialBase = Date.now();

    for (const [i, step] of plan.entries()) {
      try {
        const { transaction } = await processTransaction({
          user: step.persona.user,
          payload: buildPayload(step, random, serialBase + i),
          context: { ip: step.persona.ip, simulated: true },
        });
        generated += 1;
        byRiskLevel[transaction.riskLevel] += 1;
        byStatus[transaction.status] += 1;
      } catch (err) {
        firstError ??= err;
        console.error('[simulation] A synthetic payment failed:', err.message);
      }
    }
    if (generated === 0 && firstError) throw firstError;

    return { generated, byRiskLevel, byStatus, simulatedTransactionsTotal: existing + generated };
  });

/**
 * Remove every document the synthetic customers own. Selection is strictly by User.isSimulated and the ids
 * derived from those users; "sim-" device reputations are removed only when every associated user is simulated.
 * @returns {Promise<Record<string, number>>} deleted counts (the audit log is immutable and is not touched)
 */
export const clearSimulation = () =>
  withUserLock('simulation-data', async () => {
    const users = await UserModel.find({ isSimulated: true }).select('_id').lean();
    const userIds = users.map((u) => u._id);
    const deleted = {
      users: 0, transactions: 0, fraudAlerts: 0, cases: 0, notifications: 0, deviceReputations: 0, behaviorProfiles: 0,
    };
    if (userIds.length === 0) return deleted;
    const simIds = new Set(userIds.map(String));

    const [transactions, alerts] = await Promise.all([
      TransactionModel.find({ userId: { $in: userIds } }).select('_id').lean(),
      FraudAlertModel.find({ userId: { $in: userIds } }).select('_id').lean(),
    ]);
    const transactionIds = transactions.map((t) => t._id);
    const alertIds = alerts.map((a) => a._id);
    const cases = await FraudCaseModel.find({
      $or: [{ fraudAlertId: { $in: alertIds } }, { transactionId: { $in: transactionIds } }],
    }).select('_id').lean();
    const caseIds = cases.map((c) => c._id);

    // "sim-" devices that only synthetic users ever touched (a real customer may type any device id)
    const candidates = await DeviceReputationModel.find({
      deviceId: { $regex: `^${SIM_DEVICE_PREFIX}` },
      associatedUserIds: { $in: userIds },
    }).select('_id associatedUserIds').lean();
    const deviceIds = candidates
      .filter((d) => d.associatedUserIds.every((id) => simIds.has(String(id))))
      .map((d) => d._id);

    deleted.cases = (await FraudCaseModel.deleteMany({ _id: { $in: caseIds } })).deletedCount;
    deleted.fraudAlerts = (await FraudAlertModel.deleteMany({ _id: { $in: alertIds } })).deletedCount;
    deleted.transactions = (await TransactionModel.deleteMany({ _id: { $in: transactionIds } })).deletedCount;
    deleted.notifications = (await NotificationModel.deleteMany({
      $or: [
        { recipientId: { $in: userIds } },
        // analysts' "case assigned / status changed" notices about the synthetic cases deleted above
        { relatedEntityType: 'FRAUD_CASE', relatedEntityId: { $in: caseIds } },
      ],
    })).deletedCount;
    deleted.deviceReputations = (await DeviceReputationModel.deleteMany({ _id: { $in: deviceIds } })).deletedCount;
    // a device a real customer also used survives: only the synthetic users are taken out of its list
    await DeviceReputationModel.updateMany(
      { associatedUserIds: { $in: userIds } },
      { $pullAll: { associatedUserIds: userIds } }
    );
    deleted.behaviorProfiles = (await BehaviorProfileModel.deleteMany({ userId: { $in: userIds } })).deletedCount;
    deleted.users = (await UserModel.deleteMany({ _id: { $in: userIds }, isSimulated: true })).deletedCount;
    return deleted;
  });

