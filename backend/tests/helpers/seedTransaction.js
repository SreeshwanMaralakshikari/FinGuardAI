// tests/helpers/seedTransaction.js
import TransactionModel from '../../models/TransactionModel.js';
import { createWithSequentialId } from '../../utils/generateSequentialId.js';

/** Insert a transaction (with its TXN public ID) directly, bypassing fraud scoring. */
export async function seedTransaction(overrides = {}) {
  if (!overrides.userId) throw new Error('seedTransaction: userId is required');
  return createWithSequentialId(TransactionModel, 'publicId', 'TXN', {
    amount: 1000,
    merchantName: 'TestMerchant',
    merchantCategory: 'RETAIL',
    paymentMethod: 'UPI',
    deviceId: 'device-001',
    location: { city: 'Mumbai', country: 'IN' },
    ipAddress: '127.0.0.1',
    fraudScore: 10,
    riskLevel: 'LOW',
    recommendedAction: 'APPROVE',
    reasons: [],
    status: 'APPROVED',
    ...overrides,
  });
}
