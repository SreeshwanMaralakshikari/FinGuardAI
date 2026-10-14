/**
 * @file src/components/landing/samples.js
 * @description Round 4: the three sample results the landing page replays (ScoringReplay). Recorded end to end
 *   with the real backend and the real ML service on 14 Oct 2026; keep them in sync with what the system does.
 */
export const SAMPLES = [
  {
    key: 'normal',
    tab: 'Everyday payment',
    merchant: 'Daily Mart',
    amount: '₹900',
    facts: ['Usual phone', 'Usual city (Mumbai)', 'Usual time of day'],
    rules: 0,
    ml: 0,
    final: 0,
    level: 'LOW',
    outcome: 'Approved',
    note: 'Nothing unusual: the model and the rules agree.',
  },
  {
    key: 'takeover',
    tab: 'Account takeover',
    merchant: 'Gadget Hub',
    amount: '₹20,000',
    facts: ['A phone never used before', 'New city (Delhi)', '21.7× the usual amount'],
    rules: 65,
    ml: 81,
    final: 81,
    level: 'CRITICAL',
    outcome: 'Blocked',
    note: 'The model weighs the three signals together and blocks the payment; the rules alone would only hold it.',
  },
  {
    key: 'casino',
    tab: 'Policy check',
    merchant: 'Lucky Spin (casino)',
    amount: '₹1,500',
    facts: ['Usual phone', 'Sixth payment this hour', 'Merchant on the high-risk list'],
    rules: 50,
    ml: 1,
    final: 49,
    level: 'MEDIUM',
    outcome: 'Approved, customer alerted',
    note: 'The model sees nothing odd, but the admin listed casinos as high-risk, so the payment still raises an alert.',
  },
];
