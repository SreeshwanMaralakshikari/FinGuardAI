// Phase 10: ML explanation (SHAP), engine-aware score explanation, admin scoring-engine card
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within, render } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import MlExplanation from '../components/common/MlExplanation.jsx';
import FraudExplanation from '../components/common/FraudExplanation.jsx';
import MlStatusCard from '../components/common/MlStatusCard.jsx';
import SubmitTransaction from '../pages/customer/SubmitTransaction.jsx';
import CaseDetail from '../pages/analyst/CaseDetail.jsx';
import AdminDashboard from '../pages/admin/AdminDashboard.jsx';
import { fallbackText, FALLBACK_DEFAULT, FALLBACK_TEXT } from '../utils/mlExplanation.js';
import { renderApp, ok, fail, signedIn } from '../tests/utils.jsx';

vi.mock('../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../api/axios.js';

const BREAKDOWN = [
  { rule: 'velocity', label: 'Velocity', points: 0, max: 20 },
  { rule: 'amount', label: 'Amount anomaly', points: 35, max: 35 },
  { rule: 'location', label: 'Location', points: 15, max: 15 },
  { rule: 'device', label: 'New device', points: 20, max: 50 },
  { rule: 'time', label: 'Unusual hour', points: 10, max: 10 },
  { rule: 'merchant', label: 'Merchant risk', points: 0, max: 35 },
];

const SHAP = [
  { feature: 'isNewDevice', label: 'New device for this customer', value: 'Yes', shap: 3.54 },
  { feature: 'amountToAvgRatio', label: 'Amount vs usual average', value: '10.0×', shap: 3.12 },
  { feature: 'isNewCity', label: 'New city for this customer', value: 'Yes', shap: 1.22 },
  { feature: 'hourOfDay', label: 'Hour of day (IST)', value: '03:00', shap: 0.6 },
  { feature: 'amount', label: 'Payment amount', value: '₹9,000', shap: 0.41 },
  { feature: 'deviceReputationScore', label: 'Device trust score', value: '100/100', shap: -0.85 },
  { feature: 'txnsLastHour', label: 'Payments in the last hour', value: '0', shap: -0.2 },
  { feature: 'paymentMethod', label: 'Payment method', value: 'UPI', shap: 0.003 },
];
const ML_SCORING = { engine: 'ML', modelVersion: 'fg-xgb-1.0.0', fraudProbability: 0.96, ruleScore: 80, shapValues: SHAP };

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('MlExplanation', () => {
  it('shows the six strongest factors as text, strongest first, with direction in words', () => {
    render(<MlExplanation scoring={ML_SCORING} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(6);
    expect(items[0]).toHaveTextContent('New device for this customer: Yes');
    expect(items[0]).toHaveTextContent('+3.54 · raises risk');
    expect(items[3]).toHaveTextContent('Device trust score: 100/100');   // |−0.85| ranks 4th
    expect(items[3]).toHaveTextContent('−0.85 · lowers risk');
    expect(screen.getByText(/Scored by the ML model \(fg-xgb-1\.0\.0\)/)).toHaveTextContent('rule engine would give 80/100');
  });

  it('"Show all" lists every factor, including tiny ones, and can collapse again', () => {
    render(<MlExplanation scoring={ML_SCORING} />);
    const toggle = screen.getByRole('button', { name: 'Show all 8 factors' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getAllByRole('listitem')[7]).toHaveTextContent('Payment method: UPI');
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer factors' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
  });

  it('bars are decorative (aria-hidden) and scaled to the strongest factor', () => {
    const { container } = render(<MlExplanation scoring={ML_SCORING} />);
    const bars = container.querySelectorAll('li > span[aria-hidden="true"] > span:last-child');
    expect(bars[0].style.width).toBe('50%');                       // strongest = half the row (one side)
    expect(bars[0].className).toContain('bg-red-700');
    expect(bars[3].className).toContain('bg-sky-700');              // negative → left, blue
    expect(parseFloat(bars[3].style.width)).toBeCloseTo((0.85 / 3.54) * 50, 5);
  });

  it('a push too small to matter reads "0.00 · no effect", never "−0.00 · lowers risk"', () => {
    render(<MlExplanation scoring={ML_SCORING} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 8 factors' }));
    expect(screen.getAllByRole('listitem')[7]).toHaveTextContent('0.00 · no effect');
  });

  it('copes with no or broken values', () => {
    const { rerender } = render(<MlExplanation scoring={{ engine: 'ML', shapValues: [] }} />);
    expect(screen.getByText('No single detail moved the score noticeably.')).toBeInTheDocument();
    rerender(<MlExplanation scoring={{ engine: 'ML', shapValues: [null, { feature: 'x', label: 'X', value: '1', shap: 'n/a' }] }} />);
    expect(screen.getByText('No single detail moved the score noticeably.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('FraudExplanation', () => {
  it('ML: SHAP first, then the rule breakdown as a comparison without the "capped" note', () => {
    render(<FraudExplanation scoring={ML_SCORING} breakdown={BREAKDOWN} fraudScore={96} />);
    expect(screen.getByTestId('ml-explanation')).toBeInTheDocument();
    const rules = screen.getByTestId('score-breakdown');
    expect(rules).toHaveAccessibleName('Rule engine check (for comparison)');
    expect(within(rules).queryByText(/capped/)).toBeNull();
    expect(screen.queryByTestId('ml-fallback-note')).toBeNull();
  });

  it('RULES with a fallback reason: the note, then the normal breakdown', () => {
    render(<FraudExplanation scoring={{ engine: 'RULES', ruleScore: 80, fallbackReason: 'TIMEOUT' }} breakdown={BREAKDOWN} fraudScore={80} />);
    expect(screen.getByTestId('ml-fallback-note')).toHaveTextContent(FALLBACK_TEXT.TIMEOUT);
    expect(screen.getByTestId('score-breakdown')).toHaveAccessibleName('Score breakdown');
    expect(screen.queryByTestId('ml-explanation')).toBeNull();
  });

  it('RULES with ML off, and legacy transactions: just the breakdown', () => {
    const { rerender } = render(<FraudExplanation scoring={{ engine: 'RULES', ruleScore: 80 }} breakdown={BREAKDOWN} fraudScore={80} />);
    expect(screen.queryByTestId('ml-fallback-note')).toBeNull();
    expect(screen.getByTestId('score-breakdown')).toBeInTheDocument();
    rerender(<FraudExplanation breakdown={BREAKDOWN} fraudScore={80} />);
    expect(screen.queryByTestId('ml-fallback-note')).toBeNull();
    expect(screen.queryByTestId('ml-explanation')).toBeNull();
  });

  it('fallbackText maps known reasons and defaults the rest', () => {
    expect(fallbackText({ engine: 'RULES', fallbackReason: 'COOLDOWN' })).toBe(FALLBACK_TEXT.COOLDOWN);
    expect(fallbackText({ engine: 'RULES', fallbackReason: 'AUTH' })).toBe(FALLBACK_DEFAULT);
    expect(fallbackText({ engine: 'ML', fallbackReason: 'AUTH' })).toBe('');
    expect(fallbackText(null)).toBe('');
  });
});

describe('pages show the ML explanation', () => {
  it('SubmitTransaction: the result of an ML-scored payment', async () => {
    api.post.mockResolvedValueOnce(ok({
      id: 't1', publicId: 'TXN-2026-00009', amount: 9000, merchantName: 'Gadget Hub', merchantCategory: 'ELECTRONICS', paymentMethod: 'UPI',
      fraudScore: 96, riskLevel: 'CRITICAL', reasons: ['Payment from a device the customer has not used before'], recommendedAction: 'BLOCK',
      estimatedLoss: 9000, status: 'BLOCKED', fraudAlert: { id: 'a1' }, timestamp: '2026-10-06T05:00:00Z', scoreBreakdown: BREAKDOWN, scoring: ML_SCORING,
    }));
    renderApp(<SubmitTransaction />, { auth: signedIn() });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '9000' } });
    fireEvent.change(screen.getByLabelText(/merchant name/i), { target: { value: 'Gadget Hub' } });
    fireEvent.change(screen.getByLabelText(/city/i), { target: { value: 'Delhi' } });
    fireEvent.click(screen.getByRole('button', { name: /submit for fraud check/i }));
    expect(await screen.findByTestId('ml-explanation')).toBeInTheDocument();
    expect(screen.getByTestId('score-breakdown')).toHaveAccessibleName('Rule engine check (for comparison)');
  });

  it('CaseDetail: an ML explanation even without a rule breakdown', async () => {
    const caseDoc = {
      _id: 'c1', publicId: 'CASE-2026-00001', status: 'UNDER_REVIEW', assignedAnalystId: { _id: 'me', name: 'Ravi Analyst' }, openedAt: '2026-10-05T05:00:00Z',
      notes: [], resolutionSummary: '', resolvedAt: null,
      fraudAlertId: { _id: 'fa1', alertType: 'COMPOSITE', reasons: ['Payment from a device the customer has not used before'] },
      transactionId: { _id: 't1', publicId: 'TXN-1', amount: 9000, merchantName: 'Gadget Hub', riskLevel: 'CRITICAL', status: 'BLOCKED', fraudScore: 96, deviceId: 'web-1', timestamp: '2026-10-05T05:00:00Z', scoreBreakdown: [], scoring: ML_SCORING },
    };
    api.get.mockImplementation(async () => ok(structuredClone(caseDoc)));
    renderApp(<Routes><Route path="/analyst/cases/:id" element={<CaseDetail />} /></Routes>,
      { route: '/analyst/cases/c1', auth: signedIn({ _id: 'me', role: 'ANALYST', name: 'Ravi Analyst' }) });
    expect(await screen.findByTestId('ml-explanation')).toBeInTheDocument();
    expect(screen.queryByTestId('score-breakdown')).toBeNull();
  });
});

describe('MlStatusCard', () => {
  const status = (over = {}) => ({
    enabled: true, serviceHost: 'finguardai-ml.onrender.com', timeoutMs: 2500, cooldownMs: 60000, coolingDown: false, cooldownEndsAt: null,
    lastSuccessAt: '2026-10-13T10:00:00Z', lastFailureAt: null, lastFailureCode: null, modelVersion: 'fg-xgb-1.0.0',
    last24h: { ML: 12, RULES: 3, LEGACY: 40 }, ...over,
  });

  it('ML on: model, fallback rule and 24-hour counts', async () => {
    api.get.mockResolvedValueOnce(ok(status()));
    renderApp(<MlStatusCard />, { auth: signedIn({ role: 'ADMIN' }) });
    const card = await screen.findByTestId('ml-status');
    expect(api.get).toHaveBeenCalledWith('/admin-api/ml-status', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(within(card).getByText('ML model fg-xgb-1.0.0')).toBeInTheDocument();
    expect(card).toHaveTextContent('finguardai-ml.onrender.com does not answer within 2500 ms');
    expect(within(card).getByText('ML (24 h)').nextSibling).toHaveTextContent('12');
    expect(within(card).getByText('Rules (24 h)').nextSibling).toHaveTextContent('3');
  });

  it('cooling down and switched off', async () => {
    api.get.mockResolvedValueOnce(ok(status({ coolingDown: true, lastFailureCode: 'TIMEOUT' })));
    const { unmount } = renderApp(<MlStatusCard />, { auth: signedIn({ role: 'ADMIN' }) });
    expect(await screen.findByText('Rule engine (ML waking up)')).toBeInTheDocument();
    expect(screen.getByText(/did not answer \(TIMEOUT\)/)).toBeInTheDocument();
    unmount();

    api.get.mockResolvedValueOnce(ok(status({ enabled: false, serviceHost: null, modelVersion: null, lastSuccessAt: null })));
    renderApp(<MlStatusCard />, { auth: signedIn({ role: 'ADMIN' }) });
    expect(await screen.findByText('Rule engine')).toBeInTheDocument();
    expect(screen.getByText(/ML_ENABLED is not true/)).toBeInTheDocument();
  });

  it('renders nothing on an error or an unexpected answer', async () => {
    api.get.mockRejectedValueOnce(fail(500, 'boom'));
    const { container, unmount } = renderApp(<MlStatusCard />, { auth: signedIn({ role: 'ADMIN' }) });
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    expect(container.querySelector('[data-testid="ml-status"]')).toBeNull();
    unmount();

    api.get.mockResolvedValueOnce(ok({ totalTransactions: 5 })); // e.g. a different endpoint's shape
    const second = renderApp(<MlStatusCard />, { auth: signedIn({ role: 'ADMIN' }) });
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(second.container.querySelector('[data-testid="ml-status"]')).toBeNull();
  });

  it('appears on the admin dashboard', async () => {
    const ANALYTICS = {
      totalTransactions: 10, fraudRate: 10, openCases: 0, openAlerts: 0, lossPrevented: 0, riskDistribution: [], fraudByHour: [],
      topMerchants: [], topCities: [], topDevices: [], scoreHistogram: [], recentAlerts: [],
    };
    api.get.mockImplementation(async (url) => (url === '/admin-api/ml-status' ? ok(status()) : ok(ANALYTICS)));
    renderApp(<AdminDashboard />, { auth: signedIn({ role: 'ADMIN' }) });
    expect(await screen.findByTestId('ml-status')).toHaveTextContent('ML model fg-xgb-1.0.0');
  });
});
