// tests/helpers/authAgent.js
import http from 'node:http';
import { afterAll } from '@jest/globals';
import supertest from 'supertest';
import app from '../../app.js';

let ipCounter = 0;

/** A fresh client IP per simulated user (see tests/env.js). */
const nextIp = () => {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

// T-05: ONE listening server per test file, shared by every agent. supertest otherwise opens a server
// per agent and adds listening / error / close listeners to it for every request, which produced
// "MaxListenersExceededWarning: 11 listeners added to [Server]". closeAgentServer() runs in an afterAll registered below.
let sharedServer = null;
const getServer = () => {
  if (!sharedServer) sharedServer = http.createServer(app).listen(0);
  return sharedServer;
};

export const closeAgentServer = async () => {
  const server = sharedServer;
  sharedServer = null;
  if (server) await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
};

afterAll(closeAgentServer); // registered when a test file imports this helper

/**
 * Supertest agent that keeps the HTTP-only `token` cookie between requests (D-P8-04).
 * Every request from this agent carries the same X-Forwarded-For client IP.
 */
export function createAgent(ip = nextIp()) {
  return supertest.agent(getServer()).set('X-Forwarded-For', ip);
}

/** Log in and return the authenticated agent. Throws if login fails. */
export async function loginAgent(email, password) {
  const agent = createAgent();
  const res = await agent.post('/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
