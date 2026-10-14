// tests/helpers/fakeMlService.js — Phase 10: a stand-in for ml-service/ on a random local port.
// It answers like the real Flask service (same JSON shape) and records every request, so tests can
// check the exact features the backend sent. Behaviour is switched per test with `respondWith`.
import http from 'node:http';
import { ML_FEATURE_KEYS } from '../../utils/enums.js';

export const FAKE_ML_KEY = 'fake-ml-key-'.padEnd(48, 'k');

/** A valid /predict body (contributions for all 15 features, strongest first). */
export const mlAnswer = ({
  fraudScore = 88,
  fraudProbability = fraudScore / 100,
  modelVersion = 'fg-xgb-test',
  reasons = ['Payment from a device the customer has not used before', 'Amount is 10.0× the customer\'s usual average'],
  reasonFeatures = ['isNewDevice', 'amountToAvgRatio'],
  top = { isNewDevice: 3.2, amountToAvgRatio: 2.1 },
} = {}) => ({
  modelVersion,
  fraudProbability,
  fraudScore,
  baseValue: -5.5,
  contributions: [
    ...Object.entries(top).map(([feature, shap]) => ({ feature, value: 1, shap })),
    ...ML_FEATURE_KEYS.filter((f) => !(f in top)).map((feature) => ({
      feature, value: feature === 'paymentMethod' ? 'UPI' : 0, shap: -0.01,
    })),
  ],
  reasons,
  reasonFeatures,
});

/**
 * Start the fake service. `respondWith(fn)` sets the handler: fn(features) → { status, body, delayMs, raw }.
 * @returns {Promise<{ url: string, requests: object[], respondWith: Function, close: Function }>}
 */
export async function startFakeMlService() {
  const requests = [];
  const timers = new Set(); // pending delayed replies, cleared on close so Jest can exit
  let handler = () => ({ status: 200, body: mlAnswer() });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', modelVersion: 'fg-xgb-test' }));
        return;
      }
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ url: req.url, headers: req.headers, body });
      if (req.headers['x-api-key'] !== FAKE_ML_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }));
        return;
      }
      const reply = handler(body?.features) ?? {};
      if (reply.delayMs) {
        await new Promise((r) => {
          const timer = setTimeout(() => { timers.delete(timer); r(); }, reply.delayMs);
          timers.add(timer);
        });
      }
      if (res.destroyed) return;
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respondWith: (fn) => { handler = fn; },
    close: () => new Promise((resolve) => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
