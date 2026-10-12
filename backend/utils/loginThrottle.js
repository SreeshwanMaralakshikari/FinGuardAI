/**
 * @file utils/loginThrottle.js
 * @description D-02 / R-01: brute-force throttle for POST /auth/login on top of the per-IP authLimiter.
 *
 *   Two counters, both sliding 15-minute windows:
 *     • PAIR  (normalised e-mail + client IP): MAX_FAILURES = 5 attempts → hard lock for that pair. A guessing run from
 *       one address stops after five tries, and — the point of R-01 — it can NOT lock the real owner out, who signs in
 *       from another address.
 *     • EMAIL (e-mail only, any IP): EMAIL_MAX_FAILURES = 30 attempts → lock for everyone. Much higher, so it only
 *       trips on a distributed attack (and then accepts that the owner waits), never on a few typos or one attacker.
 *   Locked attempts get 429 + Retry-After (15 minutes after the LAST counted attempt) with generic wording that is the
 *   same for existing and unknown e-mails. Refused attempts are not counted and never extend the lock.
 *
 *   Reservation: an attempt is recorded the moment it is admitted (reserveLoginAttempt, synchronously, BEFORE the
 *   bcrypt await), so a burst of parallel requests cannot all pass the check before the first failure is recorded.
 *   The attempt then simply stays counted when the password is wrong (or the e-mail unknown); a success clears both
 *   counters (clearLoginFailures) and a non-guess outcome such as a deactivated account gives the slot back
 *   (releaseLoginAttempt).
 *
 *   In memory, per process (like the express-rate-limit stores). Bounded: at most MAX_KEYS keys per counter. When full,
 *   expired entries go first (they are always the oldest ones), then the oldest key that is NOT locked; a locked key is
 *   evicted only if every key is locked.
 */
export const MAX_FAILURES = 5;
export const EMAIL_MAX_FAILURES = 30;
export const WINDOW_MS = 15 * 60 * 1000;
export const MAX_KEYS = 10_000;

/** key → attempt timestamps (ms, oldest first, at most `limit` long). Map order = least recently touched first. */
const makeCounter = (limit) => ({ limit, entries: new Map() });
const pairs = makeCounter(MAX_FAILURES);
const emails = makeCounter(EMAIL_MAX_FAILURES);

export const normaliseLoginKey = (email) => String(email ?? '').trim().toLowerCase();
const pairKey = (email, ip) => `${normaliseLoginKey(email)}|${String(ip ?? '')}`;

/** Attempts of `key` still inside the window; the entry is dropped when none are left. */
const live = (counter, key, now) => {
  const stamps = counter.entries.get(key);
  if (!stamps) return [];
  const fresh = stamps.filter((t) => now - t < WINDOW_MS);
  if (fresh.length === 0) counter.entries.delete(key);
  else if (fresh.length !== stamps.length) counter.entries.set(key, fresh);
  return fresh;
};

const remainingMs = (stamps, limit, now) =>
  stamps.length >= limit ? Math.max(0, stamps[stamps.length - 1] + WINDOW_MS - now) : 0;

/** Make room for one more key: expired prefix first, then the oldest unlocked key, last resort the oldest. */
const evictIfFull = (counter, now) => {
  const { entries, limit } = counter;
  while (entries.size >= MAX_KEYS) {
    let victim;
    for (const [key, stamps] of entries) {
      if (now - stamps[stamps.length - 1] >= WINDOW_MS) { victim = key; break; } // expired
      if (stamps.length < limit) { victim = key; break; } // first live key that is not locked (no expired one can follow)
    }
    entries.delete(victim ?? entries.keys().next().value);
  }
};

const push = (counter, key, now) => {
  const stamps = live(counter, key, now);
  stamps.push(now);
  counter.entries.delete(key); // re-insert → newest in Map order
  if (stamps.length === 1) evictIfFull(counter, now);
  counter.entries.set(key, stamps);
};

/**
 * Milliseconds the (e-mail, ip) pair is locked, whichever counter is stricter (0 = free).
 */
export const getLockoutRemainingMs = (email, ip, now = Date.now()) => {
  if (!normaliseLoginKey(email)) return 0;
  return Math.max(
    remainingMs(live(pairs, pairKey(email, ip), now), MAX_FAILURES, now),
    remainingMs(live(emails, normaliseLoginKey(email), now), EMAIL_MAX_FAILURES, now)
  );
};

/**
 * Admit or refuse one login attempt and — when admitted — count it immediately (synchronous: no await between the
 * check and the write, so parallel requests are serialised by the event loop).
 * @returns {{ allowed: true } | { allowed: false, retryAfterMs: number }}
 */
export const reserveLoginAttempt = (email, ip, now = Date.now()) => {
  if (!normaliseLoginKey(email)) return { allowed: true };
  const retryAfterMs = getLockoutRemainingMs(email, ip, now);
  if (retryAfterMs > 0) return { allowed: false, retryAfterMs };
  push(pairs, pairKey(email, ip), now);
  push(emails, normaliseLoginKey(email), now);
  return { allowed: true };
};

/** Give back the newest reserved attempt (the outcome was not a password guess, e.g. a deactivated account). */
export const releaseLoginAttempt = (email, ip) => {
  for (const [counter, key] of [[pairs, pairKey(email, ip)], [emails, normaliseLoginKey(email)]]) {
    const stamps = counter.entries.get(key);
    if (!stamps) continue;
    stamps.pop();
    if (stamps.length === 0) counter.entries.delete(key);
  }
};

/** A successful login forgets the pair's and the e-mail's attempts. */
export const clearLoginFailures = (email, ip) => {
  pairs.entries.delete(pairKey(email, ip));
  emails.entries.delete(normaliseLoginKey(email));
};

/** Test helpers. */
export const resetLoginThrottle = () => { pairs.entries.clear(); emails.entries.clear(); };
export const trackedLoginKeys = () => pairs.entries.size + emails.entries.size;
export const trackedPairKeys = () => pairs.entries.size;
export const trackedEmailKeys = () => emails.entries.size;

/**
 * Express middleware (after the validators, before the IP limiter): admits and counts the attempt, or answers 429 +
 * Retry-After. Refused attempts neither cost a bcrypt comparison nor eat the shared IP budget of everyone behind that
 * address. The wording is generic: identical for existing and non-existing accounts.
 */
export const loginAccountThrottle = (req, res, next) => {
  const email = req.body?.email;
  if (typeof email !== 'string') return next();
  const result = reserveLoginAttempt(email, req.ip);
  if (result.allowed) return next();
  const seconds = Math.ceil(result.retryAfterMs / 1000);
  res.set('Retry-After', String(seconds));
  return res.status(429).json({
    success: false,
    message: `Too many failed sign-in attempts. Please try again in ${Math.ceil(seconds / 60)} minute(s).`,
  });
};
