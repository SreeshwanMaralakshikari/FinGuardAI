// SubmitTransaction: payload (blank stripping, deviceId), free-text merchant category (N-18), result view
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
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sends a trimmed payload with blank optional fields removed and the stable deviceId', async () => {
    api.post.mockResolvedValueOnce(ok(RESULT));
    renderPage();
    type(/amount/i, '1200');
    type(/merchant name/i, '  Cafe  ');
    submit();
    expect(await screen.findByText('TXN-2026-00001')).toBeInTheDocument();

    const [path, payload] = api.post.mock.calls[0];
    expect(path).toBe('/customer-api/transactions');
    expect(payload).toEqual({ amount: 1200, merchantName: 'Cafe', paymentMethod: 'UPI', deviceId: expect.stringMatching(/^web-/) });
    expect(payload).not.toHaveProperty('merchantCategory'); // blank → omitted (the API rejects empty strings)
    expect(payload).not.toHaveProperty('location');
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
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Amount must be greater than 0');
    expect(screen.getByLabelText(/merchant name/i)).toHaveValue('Shop');
  });

  it('shows the result and lets the user submit another', async () => {
    api.post.mockResolvedValueOnce(ok({ ...RESULT, status: 'HELD', riskLevel: 'HIGH', recommendedAction: 'HOLD', fraudAlert: { id: 'a1' }, reasons: ['Amount is unusually high'] }));
    renderPage();
    type(/amount/i, '99999');
    type(/merchant name/i, 'Big Shop');
    submit();
    expect(await screen.findByText('Held for review by a fraud analyst.')).toBeInTheDocument();
    expect(screen.getByText('Amount is unusually high')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view fraud alerts/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /submit another/i }));
    expect(screen.getByLabelText(/merchant name/i)).toHaveValue('');
  });
});
