/** @file Phase 10 helpers for components/common/FraudExplanation.jsx (kept out of the component file for fast refresh). */
export const FALLBACK_TEXT = Object.freeze({
  TIMEOUT: 'The ML model did not answer in time, so the rule engine scored this payment.',
  UNAVAILABLE: 'The ML service was unavailable (it may have been starting up), so the rule engine scored this payment.',
  COOLDOWN: 'The ML service was starting up, so the rule engine scored this payment.',
});
export const FALLBACK_DEFAULT = 'The ML service could not be used, so the rule engine scored this payment.';

/** The note for a rule-scored payment when ML was on but not used; '' otherwise. */
export const fallbackText = (scoring) => (scoring?.engine === 'RULES' && scoring.fallbackReason
  ? (FALLBACK_TEXT[scoring.fallbackReason] ?? FALLBACK_DEFAULT)
  : '');
