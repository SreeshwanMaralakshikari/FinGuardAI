// T-02: the pages and components that had no tests — ChangePasswordForm, Account, Profile, TrustScore,
// FraudAlerts, AuditLogs, AdminTrends, FraudPatterns, TrendChart. Also E-19 (contrast, Actions headers),
// F-09 (trust explainer) and F-07 (abort signal passed to GETs).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within, render } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import ChangePasswordForm from '../../components/shared/ChangePasswordForm.jsx';
import Account from '../shared/Account.jsx';
import Profile from '../customer/Profile.jsx';
import TrustScore from '../customer/TrustScore.jsx';
import FraudAlerts from '../customer/FraudAlerts.jsx';
import AuditLogs from '../admin/AuditLogs.jsx';
import AdminTrends from '../admin/AdminTrends.jsx';
import FraudPatterns from '../analyst/FraudPatterns.jsx';
import TrendChart from '../../components/charts/TrendChart.jsx';
import { renderApp, ok, page, fail, signedIn } from '../../tests/utils.jsx';

vi.mock('../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
import api from '../../api/axios.js';
import toast from 'react-hot-toast';

const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const click = (name) => fireEvent.click(screen.getByRole('button', { name }));

beforeEach(() => { vi.clearAllMocks(); });

// ─── ChangePasswordForm / Account ────────────────────────────────────────────

describe('ChangePasswordForm', () => {
  const renderForm = () => renderApp(
    <Routes><Route path="/" element={<ChangePasswordForm />} /><Route path="/login" element={<p>login screen</p>} /></Routes>,
    { auth: signedIn() },
  );
  const fill = (cur = 'oldpassword', next = 'newpassword1', confirm = next) => {
    type('Current password', cur); type('New password', next); type('Confirm new password', confirm);
  };

  it('requires every field', async () => {
    renderForm();
    click('Update password');
    expect(await screen.findByText('Current password is required')).toBeInTheDocument();
    expect(screen.getByText('New password is required')).toBeInTheDocument();
    expect(screen.getByText('Please confirm the new password')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it.each([
    [['oldpassword', 'short', 'short'], 'New password must be at least 8 characters'],
    [['oldpassword', 'oldpassword', 'oldpassword'], 'New password must be different from the current password'],
    [['oldpassword', 'newpassword1', 'newpassword2'], 'Passwords do not match'],
    [['oldpassword', 'x'.repeat(73), 'x'.repeat(73)], 'Password cannot exceed 72 characters'],
  ])('rejects %j → "%s"', async (values, message) => {
    renderForm();
    fill(...values);
    click('Update password');
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('success: PATCH /auth/change-password, toast, store reset and redirect to /login', async () => {
    api.patch.mockResolvedValueOnce(ok(null));
    const { store } = renderForm();
    fill();
    click('Update password');
    expect(await screen.findByText('login screen')).toBeInTheDocument();
    expect(api.patch).toHaveBeenCalledWith('/auth/change-password', { currentPassword: 'oldpassword', newPassword: 'newpassword1' });
    expect(toast.success).toHaveBeenCalledWith('Password changed — please sign in again.');
    expect(store.getState().auth.isAuthenticated).toBe(false);
  });

  it('shows the server reason and keeps the user signed in when it fails', async () => {
    api.patch.mockRejectedValueOnce(fail(401, 'Current password is incorrect'));
    const { store } = renderForm();
    fill();
    click('Update password');
    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect');
    expect(store.getState().auth.isAuthenticated).toBe(true);
    expect(screen.queryByText('login screen')).toBeNull();
  });
});

describe('Account (ANALYST / ADMIN)', () => {
  it('shows the identity read-only and the password form', () => {
    renderApp(<Account />, { auth: signedIn({ role: 'ADMIN', name: 'Asha Rao', email: 'asha@example.com' }) });
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument();
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('asha@example.com')).toBeInTheDocument();
    expect(screen.getByText('ADMIN')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Change password' })).toBeInTheDocument();
  });
});

// ─── Profile ─────────────────────────────────────────────────────────────────

describe('Profile', () => {
  const PROFILE = { name: 'Asha Rao', email: 'asha@example.com', profileImage: null, lastLogin: '2026-10-05T05:00:00Z' };
  const renderProfile = () => renderApp(<Profile />, { auth: signedIn({ name: 'Asha Rao' }) });

  it('loads the profile into the form (with the abort signal) and shows the e-mail', async () => {
    api.get.mockResolvedValue(ok(PROFILE));
    renderProfile();
    expect(await screen.findByDisplayValue('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('asha@example.com')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/customer-api/profile', { signal: expect.any(AbortSignal) });
  });

  it('a failed load shows the error and Retry — not an empty form that could overwrite the name', async () => {
    api.get.mockRejectedValueOnce(fail(500, 'Database unavailable')).mockResolvedValueOnce(ok(PROFILE));
    renderProfile();
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    click('Retry');
    expect(await screen.findByDisplayValue('Asha Rao')).toBeInTheDocument();
  });

  it('validates the name like registration does', async () => {
    api.get.mockResolvedValue(ok(PROFILE));
    renderProfile();
    await screen.findByDisplayValue('Asha Rao');
    type('Full name', ' A ');
    click('Save changes');
    expect(await screen.findByText('Name must be at least 2 characters')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('saves a trimmed name as multipart FormData, updates the store and reloads', async () => {
    api.get.mockResolvedValue(ok(PROFILE));
    api.patch.mockResolvedValueOnce(ok({ name: 'Asha R', profileImage: null }));
    const { store } = renderProfile();
    await screen.findByDisplayValue('Asha Rao');
    type('Full name', '  Asha R  ');
    click('Save changes');
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [path, body] = api.patch.mock.calls[0];
    expect(path).toBe('/customer-api/profile');
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('name')).toBe('Asha R');
    expect(body.has('profileImage')).toBe(false);
    await waitFor(() => expect(store.getState().auth.user.name).toBe('Asha R'));
    expect(toast.success).toHaveBeenCalledWith('Profile updated');
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(1)); // reload()
  });

  it('rejects a wrong file type and an oversized image before anything is sent', async () => {
    api.get.mockResolvedValue(ok(PROFILE));
    renderProfile();
    await screen.findByDisplayValue('Asha Rao');
    const input = () => screen.getByLabelText('Profile picture');
    fireEvent.change(input(), { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } });
    expect(await screen.findByText('Only JPG, PNG or WebP images are allowed.')).toBeInTheDocument();
    const big = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 });
    fireEvent.change(input(), { target: { files: [big] } });
    expect(await screen.findByText('The image must be 2 MB or smaller.')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('a valid image is previewed and sent as `profileImage`', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    api.get.mockResolvedValue(ok(PROFILE));
    api.patch.mockResolvedValueOnce(ok({ name: 'Asha Rao', profileImage: 'https://img/x.png' }));
    renderProfile();
    await screen.findByDisplayValue('Asha Rao');
    const file = new File(['x'], 'me.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Profile picture'), { target: { files: [file] } });
    expect(await screen.findByAltText('Profile')).toHaveAttribute('src', 'blob:preview');
    click('Save changes');
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1].get('profileImage')).toBe(file);
  });

  it('shows the server message when saving fails', async () => {
    api.get.mockResolvedValue(ok(PROFILE));
    api.patch.mockRejectedValueOnce(fail(422, 'Name is invalid', { errors: [{ msg: 'Name is invalid' }] }));
    renderProfile();
    await screen.findByDisplayValue('Asha Rao');
    click('Save changes');
    expect(await screen.findByRole('alert')).toHaveTextContent('Name is invalid');
  });
});

// ─── TrustScore ──────────────────────────────────────────────────────────────

describe('TrustScore', () => {
  const SUMMARY = {
    avgTransactionAmount: 1500, maxTransactionAmount: 9000, usualLocations: ['Mumbai', 'Pune'], usualPaymentMethods: ['UPI', 'NET_BANKING'],
    lastUpdated: '2026-10-05T05:00:00Z', transactionVelocity: { perHour: 2, perDay: 7 },
  };
  const serve = ({ trust = { trustScore: 72, behaviorSummary: SUMMARY }, txs = [] } = {}) => {
    api.get.mockImplementation(async (url) => (url.endsWith('trust-score') ? ok(trust) : page(txs)));
  };
  const renderTrust = () => renderApp(<TrustScore />, { auth: signedIn() });

  it.each([
    [95, 'Excellent', 'text-emerald-700'],
    [72, 'Good', 'text-green-700'],
    [45, 'Fair', 'text-yellow-700'],
    [10, 'Poor', 'text-red-600'],
  ])('score %i is "%s" and its label uses the accessible colour %s (E-19)', async (score, label, cls) => {
    serve({ trust: { trustScore: score, behaviorSummary: null } });
    renderTrust();
    const text = await screen.findByText(label, { selector: 'p.text-xl' });
    expect(text).toHaveClass(cls);
    expect(screen.getByRole('img', { name: `Trust score ${score} out of 100, ${label}` })).toBeInTheDocument();
  });

  it('shows the behaviour summary the API returns, including the live payment counts (F-09)', async () => {
    serve();
    renderTrust();
    expect(await screen.findByText('Mumbai, Pune')).toBeInTheDocument();
    expect(screen.getByText('UPI, NET BANKING')).toBeInTheDocument();
    expect(screen.getByText('Payments in the last hour').nextSibling).toHaveTextContent('2');
    expect(screen.getByText('Payments in the last 24 hours').nextSibling).toHaveTextContent('7');
    expect(screen.getByText('₹1,500.00')).toBeInTheDocument();
  });

  it('F-09: explains the formula (no invented per-outcome counts)', async () => {
    serve();
    renderTrust();
    const explainer = await screen.findByRole('region', { name: 'How is this calculated?' });
    expect(explainer).toHaveTextContent('score = (approved + ½ × held + 1) ÷ (all payments + 2) × 100');
    expect(explainer).toHaveTextContent(/held payments count half, blocked payments count nothing/i);
    expect(explainer).toHaveTextContent('Ten approved payments give 92');
  });

  it('without a behaviour profile it says so', async () => {
    serve({ trust: { trustScore: 50, behaviorSummary: null } });
    renderTrust();
    expect(await screen.findByText(/not enough approved activity yet/i)).toBeInTheDocument();
    expect(screen.queryByText('Payments in the last hour')).toBeNull();
  });

  it('lists the last transactions, or says there are none', async () => {
    serve({ txs: [{ _id: 't1', merchantName: 'Cafe', amount: 120, riskLevel: 'LOW', status: 'APPROVED', timestamp: '2026-10-05T05:00:00Z' }] });
    const { unmount } = renderTrust();
    expect(await screen.findByText('Cafe')).toBeInTheDocument();
    unmount();
    serve();
    renderTrust();
    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();
  });

  it('a failed load shows the error and Retry', async () => {
    api.get.mockRejectedValue(fail(500, 'Trust service down'));
    renderTrust();
    expect(await screen.findByRole('alert')).toHaveTextContent('Trust service down');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

// ─── FraudAlerts ─────────────────────────────────────────────────────────────

describe('FraudAlerts', () => {
  const ALERT = {
    _id: 'a1', alertType: 'HIGH_AMOUNT', riskLevel: 'HIGH', status: 'OPEN', fraudScore: 62, createdAt: '2026-10-05T05:00:00Z',
    reasons: ['Amount is unusually high'], transactionId: { publicId: 'TXN-1', amount: 99000, merchantName: 'Big Shop', status: 'HELD' },
  };
  const renderAlerts = () => renderApp(<FraudAlerts />, { auth: signedIn() });

  it('lists alerts with merchant, amount, score and reasons', async () => {
    api.get.mockResolvedValue(page([ALERT]));
    renderAlerts();
    expect(await screen.findByText('Big Shop')).toBeInTheDocument();
    expect(screen.getByText('· TXN-1')).toBeInTheDocument();
    expect(screen.getByText('₹99,000.00')).toBeInTheDocument();
    expect(screen.getByText('62/100')).toBeInTheDocument();
    expect(screen.getByText('Amount is unusually high')).toBeInTheDocument();
    expect(screen.getByText(/HIGH AMOUNT/)).toBeInTheDocument();
  });

  it('sends the filters as params and goes back to page 1', async () => {
    api.get.mockResolvedValue(page([ALERT]));
    renderAlerts();
    await screen.findByText('Big Shop');
    type('Risk level', 'CRITICAL');
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/customer-api/fraud-alerts', { params: { page: 1, limit: 10, riskLevel: 'CRITICAL' } }));
    type('Status', 'DISMISSED');
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/customer-api/fraud-alerts', { params: { page: 1, limit: 10, riskLevel: 'CRITICAL', status: 'DISMISSED' } }));
    expect(within(screen.getByLabelText('Risk level')).queryByRole('option', { name: 'LOW' })).toBeNull(); // LOW never raises an alert
  });

  it('an empty result is a calm message; a failed load is an error with Retry, never an all-clear', async () => {
    api.get.mockResolvedValueOnce(page([]));
    const { unmount } = renderAlerts();
    expect(await screen.findByText('No fraud alerts')).toBeInTheDocument();
    unmount();

    api.get.mockRejectedValueOnce(fail(500, 'Alerts unavailable')).mockResolvedValueOnce(page([ALERT]));
    renderAlerts();
    expect(await screen.findByRole('alert')).toHaveTextContent('Alerts unavailable');
    expect(screen.queryByText('No fraud alerts')).toBeNull();
    click('Retry');
    expect(await screen.findByText('Big Shop')).toBeInTheDocument();
  });
});

// ─── AuditLogs ───────────────────────────────────────────────────────────────

describe('AuditLogs', () => {
  const LOG = {
    _id: 'l1', action: 'USER_DEACTIVATED', entityType: 'User', entityId: 'u9', ipAddress: '10.0.0.1', actorRole: 'ADMIN',
    actorId: { name: 'Root Admin' }, timestamp: '2026-10-05T05:00:00Z', metadata: { reason: 'abuse' },
  };
  const renderLogs = () => renderApp(<AuditLogs />, { auth: signedIn({ role: 'ADMIN' }) });

  it('lists entries, passes the abort signal, and gives the action column an accessible name (E-19)', async () => {
    api.get.mockResolvedValue(page([LOG], 1, 1, 50));
    renderLogs();
    expect(await screen.findByText('USER DEACTIVATED')).toBeInTheDocument();
    expect(screen.getByText('Root Admin')).toBeInTheDocument();
    expect(screen.getByText('10.0.0.1')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/admin-api/audit-logs', { params: { page: 1, limit: 50 }, signal: expect.any(AbortSignal) });
    const headers = screen.getAllByRole('columnheader');
    expect(headers.every((h) => h.textContent.trim() !== '')).toBe(true); // no empty <th>
    expect(within(headers.at(-1)).getByText('Actions')).toHaveClass('sr-only');
  });

  it('shows the first load as a table skeleton, not a bare spinner (F-05)', async () => {
    api.get.mockReturnValue(new Promise(() => {}));
    const { container } = renderLogs();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('filters become request params (dates as IST bounds) and reset the page', async () => {
    api.get.mockResolvedValue(page([LOG], 1, 1, 50));
    renderLogs();
    await screen.findByText('USER DEACTIVATED');
    type('Actor role', 'ADMIN');
    type('Entity type', 'User');
    type('From', '2026-10-01');
    type('To', '2026-10-05');
    await waitFor(() => expect(api.get.mock.calls.at(-1)[1].params).toEqual({
      page: 1, limit: 50, actorRole: 'ADMIN', entityType: 'User',
      startDate: '2026-10-01T00:00:00.000+05:30', endDate: '2026-10-05T23:59:59.999+05:30',
    }));
    click('Clear filters');
    await waitFor(() => expect(api.get.mock.calls.at(-1)[1].params).toEqual({ page: 1, limit: 50 }));
  });

  it('metadata can be shown and hidden per row', async () => {
    api.get.mockResolvedValue(page([LOG], 1, 1, 50));
    renderLogs();
    await screen.findByText('USER DEACTIVATED');
    click('Details');
    expect(screen.getByText(/"reason": "abuse"/)).toBeInTheDocument();
    click('Hide');
    expect(screen.queryByText(/"reason": "abuse"/)).toBeNull();
  });

  it('empty → "No audit entries"; failure → error + Retry', async () => {
    api.get.mockResolvedValueOnce(page([], 0, 1, 50));
    const { unmount } = renderLogs();
    expect(await screen.findByText('No audit entries')).toBeInTheDocument();
    unmount();
    api.get.mockRejectedValueOnce(fail(500, 'Audit store down')).mockResolvedValueOnce(page([LOG], 1, 1, 50));
    renderLogs();
    expect(await screen.findByRole('alert')).toHaveTextContent('Audit store down');
    click('Retry');
    expect(await screen.findByText('USER DEACTIVATED')).toBeInTheDocument();
  });
});

// ─── AdminTrends / TrendChart ────────────────────────────────────────────────

describe('AdminTrends', () => {
  const DAYS = [
    { date: '2026-10-03', count: 2, totalAmount: 1000, avgFraudScore: 60, movingAvg: 1 },
    { date: '2026-10-04', count: 4, totalAmount: 3000, avgFraudScore: 70, movingAvg: 2.5 },
  ];
  const renderTrends = () => renderApp(<AdminTrends />, { auth: signedIn({ role: 'ADMIN' }) });

  it('shows the totals, the current average and the peak hours', async () => {
    api.get.mockResolvedValue(ok({ dailyTrend: DAYS, peakFraudHours: [{ hour: 9, count: 5 }, { hour: 14, count: 3 }] }));
    renderTrends();
    expect(await screen.findByText('High-risk transactions')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();            // 2 + 4
    expect(screen.getByText('₹4,000.00')).toBeInTheDocument();     // 1000 + 3000
    expect(screen.getByText('2.5/day')).toBeInTheDocument();
    expect(screen.getByText('09:00')).toBeInTheDocument();
    expect(screen.getByText('5 flagged')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/admin-api/analytics/trends');
  });

  it('no data → "Not enough data yet" and an empty chart message', async () => {
    api.get.mockResolvedValue(ok({ dailyTrend: [], peakFraudHours: [] }));
    renderTrends();
    expect(await screen.findByText('Not enough data yet.')).toBeInTheDocument();
    expect(screen.getByText('No high-risk transactions in this period.')).toBeInTheDocument();
  });

  it('a failed load shows the error and Retry instead of an all-zero chart', async () => {
    api.get.mockRejectedValueOnce(fail(500, 'Trends unavailable')).mockResolvedValueOnce(ok({ dailyTrend: DAYS, peakFraudHours: [] }));
    renderTrends();
    expect(await screen.findByRole('alert')).toHaveTextContent('Trends unavailable');
    click('Retry');
    expect(await screen.findByText('2.5/day')).toBeInTheDocument();
  });

  it('shows a spinner while the first load runs', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    renderTrends();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});

describe('TrendChart', () => {
  const DAYS = [
    { date: '2026-10-03', count: 2, totalAmount: 1000, avgFraudScore: 60, movingAvg: 1 },
    { date: '2026-10-04', count: 0, totalAmount: 0, avgFraudScore: 0, movingAvg: 0.7 },
  ];

  it('renders a titled section with a table alternative', () => {
    render(<TrendChart data={DAYS} />);
    expect(screen.getByRole('region', { name: 'Daily high-risk transactions' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'High-risk transactions per day' })).toBeInTheDocument();
    const table = screen.getByRole('table', { hidden: true });
    expect(within(table).getAllByRole('row', { hidden: true })).toHaveLength(3); // header + 2 days
    expect(within(table).getByText('2026-10-03')).toBeInTheDocument();
  });

  it.each([[undefined], [null], [[]], [[{ date: '2026-10-03', count: 0 }]]])('%j → the empty message, no chart', (data) => {
    render(<TrendChart data={data} />);
    expect(screen.getByText('No high-risk transactions in this period.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { hidden: true })).toBeNull();
  });
});

// ─── FraudPatterns ───────────────────────────────────────────────────────────

describe('FraudPatterns', () => {
  const tx = (n) => ({ id: `t${n}`, publicId: `TXN-${n}`, amount: 100 * n, riskLevel: 'HIGH', timestamp: '2026-10-05T05:00:00Z' });
  const DATA = {
    sharedIpClusters: [{ ipAddress: '10.1.1.1', count: 3, userCount: 2, transactions: [tx(1), tx(2), tx(3)] }],
    sharedDeviceClusters: [{ deviceId: 'web-abc', count: 12, userCount: 1, transactions: Array.from({ length: 10 }, (_, i) => tx(i + 1)) }],
    highRiskMerchantClusters: [],
  };
  const renderPatterns = () => renderApp(<FraudPatterns />, { auth: signedIn({ role: 'ANALYST' }) });

  it('shows the three groups; a one-customer cluster is not called a shared pattern (AUD-39)', async () => {
    api.get.mockResolvedValue(ok(DATA));
    renderPatterns();
    expect(await screen.findByText('10.1.1.1')).toBeInTheDocument();
    expect(screen.getByText('2 different customers')).toBeInTheDocument();
    expect(screen.getByText(/1 customer \(repeated attempts, not a shared pattern\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'web-abc' })).toHaveAttribute('href', '/analyst/device-reputation?deviceId=web-abc');
    expect(screen.getByRole('region', { name: 'High-risk merchants' })).toHaveTextContent('No clusters found');
    expect(api.get).toHaveBeenCalledWith('/analyst-api/fraud-patterns', { signal: expect.any(AbortSignal) });
  });

  it('expands a cluster; when only part of it is listed it says "Showing 10 of 12" (N-21)', async () => {
    api.get.mockResolvedValue(ok(DATA));
    renderPatterns();
    await screen.findByText('10.1.1.1');
    const ip = screen.getByRole('region', { name: 'Shared IP addresses' });
    fireEvent.click(within(ip).getByRole('button', { name: /show transactions/i }));
    expect(within(ip).getByText('TXN-3')).toBeInTheDocument();
    expect(within(ip).queryByText(/Showing/)).toBeNull();

    const dev = screen.getByRole('region', { name: 'Shared devices' });
    fireEvent.click(within(dev).getByRole('button', { name: /show transactions/i }));
    expect(within(dev).getByText('Showing 10 of 12 transactions')).toBeInTheDocument();
    fireEvent.click(within(dev).getByRole('button', { name: /hide transactions/i }));
    expect(within(dev).queryByText('Showing 10 of 12 transactions')).toBeNull();
  });

  it('Refresh reloads; a failure shows the error with Retry', async () => {
    api.get.mockResolvedValueOnce(ok(DATA)).mockRejectedValueOnce(fail(500, 'Patterns unavailable'));
    renderPatterns();
    await screen.findByText('10.1.1.1');
    click('Refresh');
    expect(await screen.findByRole('alert')).toHaveTextContent('Patterns unavailable');
    expect(screen.queryByText('10.1.1.1')).toBeNull();
  });
});
