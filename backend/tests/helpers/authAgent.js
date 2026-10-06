// tests/helpers/authAgent.js
import supertest from 'supertest';
import app from '../../app.js';

let ipCounter = 0;

/** A fresh client IP per simulated user (see tests/env.js). */
export const nextIp = () => {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

/**
 * Supertest agent that keeps the HTTP-only `token` cookie between requests (D-P8-04).
 * Every request from this agent carries the same X-Forwarded-For client IP.
 */
export function createAgent(ip = nextIp()) {
  return supertest.agent(app).set('X-Forwarded-For', ip);
}

/** Log in and return the authenticated agent. Throws if login fails. */
export async function loginAgent(email, password) {
  const agent = createAgent();
  const res = await agent.post('/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
