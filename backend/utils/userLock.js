/**
 * @file utils/userLock.js
 * @description In-process keyed async mutex (L-08).
 *
 *   POST /customer-api/transactions reads state (velocity counts, behaviour
 *   profile, device reputation), scores, writes, then updates the profile /
 *   reputation / trust score. Two overlapping requests of the SAME user used to
 *   read the same snapshot, so a burst of 12 parallel payments produced no
 *   velocity flag and the derived writes could land out of order (N-28).
 *   withUserLock serialises those requests per user; different users still run
 *   fully in parallel.
 *
 *   • FIFO: callers for one key run strictly in arrival order.
 *   • The lock is always released (try/finally), also when `fn` throws.
 *   • Idle keys are deleted, so the map never grows with the number of users.
 *   • Scope: ONE Node process. FinGuardAI runs a single Render instance; with
 *     several instances a distributed lock (or a Mongo findOneAndUpdate
 *     guard) would be needed.
 */

/** key → promise that settles when the most recently queued holder releases */
const tails = new Map();

/**
 * Run `fn` exclusively for `key`.
 * @template T
 * @param {string|{ toString(): string }} key  e.g. the user's ObjectId
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export const withUserLock = async (key, fn) => {
  const id = String(key);
  const previous = tails.get(id) ?? Promise.resolve();

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate); // never rejects: gate only resolves
  tails.set(id, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(id) === tail) tails.delete(id); // nobody queued behind us → key is idle
  }
};

/** Number of keys currently locked or queued (diagnostics / tests). */
export const activeLockCount = () => tails.size;
