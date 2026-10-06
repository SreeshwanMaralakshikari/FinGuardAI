// src/api/__tests__/axios.test.js — AUD-31: FormData uploads are not converted to JSON
import { it, expect } from 'vitest';
import api from '../axios.js';
import { markServerContact } from '../serverHealth.js';

it('sends FormData unchanged (profile image upload) and plain objects as JSON', async () => {
  const seen = [];
  const adapter = async (config) => {
    seen.push({ data: config.data, type: config.headers.getContentType() });
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
  };
  markServerContact(); // otherwise the first mutation waits for /health (D-P9-14 wake-before-write)
  const fd = new FormData();
  fd.append('profileImage', new Blob(['x'], { type: 'image/png' }), 'a.png');
  await api.patch('/customer-api/profile', fd, { adapter });
  await api.post('/customer-api/transactions', { amount: 5 }, { adapter });

  expect(seen[0].data).toBeInstanceOf(FormData);          // not JSON.stringify'd
  expect(String(seen[0].type)).not.toMatch(/json/);
  expect(seen[1]).toMatchObject({ data: '{"amount":5}' });
  expect(String(seen[1].type)).toMatch(/application\/json/);
});
