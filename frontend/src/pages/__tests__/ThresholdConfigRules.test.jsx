// ThresholdConfig: load failure hides the form (N-04), rule parity with the server (N-13), PATCH payload
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import ThresholdConfig from '../admin/ThresholdConfig.jsx';
import { renderApp, ok, fail, signedIn } from '../../tests/utils.jsx';

vi.mock('../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../api/axios.js';

const CONFIG = {
  amountThreshold: 50000,
  velocityLimit: { maxPerHour: 5, maxPerDay: 20 },
  scoreThresholds: { mediumMin: 25, highMin: 50, criticalMin: 75 },
  locationDeviationKm: 500,
  newDeviceWeight: 20,
  highRiskMerchants: ['CASINO', 'GAMBLING'],
};
const renderPage = () => renderApp(<ThresholdConfig />, { auth: signedIn({ role: 'ADMIN' }) });
const save = () => fireEvent.click(screen.getByRole('button', { name: /save thresholds/i }));
const set = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => { vi.clearAllMocks(); });

describe('N-04: load failures', () => {
  it('a 500 shows ONLY the error and Retry — no form, no Save', async () => {
    api.get.mockRejectedValueOnce(fail(500, 'Database unavailable'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(screen.queryByLabelText(/MEDIUM from/i)).toBeNull();
    expect(screen.queryByDisplayValue('50000')).toBeNull(); // the hard-coded defaults are never shown as if real

    api.get.mockResolvedValueOnce(ok(CONFIG));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByDisplayValue('50000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save thresholds/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a network error is handled the same way', async () => {
    api.get.mockRejectedValueOnce(new Error('Network Error'));
    renderPage();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it('a 404 (never seeded) still shows the form with the engine defaults and a notice', async () => {
    api.get.mockRejectedValueOnce(fail(404, 'System configuration has not been seeded.'));
    renderPage();
    expect(await screen.findByText(/has not been created yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save thresholds/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('50000')).toBeInTheDocument();
  });
});

describe('N-13: validation matches the server', () => {
  beforeEach(() => { api.get.mockResolvedValue(ok(CONFIG)); });

  it.each([
    ['MEDIUM from', '25.5', 'Whole number required'],
    ['MEDIUM from', '0', 'Must be at least 1'],
    ['MEDIUM from', '99', 'Cannot exceed 98'],
    ['HIGH from', '1', 'Must be at least 2'],
    ['HIGH from', '100', 'Cannot exceed 99'],
    ['HIGH from', '50.5', 'Whole number required'],
    ['CRITICAL from', '2', 'Must be at least 3'],
    ['CRITICAL from', '101', 'Cannot exceed 100'],
    ['CRITICAL from', '80.2', 'Whole number required'],
    ['Max transactions per hour', '0', 'Must be at least 1'],
    ['Max transactions per hour', '2.5', 'Whole number required'],
    ['Max transactions per day', '4.5', 'Whole number required'],
    ['Max transactions per day', '3', 'Must not be less than the hourly limit'],
    ['New-device penalty (0–100)', '12.5', 'Whole number required'],
    ['New-device penalty (0–100)', '101', 'Cannot exceed 100'],
    ['New-device penalty (0–100)', '-1', 'Must be 0 or more'],
    ['High-value amount (₹)', '-5', 'Must be 0 or more'],
    ['High-value amount (₹)', '2000000000', 'Cannot exceed 1,000,000,000'],
    ['Location deviation (km)', '-1', 'Must be 0 or more'],
    ['Location deviation (km)', '1000001', 'Cannot exceed 1,000,000'],
    ['Max transactions per hour', '100001', 'Cannot exceed 100,000'],
    ['Max transactions per day', '100001', 'Cannot exceed 100,000'],
  ])('%s = %s → "%s" and nothing is sent', async (label, value, message) => {
    renderPage();
    await screen.findByDisplayValue('50000');
    set(label, value);
    save();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('ascending order is still enforced (medium < high < critical)', async () => {
    renderPage();
    await screen.findByDisplayValue('50000');
    set('HIGH from', '80');
    save();
    expect(await screen.findByText('High minimum must be less than the critical minimum')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('at most 50 merchant categories, each at most 50 characters', async () => {
    renderPage();
    await screen.findByDisplayValue('50000');
    set('Categories (comma separated)', Array.from({ length: 51 }, (_, i) => `CAT${i}`).join(', '));
    save();
    expect(await screen.findByText('At most 50 categories')).toBeInTheDocument();

    set('Categories (comma separated)', 'A'.repeat(51));
    save();
    expect(await screen.findByText('Each category must be 50 characters or fewer')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('boundary values are accepted', async () => {
    api.patch.mockResolvedValueOnce(ok(CONFIG));
    renderPage();
    await screen.findByDisplayValue('50000');
    set('MEDIUM from', '1'); set('HIGH from', '2'); set('CRITICAL from', '3');
    set('New-device penalty (0–100)', '0'); set('High-value amount (₹)', '1000000000');
    set('Categories (comma separated)', 'A'.repeat(50));
    save();
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
  });
});

describe('PATCH payload', () => {
  it('sends numbers, the nested objects and a normalised merchant list', async () => {
    api.get.mockResolvedValue(ok(CONFIG));
    api.patch.mockResolvedValueOnce(ok({ ...CONFIG, amountThreshold: 60000 }));
    renderPage();
    await screen.findByDisplayValue('50000');
    set('High-value amount (₹)', '60000');
    set('Categories (comma separated)', 'casino, crypto exchange,\ncasino ,  adult, e-commerce, !!!');
    save();
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith('/admin-api/thresholds', {
      amountThreshold: 60000,
      velocityLimit: { maxPerHour: 5, maxPerDay: 20 },
      scoreThresholds: { mediumMin: 25, highMin: 50, criticalMin: 75 },
      locationDeviationKm: 500,
      newDeviceWeight: 20,
      highRiskMerchants: ['CASINO', 'CRYPTO_EXCHANGE', 'ADULT', 'ECOMMERCE'], // same keys the server stores
    });
  });

  it('shows the server message when saving fails', async () => {
    api.get.mockResolvedValue(ok(CONFIG));
    api.patch.mockRejectedValueOnce(fail(422, 'scoreThresholds ordering violated', { errors: [{ msg: 'scoreThresholds ordering violated' }] }));
    renderPage();
    await screen.findByDisplayValue('50000');
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('scoreThresholds ordering violated');
  });
});
