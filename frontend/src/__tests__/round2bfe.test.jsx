// Fix round 2b (frontend): A-01 analytics, A-02 timeline, A-04 forecast, B-07 preview, F-02 acknowledge, A-08 demo data
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AdminDashboard from '../pages/admin/AdminDashboard.jsx';
import AdminTrends from '../pages/admin/AdminTrends.jsx';
import ThresholdConfig from '../pages/admin/ThresholdConfig.jsx';
import SimulationPanel from '../pages/admin/SimulationPanel.jsx';
import UserManagement from '../pages/admin/UserManagement.jsx';
import FraudAlerts from '../pages/customer/FraudAlerts.jsx';
import FraudTimeline from '../components/common/FraudTimeline.jsx';
import TrendChart from '../components/charts/TrendChart.jsx';
import BarCard from '../components/charts/BarCard.jsx';
import { acknowledgeAlertThunk } from '../store/slices/fraudAlertSlice.js';
import { renderApp, ok, page, fail, signedIn } from '../tests/utils.jsx';

vi.mock('../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
import api from '../api/axios.js';

beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); });

const ANALYTICS = {
  totalTransactions: 40, fraudRate: 10, openCases: 1, openAlerts: 2, lossPrevented: 500,
  riskDistribution: [{ _id: 'HIGH', count: 4 }],
  fraudByHour: [{ hour: 9, count: 4 }],
  fraudByPaymentMethod: [{ paymentMethod: 'CREDIT_CARD', count: 3 }, { paymentMethod: 'UPI', count: 1 }],
  fraudByLocation: [{ city: 'Mumbai', count: 4 }],
  fraudByDevice: [{ deviceId: 'device-abcdef-1234567890', count: 3, userCount: 2 }, { deviceId: 'dev-1', count: 1, userCount: 1 }],
  scoreHistogram: Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i === 9 ? 100 : i * 10 + 9, label: `${i * 10}-${i === 9 ? 100 : i * 10 + 9}`, count: i === 6 ? 4 : 0 })),
};

// ─── A-01 ─────────────────────────────────────────────────────────────────────
describe('A-01 admin dashboard', () => {
  it('shows payment methods, the real top-device chart (short id, full id + accounts in the table) and the score histogram', async () => {
    api.get.mockResolvedValue(ok(ANALYTICS));
    renderApp(<AdminDashboard />, { auth: signedIn({ role: 'ADMIN' }) });
    expect(await screen.findByRole('region', { name: 'Top devices by high-risk transactions' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'High-risk by payment method' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Fraud score distribution' })).toBeInTheDocument();
    const devices = screen.getByRole('region', { name: 'Top devices by high-risk transactions' });
    expect(within(devices).getByText('device-abcdef-1234567890 (2 accounts)')).toBeInTheDocument();
    expect(within(devices).getByText('dev-1 (1 account)')).toBeInTheDocument();
    const payment = screen.getByRole('region', { name: 'High-risk by payment method' });
    expect(within(payment).getByText('CREDIT CARD', { selector: 'td' })).toBeInTheDocument();
    expect(within(payment).queryByText(/device-abcdef/)).toBeNull(); // payment methods and devices are no longer mixed
    const hist = screen.getByRole('region', { name: 'Fraud score distribution' });
    expect(within(hist).getByText('60-69', { selector: 'td' })).toBeInTheDocument();
  });

  it('date range: Apply sends IST day bounds, Clear drops them, From after To is refused inline', async () => {
    api.get.mockResolvedValue(ok(ANALYTICS));
    renderApp(<AdminDashboard />, { auth: signedIn({ role: 'ADMIN' }) });
    await screen.findByText('Fraud score distribution');
    expect(api.get).toHaveBeenLastCalledWith('/admin-api/analytics');

    fireEvent.change(screen.getByLabelText('From (IST day)'), { target: { value: '2026-10-05' } });
    fireEvent.change(screen.getByLabelText('To (IST day)'), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('“From” must be on or before “To”.');
    expect(api.get).toHaveBeenCalledTimes(1); // nothing was fetched

    fireEvent.change(screen.getByLabelText('To (IST day)'), { target: { value: '2026-10-07' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/admin-api/analytics', {
      params: { startDate: '2026-10-05T00:00:00.000+05:30', endDate: '2026-10-07T23:59:59.999+05:30' },
    }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/2026-10-05 to 2026-10-07/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/admin-api/analytics'));
    expect(screen.getByLabelText('From (IST day)')).toHaveValue('');
  });

  it('one-sided range sends only that bound', async () => {
    api.get.mockResolvedValue(ok(ANALYTICS));
    renderApp(<AdminDashboard />, { auth: signedIn({ role: 'ADMIN' }) });
    await screen.findByText('Fraud score distribution');
    fireEvent.change(screen.getByLabelText('To (IST day)'), { target: { value: '2026-10-07' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/admin-api/analytics', { params: { endDate: '2026-10-07T23:59:59.999+05:30' } }));
  });

  it('BarCard: tooltip label source and table use the long form when fullKey is given', () => {
    render(<BarCard title="T" data={[{ k: 'a…z', full: 'the-full-label', count: 2 }]} xKey="k" fullKey="full" />);
    expect(screen.getByText('the-full-label')).toBeInTheDocument();
  });
});

// ─── A-02 ─────────────────────────────────────────────────────────────────────
const EVENTS = [
  { id: 'outcome-1', type: 'CASE_OUTCOME', timestamp: '2026-10-05T10:00:00.000Z', title: 'Fraud case closed', description: 'We confirmed fraud.', riskLevel: 'HIGH', status: 'RESOLVED', amount: 5000, transactionId: 'TXN-1' },
  { id: 'alert-1', type: 'ALERT', timestamp: '2026-10-05T09:00:00.000Z', title: 'HIGH risk alert', description: 'Unusual amount', riskLevel: 'HIGH', status: 'OPEN', amount: 5000, transactionId: 'TXN-1' },
  { id: 'txn-1', type: 'TRANSACTION', timestamp: '2026-10-05T08:30:00.000Z', title: 'Payment to Big Shop', description: '₹5,000.00 by UPI - held for review.', riskLevel: 'HIGH', status: 'HELD', amount: 5000, transactionId: 'TXN-1' },
];
const ALERT = {
  _id: 'a1', alertType: 'HIGH_AMOUNT', riskLevel: 'MEDIUM', status: 'OPEN', fraudScore: 30, createdAt: '2026-10-05T05:00:00Z',
  reasons: ['New device'], transactionId: { publicId: 'TXN-9', amount: 1200, merchantName: 'Corner Store', status: 'APPROVED' },
};

describe('A-02 FraudTimeline', () => {
  it('is an ordered list: time in IST, a text label per type, risk as text, links', () => {
    render(<MemoryRouter><FraudTimeline events={EVENTS} /></MemoryRouter>);
    const list = screen.getByRole('list', { name: /fraud timeline/i });
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText('Case outcome')).toBeInTheDocument();
    expect(within(items[1]).getByText('Fraud alert')).toBeInTheDocument();
    expect(within(items[2]).getByText('Payment')).toBeInTheDocument();
    expect(within(items[2]).getByText('HIGH')).toBeInTheDocument();
    expect(within(items[2]).getByText(/05 Oct 2026, 02:00 pm IST/)).toBeInTheDocument(); // 08:30Z = 14:00 IST
    expect(within(items[2]).getByRole('link', { name: 'View in transaction history' })).toHaveAttribute('href', '/customer/transactions');
    expect(within(items[1]).getByRole('link', { name: 'View in fraud alerts' })).toHaveAttribute('href', '/customer/fraud-alerts');
    expect(items[0]).toHaveTextContent('Status: resolved');
  });
  it('copes with unknown event types and missing optional fields', () => {
    render(<MemoryRouter><FraudTimeline events={[{ id: 'x', type: 'WEIRD', timestamp: '2026-10-05T08:30:00.000Z', title: 'Something' }]} /></MemoryRouter>);
    expect(screen.getByText('Activity')).toBeInTheDocument();
  });
});

describe('A-02 timeline tab on the Fraud alerts page', () => {
  const route = (url) => {
    if (url === '/customer-api/timeline') return Promise.resolve(ok(EVENTS));
    return Promise.resolve(page([ALERT]));
  };

  it('loads the feed with limit=50 only when the tab is opened; the alert list keeps working', async () => {
    api.get.mockImplementation(route);
    renderApp(<FraudAlerts />, { auth: signedIn() });
    expect(await screen.findByText('Corner Store')).toBeInTheDocument();
    expect(api.get.mock.calls.some((c) => c[0] === '/customer-api/timeline')).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(await screen.findByRole('list', { name: /fraud timeline/i })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/customer-api/timeline', expect.objectContaining({ params: { limit: 50 } }));
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Alerts' }));
    expect(await screen.findByText('Corner Store')).toBeInTheDocument();
  });

  it('empty feed and failed feed (with Retry)', async () => {
    api.get.mockImplementation((url) => (url === '/customer-api/timeline' ? Promise.resolve(ok([])) : Promise.resolve(page([ALERT]))));
    const { unmount } = renderApp(<FraudAlerts />, { auth: signedIn() });
    fireEvent.click(await screen.findByRole('tab', { name: 'Timeline' }));
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
    unmount();

    let calls = 0;
    api.get.mockImplementation((url) => {
      if (url !== '/customer-api/timeline') return Promise.resolve(page([ALERT]));
      calls += 1;
      return calls === 1 ? Promise.reject(fail(500, 'Timeline unavailable')) : Promise.resolve(ok(EVENTS));
    });
    renderApp(<FraudAlerts />, { auth: signedIn() });
    fireEvent.click(await screen.findByRole('tab', { name: 'Timeline' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Timeline unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: /fraud timeline/i })).toBeInTheDocument();
  });
});

// ─── F-02 ─────────────────────────────────────────────────────────────────────
describe('F-02 acknowledge MEDIUM alerts', () => {
  it('status filter offers ACKNOWLEDGED and sends it', async () => {
    api.get.mockResolvedValue(page([ALERT]));
    renderApp(<FraudAlerts />, { auth: signedIn() });
    await screen.findByText('Corner Store');
    expect(within(screen.getByLabelText('Status')).getByRole('option', { name: 'ACKNOWLEDGED' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'ACKNOWLEDGED' } });
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/customer-api/fraud-alerts', { params: { page: 1, limit: 10, status: 'ACKNOWLEDGED' } }));
  });

  it('only MEDIUM + OPEN alerts get a button', async () => {
    api.get.mockResolvedValue(page([
      ALERT,
      { ...ALERT, _id: 'a2', riskLevel: 'HIGH', transactionId: { ...ALERT.transactionId, merchantName: 'High Shop' } },
      { ...ALERT, _id: 'a3', status: 'ACKNOWLEDGED', transactionId: { ...ALERT.transactionId, merchantName: 'Done Shop' } },
    ]));
    renderApp(<FraudAlerts />, { auth: signedIn() });
    await screen.findByText('High Shop');
    expect(screen.getAllByRole('button', { name: /^Acknowledge alert for/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Acknowledge alert for Corner Store' })).toBeInTheDocument();
  });

  it('confirm dialog -> PATCH -> row becomes ACKNOWLEDGED, button gone, toast text via dialog closing', async () => {
    api.get.mockResolvedValue(page([ALERT]));
    api.patch.mockResolvedValue(ok({ ...ALERT, status: 'ACKNOWLEDGED' }));
    const { store } = renderApp(<FraudAlerts />, { auth: signedIn() });
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge alert for Corner Store' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Only confirm if you recognise this payment/)).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled(); // opening the dialog changes nothing
    fireEvent.click(within(dialog).getByRole('button', { name: 'I recognise this payment' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/customer-api/fraud-alerts/a1/acknowledge'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(store.getState().fraudAlerts.alerts[0].status).toBe('ACKNOWLEDGED');
    expect(screen.queryByRole('button', { name: /^Acknowledge alert for/ })).toBeNull();
    expect(screen.getAllByText('ACKNOWLEDGED').length).toBeGreaterThan(0);
  });

  it('a 400 keeps the dialog open with the server message; Cancel closes without a request', async () => {
    api.get.mockResolvedValue(page([ALERT]));
    api.patch.mockRejectedValue(fail(400, 'This alert is already acknowledged; only open alerts can be acknowledged.'));
    renderApp(<FraudAlerts />, { auth: signedIn() });
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge alert for Corner Store' }));
    fireEvent.click(screen.getByRole('button', { name: 'I recognise this payment' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('already acknowledged');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.patch).toHaveBeenCalledTimes(1);
  });

  it('thunk: also updates selectedAlert and ignores an answer without _id', async () => {
    api.get.mockResolvedValue(page([]));
    const { store } = renderApp(<div />, { auth: signedIn() });
    api.patch.mockResolvedValueOnce(ok({}));
    await store.dispatch(acknowledgeAlertThunk('zz'));
    expect(store.getState().fraudAlerts.alerts).toEqual([]);
  });
});

// ─── A-04 ─────────────────────────────────────────────────────────────────────
describe('A-04 forecast on the trends chart', () => {
  const DAYS = [
    { date: '2026-10-03', count: 2, totalAmount: 1000, avgFraudScore: 60, movingAvg: 1 },
    { date: '2026-10-04', count: 4, totalAmount: 3000, avgFraudScore: 70, movingAvg: 2.5 },
  ];
  const FORECAST = {
    available: true, method: 'linear-regression-14d',
    days: [{ date: '2026-10-05', count: 5, totalAmount: 3500, avgFraudScore: 71, movingAvg: 3 }, { date: '2026-10-06', count: 6, totalAmount: 4000, avgFraudScore: 72, movingAvg: 3.5 }],
  };

  it('adds the forecast series, its explanation and table rows; the stat cards still use the real days only', async () => {
    api.get.mockResolvedValue(ok({ dailyTrend: DAYS, peakFraudHours: [], forecast: FORECAST }));
    renderApp(<AdminTrends />, { auth: signedIn({ role: 'ADMIN' }) });
    expect(await screen.findByText('High-risk transactions')).toBeInTheDocument();
    expect(screen.getByText('₹4,000.00')).toBeInTheDocument(); // 1000 + 3000, forecast amounts excluded
    expect(screen.getByText(/Dashed purple line: Forecast \(next 7 days, linear trend\)/)).toBeInTheDocument();
    expect(screen.getByText('Forecast (next 7 days, linear trend)', { selector: 'th' })).toBeInTheDocument();
    expect(screen.getByText('2026-10-06')).toBeInTheDocument();
    expect(screen.queryByText(/No forecast yet/)).toBeNull();
  });

  it('shows a note when the forecast is not available', async () => {
    api.get.mockResolvedValue(ok({ dailyTrend: DAYS, peakFraudHours: [], forecast: { available: false, method: 'linear-regression-14d', days: [] } }));
    renderApp(<AdminTrends />, { auth: signedIn({ role: 'ADMIN' }) });
    expect(await screen.findByText(/No forecast yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Dashed purple line/)).toBeNull();
  });

  it('an old response without a forecast key renders exactly as before', () => {
    render(<TrendChart data={DAYS} />);
    expect(screen.queryByText(/forecast/i)).toBeNull();
    expect(screen.getByText('2026-10-04')).toBeInTheDocument();
  });
});

// ─── B-07 ─────────────────────────────────────────────────────────────────────
describe('B-07 threshold preview', () => {
  const CONFIG = {
    amountThreshold: 50000, velocityLimit: { maxPerHour: 5, maxPerDay: 20 }, scoreThresholds: { mediumMin: 25, highMin: 50, criticalMin: 75 },
    newDeviceWeight: 20, highRiskMerchants: ['CASINO'],
  };
  const PREVIEW = {
    windowDays: 30, total: 120,
    current: { LOW: 60, MEDIUM: 30, HIGH: 20, CRITICAL: 10 }, proposed: { LOW: 50, MEDIUM: 30, HIGH: 25, CRITICAL: 15 },
    moved: { up: 10, down: 0, unchanged: 110 }, note: 'Re-bands stored fraud scores; rule weights and velocity limits are not re-evaluated.',
  };
  const setup = async () => {
    api.get.mockResolvedValue(ok(CONFIG));
    renderApp(<ThresholdConfig />, { auth: signedIn({ role: 'ADMIN' }) });
    await screen.findByLabelText('MEDIUM from');
  };

  it('posts only the three bands, shows the comparison and the note, never saves', async () => {
    await setup();
    api.post.mockResolvedValue(ok(PREVIEW));
    fireEvent.change(screen.getByLabelText('HIGH from'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview impact' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin-api/thresholds/preview', { scoreThresholds: { mediumMin: 25, highMin: 40, criticalMin: 75 } }));
    const table = await screen.findByRole('table', { name: /current and the proposed/i });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(within(rows[3]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['20', '25', '+5']);
    expect(within(rows[1]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['60', '50', '-10']);
    expect(screen.getByText(/Last 30 days, 120 transactions/)).toHaveTextContent('Moved up: 10, moved down: 0, unchanged: 110');
    expect(screen.getByText(/not re-evaluated/)).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('is disabled while the band fields are invalid and the result disappears when a field changes', async () => {
    await setup();
    const btn = screen.getByRole('button', { name: 'Preview impact' });
    expect(btn).toBeEnabled();
    fireEvent.change(screen.getByLabelText('MEDIUM from'), { target: { value: '60' } }); // not below HIGH (50)
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('MEDIUM from'), { target: { value: '' } });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('MEDIUM from'), { target: { value: '10.5' } });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('MEDIUM from'), { target: { value: '20' } });
    expect(btn).toBeEnabled();

    api.post.mockResolvedValue(ok(PREVIEW));
    fireEvent.click(btn);
    await screen.findByRole('table', { name: /current and the proposed/i });
    fireEvent.change(screen.getByLabelText('MEDIUM from'), { target: { value: '21' } });
    expect(screen.queryByRole('table', { name: /current and the proposed/i })).toBeNull(); // stale result hidden
  });

  it('shows the server message when the preview fails', async () => {
    await setup();
    api.post.mockRejectedValue(fail(422, 'scoreThresholds ordering violated after merge'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview impact' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ordering violated');
  });
});

// ─── A-08 ─────────────────────────────────────────────────────────────────────
describe('A-08 demo data', () => {
  const GENERATED = { generated: 30, byRiskLevel: { LOW: 20, MEDIUM: 5, HIGH: 3, CRITICAL: 2 }, byStatus: { APPROVED: 25, HELD: 3, BLOCKED: 2 }, simulatedTransactionsTotal: 60 };
  const renderPanel = () => renderApp(<SimulationPanel />, { auth: signedIn({ role: 'ADMIN' }), preloadedState: { simulation: { isRunning: false, events: [], stats: {} } } });

  it('generates with the default of 30, shows the summary, refreshes analytics', async () => {
    let release;
    api.post.mockReturnValue(new Promise((resolve) => { release = () => resolve(ok(GENERATED)); }));
    api.get.mockResolvedValue(ok(ANALYTICS));
    const { store } = renderPanel();
    expect(screen.getByLabelText('Transactions to generate')).toHaveValue(30);
    fireEvent.click(screen.getByRole('button', { name: 'Generate demo transactions' }));
    expect(await screen.findByRole('button', { name: 'Generating…' })).toBeDisabled();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin-api/simulation/generate', { count: 30 }, { timeout: 120000 }));
    expect(screen.getByRole('button', { name: 'Clear demo data' })).toBeDisabled();
    release();
    expect(await screen.findByText(/Generated 30 simulated transactions \(60 simulated in total\)/)).toBeInTheDocument();
    expect(screen.getByText(/By risk: LOW 20, MEDIUM 5, HIGH 3, CRITICAL 2/)).toBeInTheDocument();
    expect(screen.getByText(/By status: APPROVED 25, HELD 3, BLOCKED 2/)).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin-api/analytics'));
    await waitFor(() => expect(store.getState().analytics.totalTransactions).toBe(40));
  });

  it('refuses a count outside 1-50 (cap per click) without calling the API', () => {
    renderPanel();
    expect(screen.getByLabelText('Transactions to generate')).toHaveAttribute('max', '50');
    for (const bad of ['51', '0', '2.5', '']) {
      fireEvent.change(screen.getByLabelText('Transactions to generate'), { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: 'Generate demo transactions' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 1 to 50 (at most 50 per click)');
    }
    expect(api.post).not.toHaveBeenCalled();
  });

  it('says it can take up to a minute while generating', async () => {
    api.post.mockReturnValue(new Promise(() => {}));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Generate demo transactions' }));
    expect(await screen.findByText(/This can take up to a minute/)).toBeInTheDocument();
  });

  it('R-02: a request that never gets an answer (timeout) explains itself and refreshes the totals', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('timeout of 120000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' }));
    api.get.mockResolvedValue(ok(ANALYTICS));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Generate demo transactions' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The server may still be generating - refresh the totals before retrying');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin-api/analytics'));
  });

  it('R-02: the same for Clear', async () => {
    api.delete.mockRejectedValue(Object.assign(new Error('Network Error'), { isAxiosError: true }));
    api.get.mockResolvedValue(ok(ANALYTICS));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Clear demo data' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete demo data' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The server may still be clearing');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin-api/analytics'));
  });

  it.each([
    [400, 'Simulation limit reached: 480 simulated transactions already exist.', /Simulation limit reached/],
    [429, 'Simulation rate limit exceeded (10 per hour). Please try again later.', /Rate limit reached - Simulation rate limit exceeded/],
    [409, 'The address sim.customer1@example.test belongs to a real account.', /Conflict - The address sim\.customer1/],
  ])('shows the %i answer', async (status, message, pattern) => {
    api.post.mockRejectedValue(fail(status, message));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Generate demo transactions' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(pattern);
    expect(screen.getByRole('button', { name: 'Generate demo transactions' })).toBeEnabled();
  });

  it('Clear needs a confirmation; Cancel sends nothing; confirm DELETEs and summarises', async () => {
    api.delete.mockResolvedValue(ok({ users: 3, transactions: 30, fraudAlerts: 5, cases: 2, notifications: 9, deviceReputations: 3, behaviorProfiles: 3 }));
    api.get.mockResolvedValue(ok(ANALYTICS));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Clear demo data' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(api.delete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Clear demo data' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete demo data' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin-api/simulation/data', { timeout: 120000 }));
    expect(await screen.findByText(/Removed: 3 users, 30 transactions, 5 alerts, 2 cases, 9 notifications, 3 device records, 3 behaviour profiles/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin-api/analytics'));
  });

  it('a failed clear closes the dialog and shows the error', async () => {
    api.delete.mockRejectedValue(fail(500, 'Could not clear'));
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Clear demo data' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete demo data' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not clear');
  });

  it('copy is honest: start/stop does not create transactions, demo data does', () => {
    renderPanel();
    expect(screen.getByText(/does not create transactions/)).toBeInTheDocument();
    expect(screen.getByText(/real records in this database/)).toBeInTheDocument();
  });

  it('keeps the start / stop broadcast working', async () => {
    api.post.mockResolvedValue(ok(null));
    const { store } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(store.getState().simulation.isRunning).toBe(true));
    expect(api.post).toHaveBeenCalledWith('/admin-api/simulation/start', {});
  });
});

describe('A-08 Simulated tag in the user list', () => {
  it('tags isSimulated users only', async () => {
    const base = { role: 'CUSTOMER', trustScore: 50, isActive: true, createdAt: '2026-10-01T00:00:00Z', lastLogin: null };
    api.get.mockResolvedValue(page([
      { ...base, _id: 'u1', name: 'Real Person', email: 'r@x.com' },
      { ...base, _id: 'u2', name: 'Sim Customer', email: 's@x.test', isSimulated: true },
    ], 2, 1, 50));
    renderApp(<UserManagement />, { auth: signedIn({ role: 'ADMIN' }) });
    await screen.findByText('Sim Customer');
    expect(screen.getAllByText('Simulated')).toHaveLength(1);
    expect(within(screen.getByText('Sim Customer').closest('td')).getByText('Simulated')).toBeInTheDocument();
  });
});

// ─── Round 3 ──────────────────────────────────────────────────────────────────
import { TABLE } from '../utils/common.js';
import ScoreBreakdown from '../components/common/ScoreBreakdown.jsx';
import AuditLogs from '../pages/admin/AuditLogs.jsx';

const HEX = { 'sky-700': '#0369a1', 'amber-700': '#b45309', 'emerald-700': '#047857', 'fuchsia-700': '#a21caf', 'orange-700': '#c2410c', 'slate-700': '#334155' };
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe('R-07 score breakdown contrast', () => {
  it('every segment is white text on a shade with >= 4.5:1 contrast', () => {
    const rows = ['velocity', 'amount', 'location', 'device', 'time', 'merchant'].map((rule) => ({ rule, label: rule, points: 5, max: 10 }));
    const { container } = render(<ScoreBreakdown breakdown={rows} />);
    const used = new Set();
    for (const el of container.querySelectorAll('[class*="bg-"][class*="text-white"]')) {
      const shade = /bg-([a-z]+-\d+)/.exec(el.className)[1];
      used.add(shade);
      expect(HEX[shade], `unknown shade ${shade}`).toBeDefined();
      expect(1.05 / (luminance(HEX[shade]) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
    expect(used.size).toBe(6);
  });
});

describe('E2E layout: table wrapper', () => {
  it('is a positioned scroll box so the sr-only Actions header cannot widen the page', () => {
    expect(TABLE.wrapper.split(' ')).toEqual(expect.arrayContaining(['relative', 'overflow-x-auto']));
  });
});

describe('R-06 audit log entity types', () => {
  it('offers every entity type the backend writes, including Device', async () => {
    api.get.mockResolvedValue(page([], 0, 1, 50));
    renderApp(<AuditLogs />, { auth: signedIn({ role: 'ADMIN' }) });
    const select = await screen.findByLabelText('Entity type');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['All', 'User', 'Transaction', 'FraudAlert', 'FraudCase', 'SystemConfig', 'Device']);
  });
});
