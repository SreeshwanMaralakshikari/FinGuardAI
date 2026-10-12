/**
 * @file utils/forecast.js
 * @description A-04: the 7-day outlook of GET /admin-api/analytics/trends — ordinary least squares
 *   on the last 14 daily values of each series. Pure functions, no I/O.
 */
export const FORECAST_METHOD = 'linear-regression-14d';
export const FORECAST_WINDOW = 14;
export const FORECAST_HORIZON = 7;
export const MIN_DAYS_WITH_DATA = 7;

/**
 * Ordinary least squares of y on x = 0, 1, … n-1.
 * @param {number[]} ys
 * @returns {{ slope: number, intercept: number }}  n = 0 → 0/0, n = 1 → flat line through the value
 */
export const linearRegression = (ys) => {
  const n = ys.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  if (n === 1) return { slope: 0, intercept: ys[0] };
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;
  let covariance = 0;
  let variance = 0;
  ys.forEach((y, x) => {
    covariance += (x - meanX) * (y - meanY);
    variance += (x - meanX) ** 2;
  });
  const slope = covariance / variance; // variance > 0 for n >= 2
  return { slope, intercept: meanY - slope * meanX };
};

/** Round half away from zero to `decimals` places (values are clamped >= 0 before, so this is plain rounding). */
const roundTo = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

/**
 * The next `horizon` values after `ys`, clamped to [min, max] and rounded.
 * @param {number[]} ys  oldest first
 * @param {{ horizon?: number, decimals?: number, min?: number, max?: number }} [options]
 * @returns {number[]}
 */
export const predictNext = (ys, { horizon = FORECAST_HORIZON, decimals = 0, min = 0, max = Infinity } = {}) => {
  const { slope, intercept } = linearRegression(ys);
  return Array.from({ length: horizon }, (_, i) => {
    const raw = intercept + slope * (ys.length + i);
    return roundTo(Math.min(max, Math.max(min, raw)), decimals);
  });
};

/**
 * Build the `forecast` block of the trends response.
 * @param {Array<Record<string, any>>} series  daily rows, oldest first (only the last FORECAST_WINDOW are used)
 * @param {string[]} nextDates                 'YYYY-MM-DD' of the days to predict, in order
 * @param {Record<string, { decimals: number, max?: number }>} fields  one entry per series to project
 * @param {(row: Record<string, any>) => boolean} hasData  whether a row represents a day with data
 */
export const buildForecast = (series, nextDates, fields, hasData) => {
  const window = series.slice(-FORECAST_WINDOW);
  if (window.filter(hasData).length < MIN_DAYS_WITH_DATA) {
    return { available: false, method: FORECAST_METHOD, days: [] };
  }
  const predicted = Object.fromEntries(
    Object.entries(fields).map(([name, { decimals, max }]) => [
      name,
      predictNext(window.map((row) => Number(row[name]) || 0), { horizon: nextDates.length, decimals, max }),
    ])
  );
  const days = nextDates.map((date, i) => ({
    date,
    ...Object.fromEntries(Object.keys(fields).map((name) => [name, predicted[name][i]])),
  }));
  return { available: true, method: FORECAST_METHOD, days };
};
