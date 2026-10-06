// tests/helpers/seedConfig.js
import SystemConfigModel from '../../models/SystemConfigModel.js';

/** Upsert the SystemConfig singleton (D-P4-08 filter) with defaults + overrides. */
export async function seedConfig(overrides = {}) {
  const defaults = {
    amountThreshold: 50000,
    velocityLimit: { maxPerHour: 5, maxPerDay: 20 },
    scoreThresholds: { mediumMin: 25, highMin: 50, criticalMin: 75 },
    locationDeviationKm: 500,
    newDeviceWeight: 20,
    highRiskMerchants: ['CASINO', 'GAMBLING', 'CRYPTO_EXCHANGE', 'ADULT', 'OFFSHORE_BETTING'],
  };
  const merged = {
    ...defaults,
    ...overrides,
    velocityLimit: { ...defaults.velocityLimit, ...(overrides.velocityLimit ?? {}) },
    scoreThresholds: { ...defaults.scoreThresholds, ...(overrides.scoreThresholds ?? {}) },
  };
  return SystemConfigModel.findOneAndUpdate(
    { singleton: 'system' },
    { $set: merged },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
}
