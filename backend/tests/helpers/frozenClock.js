// tests/helpers/frozenClock.js — T-04: freeze ONLY `Date` (timers, nextTick and I/O keep running), so assertions about
// the IST hour / IST day / 30-day window cannot flake when a run crosses an hour or midnight boundary.
import { jest } from '@jest/globals';

const KEEP_REAL = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout',
];

/** 2026-03-10 14:00 IST (08:30 UTC): mid-day, far from any hour / day boundary in both UTC and IST. */
export const MID_DAY_IST = '2026-03-10T08:30:00.000Z';

export const freezeClock = (iso = MID_DAY_IST) => jest.useFakeTimers({ now: new Date(iso), doNotFake: KEEP_REAL });
export const unfreezeClock = () => jest.useRealTimers();
