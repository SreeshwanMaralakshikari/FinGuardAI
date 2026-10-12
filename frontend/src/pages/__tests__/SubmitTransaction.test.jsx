// SubmitTransaction: payload (blank stripping, deviceId), free-text merchant category (N-18), result view,
// amount rules (E-07), required city (E-06), Idempotency-Key lifecycle (C-01)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import SubmitTransaction from '../customer/SubmitTransaction.jsx';
import { renderApp, ok, fail, signedIn } from '../../tests/utils.jsx';

vi.mock('../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../api/axios.js';

const renderPage = () => renderApp(<SubmitTransaction />, { auth: signedIn() });
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: /submit for fraud check/i }));

const RESULT = {
  id: 't1', publicId: 'TXN-2026-00001', amount: 1200, merchantName: 'Cafe', merchantCategory: 'FOOD', paymentMethod: 'UPI',
  fraudScore: 10, riskLevel: 'LOW', reasons: [], recommendedAction: 'APPROVE', estimatedLoss: 0, status: 'APPROVED', fraudAlert: null,
  timestamp: '2026-10-06T05:00:00Z',
};

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('SubmitTransaction', () => {
  it('validates the required fields client-side', async () => {
    renderPage();
    submit();
    expect(await screen.findByText('Amount is required')).toBeInTheDocument();
    expect(screen.getByText('Merchant name is required')).toBeInTheDocument();
    expect(screen.getByText('City is required')).toBeInTheDocument(); // E-06
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([
    ['0', 'Amount must be at least ₹0.01'],
    ['0.005', 'Amount must be at least ₹0.01'],
    ['-5', 'Amount must be at least ₹0.01'],
    ['10.123', 'Amount can have at most 2 decimal places'],
    ['1000000001', 'Amount cannot exceed ₹100 crore'],
  ])('E-07: amount %s is rejected in the form ("%s")', async (value, message) => {
    renderPage();
    type(/amount/i, value);
    type(/merchant name/i, 'Shop');
    type(/city/i, 'Pune');
    submit();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each(['0.01', '10', '10.5', '10.55', '1.1', '19.99'])('E-07: amount %s is accepted', async (value) => {
    api.post.mockResolvedValueOnce(ok(RESULT));
    renderPage();
    type(/amount/i, value);
    type(/merchant name/i, 'Shop');
    type(/city/i, 'Pune');
    submit();
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1].amount).toBe(Number(value));
  });

  it('E-06: a blank or whitespace-only city is refused client-side (the server requires location.city)', async () => {
    renderPage();
    type(/amount/i, '5');
    type(/merchant name/i, 'Shop');
    type(/city/i, '   ');
    submit();
    expect(await screen.findByText('City is required')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sends a trimmed payload with blank optional fields removed and the stable deviceId', async () => {
    api.post.mockResolvedValueOnce(ok(RESULT));
    renderPage();
    type(/amount/i, '1200');
    type(/merchant name/i, '  Cafe  ');
    type(/city/i, ' Pune ');
    submit();
    expect(await screen.findByText('TXN-2026-00001')).toBeInTheDocument();

    const [path, payload] = api.post.mock.calls[0];
    expect(path).toBe('/customer-api/transactions');
    expect(payload).toEqual({
      amount: 1200, merchantName: 'Cafe', paymentMethod: 'UPI', deviceId: expect.stringMatching(/^web-/),
      location: { city: 'Pune' }, // E-06: always present; the blank country is omitted
    });
    expect(payload).not.toHaveProperty('merchantCategory'); // blank → omitted (the API rejects empty strings)
    expect(payload).not.toHaveProperty('idempotencyKey'); // travels as a header, not in the body
    expect(localStorage.getItem('finguard:device-id')).toBe(payload.deviceId); // same id on the next submit
  });

  it('N-18: any category can be typed (admins add categories); city is trimmed and sent as typed', async () => {
    api.post.mockResolvedValueOnce(ok(RESULT));
    renderPage();
    type(/amount/i, '50');
    type(/merchant name/i, 'Shop');
    type(/merchant category/i, 'LUXURY_GOODS'); // not in the suggestion list
    type(/city/i, '  mumbai ');
    type(/country/i, 'India');
    submit();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1]).toMatchObject({
      merchantCategory: 'LUXURY_GOODS', location: { city: 'mumbai', country: 'India' },
    });
  });

  it('offers the known categories as suggestions (datalist)', () => {
    const { container } = renderPage();
    const input = screen.getByLabelText(/merchant category/i);
    expect(input).toHaveAttribute('list', 'merchant-category-options');
    const values = [...container.querySelectorAll('#merchant-category-options option')].map((o) => o.getAttribute('value'));
    expect(values).toEqual(expect.arrayContaining(['GENERAL', 'CASINO', 'CRYPTO_EXCHANGE']));
  });

  it('shows the server message and keeps the form when the request fails', async () => {
    api.post.mockRejectedValueOnce(fail(422, 'Amount must be greater than 0', { errors: [{ msg: 'Amount must be greater than 0' }] }));
    renderPage();
    type(/amount/i, '5');
    type(/merchant name/i, 'Shop');
    type(/city/i, 'Pune');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Amount must be greater than 0');
    expect(screen.getByLabelText(/merchant name/i)).toHaveValue('Shop');
  });

  it('shows the result and lets the user submit another', async () => {
    api.post.mockResolvedValueOnce(ok({ ...RESULT, status: 'HELD', riskLevel: 'HIGH', recommendedAction: 'HOLD', fraudAlert: { id: 'a1' }, reasons: ['Amount is unusually high'] }));
    renderPage();
    type(/amount/i, '99999');
    type(/merchant name/i, 'Big Shop');
    type(/city/i, 'Pune');
    submit();
    expect(await screen.findByText('Held for review by a fraud analyst.')).toBeInTheDocument();
    expect(screen.getByText('Amount is unusually high')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view fraud alerts/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /submit another/i }));
    expect(screen.getByLabelText(/merchant name/i)).toHaveValue('');
  });

  describe('C-01: Idempotency-Key', () => {
    const fill = () => { type(/amount/i, '25'); type(/merchant name/i, 'Shop'); type(/city/i, 'Pune'); };
    const keyOf = (call) => call[2]?.headers?.['Idempotency-Key'];
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    it('sends a UUID in the Idempotency-Key header and keeps it out of the body', async () => {
      api.post.mockResolvedValueOnce(ok(RESULT));
      renderPage();
      fill();
      submit();
      await screen.findByText('TXN-2026-00001');
      expect(keyOf(api.post.mock.calls[0])).toMatch(UUID);
    });

    it('REUSES the key when the user retries after a failure, and issues a new one after a success', async () => {
      api.post
        .mockRejectedValueOnce(fail(500, 'Something broke'))
        .mockResolvedValueOnce(ok(RESULT))
        .mockResolvedValueOnce(ok({ ...RESULT, publicId: 'TXN-2026-00002' }));
      renderPage();
      fill();
      submit();
      await screen.findByRole('alert');
      submit(); // retry
      await screen.findByText('TXN-2026-00001');
      const [first, retry] = api.post.mock.calls.map(keyOf);
      expect(retry).toBe(first);

      fireEvent.click(screen.getByRole('button', { name: /submit another/i }));
      fill();
      submit();
      await screen.findByText('TXN-2026-00002');
      const third = keyOf(api.post.mock.calls[2]);
      expect(third).toMatch(UUID);
      expect(third).not.toBe(first); // a success ends the attempt
    });

    it('without any server response it warns that the payment may exist and points to Transaction history', async () => {
      api.post.mockRejectedValueOnce(Object.assign(new Error('timeout of 20000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' }));
      renderPage();
      fill();
      submit();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Cannot reach the server');
      expect(alert).toHaveTextContent(/check Transaction history before trying again/i);
    });

    it('a normal server error does NOT carry the "check history" warning', async () => {
      api.post.mockRejectedValueOnce(fail(422, 'Amount must be greater than 0'));
      renderPage();
      fill();
      submit();
      expect(await screen.findByRole('alert')).not.toHaveTextContent(/transaction history/i);
    });
  });
});
