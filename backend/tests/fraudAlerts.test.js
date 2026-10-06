// tests/fraudAlerts.test.js — customer fraud alerts + notifications (Phase 4 CustomerAPI / NotificationAPI)
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '@jest/globals';
import { connectTestDB, disconnectTestDB, clearCollections } from './setup.js';
import { seedUser, seedAnalyst } from './helpers/seedUser.js';
import { seedConfig } from './helpers/seedConfig.js';
import { loginAgent } from './helpers/authAgent.js';

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => { await clearCollections(); await seedConfig(); });

const casino = { amount: 500, merchantName: 'Casino Royal', merchantCategory: 'CASINO', paymentMethod: 'UPI', deviceId: 'dev-1' };

async function customerWithAlert() {
  const { user, password } = await seedUser({ email: `alerts${Date.now()}@test.com` });
  const agent = await loginAgent(user.email, password);
  const res = await agent.post('/customer-api/transactions').send(casino);
  return { user, agent, alertId: res.body.data.fraudAlert.id };
}

describe('GET /customer-api/fraud-alerts', () => {
  it('lists own alerts with the populated transaction', async () => {
    const { agent } = await customerWithAlert();
    const res = await agent.get('/customer-api/fraud-alerts');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ alertType: 'HIGH_RISK_MERCHANT', riskLevel: 'MEDIUM', status: 'OPEN' });
    expect(res.body.data[0].transactionId.publicId).toMatch(/^TXN-/);
    expect(res.body.pagination.total).toBe(1);
  });

  it('filters by status and riskLevel', async () => {
    const { agent } = await customerWithAlert();
    expect((await agent.get('/customer-api/fraud-alerts?status=DISMISSED')).body.data).toHaveLength(0);
    expect((await agent.get('/customer-api/fraud-alerts?riskLevel=MEDIUM')).body.data).toHaveLength(1);
  });

  it('GET /:id returns one alert scoped to the owner', async () => {
    const { alertId } = await customerWithAlert();
    const { agent: other } = await customerWithAlert();
    expect((await other.get(`/customer-api/fraud-alerts/${alertId}`)).status).toBe(404);
  });

  it('an ANALYST cannot use customer endpoints (403)', async () => {
    const { user, password } = await seedAnalyst({ email: 'an@test.com' });
    const analyst = await loginAgent(user.email, password);
    expect((await analyst.get('/customer-api/fraud-alerts')).status).toBe(403);
  });
});

describe('/notification-api', () => {
  it('list, unread-count, mark one read, read-all (route order D-P4-13)', async () => {
    const { agent } = await customerWithAlert();
    await agent.post('/customer-api/transactions').send(casino);
    const list = await agent.get('/notification-api/notifications');
    expect(list.body.data).toHaveLength(2);
    expect((await agent.get('/notification-api/notifications/unread-count')).body.data.unreadCount).toBe(2);
    expect((await agent.patch(`/notification-api/notifications/${list.body.data[0]._id}/read`)).status).toBe(200);
    expect((await agent.get('/notification-api/notifications/unread-count')).body.data.unreadCount).toBe(1);
    const all = await agent.patch('/notification-api/notifications/read-all');
    expect(all.status).toBe(200);
    expect(all.body.data.modifiedCount).toBe(1);
    expect((await agent.get('/notification-api/notifications/unread-count')).body.data.unreadCount).toBe(0);
  });
});
