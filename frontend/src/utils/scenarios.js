/**
 * @file src/utils/scenarios.js
 * @description R4-03: one-click example payments for the "Submit a transaction" page (demos and the viva).
 *   A preset only fills the form; the customer still presses the button and the real engines score it, so
 *   the outcome depends on the customer's history (a brand-new account has no "usual" city or device yet).
 *   TEJAS D1: every scenario sets `payeeVpa` (empty = pay the merchant), so switching examples never keeps the UPI ID
 *   of the previous one.
 */
const newDeviceId = () => `new-phone-${Math.random().toString(36).slice(2, 6)}`;

export const SCENARIOS = Object.freeze([
  {
    key: 'everyday',
    label: 'Everyday payment',
    hint: 'Small grocery payment from your usual phone and city: expect LOW.',
    values: ({ deviceId, city }) => ({
      amount: 850, merchantName: 'Daily Mart', merchantCategory: 'GROCERY', paymentMethod: 'UPI', payeeVpa: 'dailymart@okaxis', deviceId, city: city || 'Mumbai',
    }),
  },
  {
    key: 'takeover',
    label: 'Account takeover',
    hint: 'Large purchase from a phone you have never used, in a new city: expect HIGH or CRITICAL.',
    values: () => ({
      amount: 25000, merchantName: 'Gadget Hub', merchantCategory: 'ELECTRONICS', paymentMethod: 'CARD', payeeVpa: '', deviceId: newDeviceId(), city: 'Guwahati',
    }),
  },
  {
    key: 'casino',
    label: 'High-risk merchant',
    hint: 'Casino payment from your usual phone: the policy check raises an alert (MEDIUM).',
    values: ({ deviceId, city }) => ({
      amount: 1500, merchantName: 'Lucky Spin', merchantCategory: 'CASINO', paymentMethod: 'UPI', payeeVpa: 'luckyspin.pay@ybl', deviceId, city: city || 'Mumbai',
    }),
  },
  {
    key: 'large',
    label: 'Very large payment',
    hint: 'Above the ₹50,000 high-value limit from your usual phone: at least MEDIUM once you have some history.',
    values: ({ deviceId, city }) => ({
      amount: 75000, merchantName: 'Prime Jewellers', merchantCategory: 'JEWELLERY', paymentMethod: 'NET_BANKING', payeeVpa: '', deviceId, city: city || 'Mumbai',
    }),
  },
  {
    // TEJAS D1: a "helpdesk" UPI ID that many customers are told to pay (how mule accounts collect money). Analysts
    // see on the payee profile how many different customers paid it today.
    key: 'mule',
    label: 'Unknown UPI ID',
    hint: 'A UPI transfer to an ID you have never paid, which other customers are also paying today. Analysts can see that pattern.',
    values: ({ deviceId, city }) => ({
      amount: 9500, merchantName: 'Easy Loan Helpdesk', merchantCategory: 'TRANSFER', paymentMethod: 'UPI', payeeVpa: 'easyloan.helpdesk@ybl', deviceId, city: city || 'Mumbai',
    }),
  },
]);
