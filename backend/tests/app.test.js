// tests/app.test.js — root / health probes, JSON 404, body-less requests.
import { beforeAll, afterAll, describe, it, expect } from '@jest/globals';
import supertest from 'supertest';
import { readFileSync } from 'node:fs';
import app from '../app.js';
import { connectTestDB, disconnectTestDB } from './setup.js';
import { seedUser } from './helpers/seedUser.js';
import { createAgent } from './helpers/authAgent.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const request = supertest(app);

beforeAll(async () => { await connectTestDB(); });
afterAll(async () => { await disconnectTestDB(); });

describe('D-11 root and health', () => {
  it('GET / returns 200 with the API banner', async () => {
    const res = await request.get('/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, name: 'FinGuardAI API', status: 'ok' });
  });

  it('GET /health includes the package version', async () => {
    const res = await request.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(pkg.version);
  });

  it('unknown routes still return a JSON 404', async () => {
    const res = await request.get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('body-less requests', () => {
  it('PATCH /customer-api/profile with no body is a 400, not a 500', async () => {
    const { user, password } = await seedUser({ email: `nobody${Date.now()}@test.com` });
    const agent = createAgent();
    expect((await agent.post('/auth/login').send({ email: user.email, password })).status).toBe(200);
    const res = await agent.patch('/customer-api/profile');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
