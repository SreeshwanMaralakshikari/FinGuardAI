// tests/round4.response.test.js — Round 4 "Was this you?" (POST /customer-api/transactions/:id/response).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import jwt from 'jsonwebtoken';
import supertest from 'supertest';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser, seedAnalyst, uniqueEmail } from './helpers/seedUser.js';
import { seedTransaction } from './helpers/seedTransaction.js';
import TransactionModel from '../models/TransactionModel.js';
import FraudAlertModel from '../models/FraudAlertModel.js';
import FraudCaseModel from '../models/FraudCaseModel.js';
import NotificationModel from '../models/NotificationModel.js';
import AuditLogModel from '../models/AuditLogModel.js';
import { createWithSequentialId } from '../utils/generateSequentialId.js';
import app from '../app.js';

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(clearCollections);

const as = (user) => {
  const token = jwt.sign({ id: user._id, iatMs: Date.now() }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return {
    get: (url) => supertest(app).get(url).set('Cookie', `token=${token}`),
    post: (url) => supertest(app).post(url).set('Cookie', `token=${token}`).set('Origin', process.env.FRONTEND_URL),
  };
};

/** A HELD (default) payment of `user` with its OPEN alert. */
const heldPayment = async (user, overrides = {}) => {
  const transaction = await seedTransaction({
    userId: user._id, amount: 25000, merchantName: 'Gadget Hub', fraudScore: 62, riskLevel: 'HIGH',
    recommendedAction: 'HOLD', status: 'HELD', ...overrides,
  });
  const alert = await FraudAlertModel.create({
    transactionId: transaction._id, userId: user._id, alertType: 'NEW_DEVICE', riskLevel: transaction.riskLevel,
    fraudScore: transaction.fraudScore, reasons: ['New device'], status: 'OPEN',
  });
  return { transaction, alert };
};

const url = (t) => `/customer-api/transactions/${t._id}/response`;

describe('Was this you? — customer side', () => {
  it('a dispute is stored once, the status does not change, and it is audited', async () => {
    const { user } = await seedUser({ name: 'Ravi Kumar' });
    const { transaction } = await heldPayment(user);
    const res = await as(user).post(url(transaction)).send({ answer: 'DISPUTED', note: '  I was asleep  ' });
    expect(res.status).toBe(200);
    expect(res.body.data.customerResponse).toMatchObject({ answer: 'DISPUTED', note: 'I was asleep' });
    expect(res.body.message).toMatch(/did not make this payment/);

    const stored = await TransactionModel.findById(transaction._id).lean();
    expect(stored.status).toBe('HELD');                               // evidence only, never a decision
    expect(stored.customerResponse).toMatchObject({ answer: 'DISPUTED', note: 'I was asleep', respondedAt: expect.any(Date) });
    expect(await AuditLogModel.findOne({ action: 'CUSTOMER_RESPONDED', entityId: transaction.publicId }).lean())
      .toMatchObject({ actorRole: 'CUSTOMER', metadata: { answer: 'DISPUTED', hasNote: true } });

    const again = await as(user).post(url(transaction)).send({ answer: 'CONFIRMED' });
    expect(again.status).toBe(409);
    expect((await TransactionModel.findById(transaction._id).lean()).customerResponse.answer).toBe('DISPUTED');
  });

  it('works for a BLOCKED payment too, and the detail endpoint returns the answer', async () => {
    const { user } = await seedUser();
    const { transaction } = await heldPayment(user, { status: 'BLOCKED', riskLevel: 'CRITICAL', recommendedAction: 'BLOCK', fraudScore: 81 });
    expect((await as(user).post(url(transaction)).send({ answer: 'CONFIRMED' })).status).toBe(200);
    const detail = await as(user).get(`/customer-api/transactions/${transaction._id}`);
    expect(detail.body.data.transaction.customerResponse).toMatchObject({ answer: 'CONFIRMED', note: '' });
  });

  it('refuses approved payments, closed alerts, other customers\' payments and bad input', async () => {
    const { user } = await seedUser();
    const { user: other } = await seedUser({ email: uniqueEmail('other') });
    const approved = await seedTransaction({ userId: user._id });
    expect((await as(user).post(url(approved)).send({ answer: 'DISPUTED' })).status).toBe(409);

    const { transaction, alert } = await heldPayment(user);
    await FraudAlertModel.updateOne({ _id: alert._id }, { $set: { status: 'REVIEWED' } });
    const closed = await as(user).post(url(transaction)).send({ answer: 'DISPUTED' });
    expect(closed.status).toBe(409);
    expect(closed.body.message).toMatch(/already been reviewed/);

    const { transaction: mine } = await heldPayment(user, { amount: 30000 });
    expect((await as(other).post(url(mine)).send({ answer: 'DISPUTED' })).status).toBe(404);
    expect((await as(user).post(url(mine)).send({ answer: 'MAYBE' })).status).toBe(422);
    expect((await as(user).post(url(mine)).send({ answer: 'DISPUTED', note: 'x'.repeat(301) })).status).toBe(422);
    expect((await as(user).post('/customer-api/transactions/not-an-id/response').send({ answer: 'DISPUTED' })).status).toBe(422);
    expect((await TransactionModel.findById(mine._id).lean()).customerResponse).toBeUndefined();
  });
});

describe('Was this you? — analysts are told', () => {
  it('without a case: every active analyst gets a CUSTOMER_RESPONSE notification', async () => {
    const { user } = await seedUser({ name: 'Asha' });
    const { user: a1 } = await seedAnalyst({ email: uniqueEmail('a1') });
    const { user: a2 } = await seedAnalyst({ email: uniqueEmail('a2') });
    await seedAnalyst({ email: uniqueEmail('a3'), isActive: false });
    const { transaction } = await heldPayment(user);
    await as(user).post(url(transaction)).send({ answer: 'DISPUTED' });
    const notes = await NotificationModel.find({ type: 'CUSTOMER_RESPONSE' }).lean();
    expect(notes.map((n) => String(n.recipientId)).sort()).toEqual([String(a1._id), String(a2._id)].sort());
    expect(notes[0]).toMatchObject({ recipientRole: 'ANALYST', relatedEntityType: 'TRANSACTION', title: `Customer disputes ${transaction.publicId}` });
    expect(notes[0].message).toMatch(/Asha says they did NOT make this payment/);
  });

  it('with an assigned case: only that analyst, linked to the case; the flagged list shows the answer', async () => {
    const { user } = await seedUser();
    const { user: owner } = await seedAnalyst({ email: uniqueEmail('owner') });
    await seedAnalyst({ email: uniqueEmail('bystander') });
    const { transaction, alert } = await heldPayment(user);
    const fraudCase = await createWithSequentialId(FraudCaseModel, 'publicId', 'CASE', {
      fraudAlertId: alert._id, transactionId: transaction._id, userId: user._id, assignedAnalystId: owner._id, status: 'ASSIGNED',
    });
    await as(user).post(url(transaction)).send({ answer: 'CONFIRMED', note: 'Bought a laptop' });
    const notes = await NotificationModel.find({ type: 'CUSTOMER_RESPONSE' }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ recipientId: owner._id, relatedEntityType: 'FRAUD_CASE', relatedEntityId: fraudCase._id });
    expect(notes[0].message).toMatch(/Note: "Bought a laptop"/);

    const list = await as(owner).get('/analyst-api/flagged-transactions');
    expect(list.status).toBe(200);
    expect(list.body.data.find((t) => t.publicId === transaction.publicId).customerResponse).toMatchObject({ answer: 'CONFIRMED' });
  });
});
