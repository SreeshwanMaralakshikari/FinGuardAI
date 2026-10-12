// Fix round 2a (frontend): B-01 score breakdown, B-04 alert status, B-02 wording, C-01 replay, F-11 CSV / SLA / queue
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within, render } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { configureStore } from '@reduxjs/toolkit';
import ScoreBreakdown from '../components/common/ScoreBreakdown.jsx';
import { AlertStatusBadge, TxStatusBadge, CaseStatusBadge } from '../components/common/Badges.jsx';
import SubmitTransaction from '../pages/customer/SubmitTransaction.jsx';
import TransactionHistory from '../pages/customer/TransactionHistory.jsx';
import FlaggedTransactions from '../pages/analyst/FlaggedTransactions.jsx';
import CaseManagement from '../pages/analyst/CaseManagement.jsx';
import CaseDetail from '../pages/analyst/CaseDetail.jsx';
import AdminDashboard from '../pages/admin/AdminDashboard.jsx';
import fraudAlertReducer, { fetchFlaggedTransactionByIdThunk } from '../store/slices/fraudAlertSlice.js';
import { createCaseThunk } from '../store/slices/fraudCaseSlice.js';
import { rootReducer } from '../store/index.js';
import { renderApp, ok, page, signedIn } from '../tests/utils.jsx';

vi.mock('../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../api/axios.js';

const BREAKDOWN = [
  { rule: 'velocity', label: 'Velocity', points: 0, max: 20 },
  { rule: 'amount', label: 'Amount anomaly', points: 30, max: 35 },
  { rule: 'location', label: 'Location', points: 0, max: 15 },
  { rule: 'device', label: 'New device', points: 20, max: 50 },
  { rule: 'time', label: 'Unusual hour', points: 5, max: 10 },
  { rule: 'merchant', label: 'Merchant risk', points: 0, max: 35 },
];

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('B-01 ScoreBreakdown', () => {
  it('renders a text summary, one table row per rule, and the total', () => {
    render(<ScoreBreakdown breakdown={BREAKDOWN} fraudScore={55} />);
    const img = screen.getByRole('img');
    expect(img).toHaveAccessibleName(/55 points in total.*Amount anomaly 30 of 35/);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 6 + 1); // header + rules + total
    expect(within(table).getByText('30 / 35')).toBeInTheDocument();
    expect(within(table).getByText('New device')).toBeInTheDocument();
  });
  it('hides cleanly for legacy rows (empty / missing)', () => {
    const { container, rerender } = render(<ScoreBreakdown breakdown={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ScoreBreakdown />);
    expect(container).toBeEmptyDOMElement();
  });
  it('explains the cap when the rule points exceed the 0-100 score', () => {
    render(<ScoreBreakdown breakdown={[{ rule: 'a', label: 'A', points: 70, max: 70 }, { rule: 'b', label: 'B', points: 50, max: 50 }]} fraudScore={100} />);
    expect(screen.getByText(/add up to 120; the fraud score is capped at 100/)).toBeInTheDocument();
  });
  it('says so when no rule added points', () => {
    render(<ScoreBreakdown breakdown={BREAKDOWN.map((r) => ({ ...r, points: 0 }))} />);
    expect(screen.getByText('No rule added any points.')).toBeInTheDocument();
  });
});

describe('B-04 alert status', () => {
  it('opening a case does NOT mark the alert REVIEWED (it stays OPEN)', async () => {
    api.get.mockResolvedValueOnce(ok({ transaction: { _id: 't1' }, deviceReputation: null, fraudAlert: { _id: 'fa1', status: 'OPEN' }, existingCase: null }));
    api.post.mockResolvedValueOnce(ok({ _id: 'c1', publicId: 'CASE-1', status: 'OPEN', fraudAlertId: 'fa1', assignedAnalystId: null, openedAt: '2026-10-12T00:00:00Z' }));
    const store = configureStore({ reducer: { fraudAlerts: fraudAlertReducer, fraudCases: rootReducer.fraudCases ?? ((s = {}) => s) } });
    await store.dispatch(fetchFlaggedTransactionByIdThunk('t1'));
    await store.dispatch(createCaseThunk({ fraudAlertId: 'fa1' }));
    const sel = store.getState().fraudAlerts.selectedFlagged;
    expect(sel.fraudAlert.status).toBe('OPEN');
    expect(sel.existingCase).toMatchObject({ _id: 'c1', publicId: 'CASE-1', status: 'OPEN' });
  });
  it.each([['OPEN'], ['REVIEWED'], ['DISMISSED'], ['ACKNOWLEDGED']])('badge handles %s with colours', (status) => {
    render(<AlertStatusBadge status={status} />);
    const badge = screen.getByText(status);
    expect(badge.className).toMatch(/bg-/);
  });
  it('ACKNOWLEDGED is neutral (not the REVIEWED colour)', () => {
    const { unmount } = render(<AlertStatusBadge status="ACKNOWLEDGED" />);
    const a = screen.getByText('ACKNOWLEDGED').className;
    unmount();
    render(<AlertStatusBadge status="REVIEWED" />);
    expect(screen.getByText('REVIEWED').className).not.toBe(a);
  });
});

describe('B-02 wording / BLOCKED display', () => {
  it('BLOCKED transaction badge is red; closed case badges describe the payment outcome', () => {
    render(<><TxStatusBadge status="BLOCKED" /><CaseStatusBadge status="RESOLVED" /><CaseStatusBadge status="DISMISSED" /></>);
    expect(screen.getByText('BLOCKED').className).toMatch(/red/);
    expect(screen.getByText('RESOLVED')).toHaveAttribute('title', 'Fraud confirmed - payment blocked');
    expect(screen.getByText('DISMISSED')).toHaveAttribute('title', 'False positive - payment released');
  });
});

const ME = { id: 'me', name: 'Ravi Analyst', email: 'ravi@example.com', role: 'ANALYST' };
const caseDoc = (over = {}) => ({
  _id: 'c1', publicId: 'CASE-2026-00001', status: 'UNDER_REVIEW', assignedAnalystId: { _id: 'me', name: 'Ravi Analyst' }, openedAt: '2026-10-05T05:00:00Z',
  notes: [], resolutionSummary: '', resolvedAt: null,
  fraudAlertId: { _id: 'fa1', alertType: 'HIGH_AMOUNT', reasons: ['Amount is unusually high'] },
  transactionId: { _id: 't1', publicId: 'TXN-1', amount: 90000, merchantName: 'Big Shop', riskLevel: 'HIGH', status: 'HELD', fraudScore: 55, deviceId: 'web-1', timestamp: '2026-10-05T05:00:00Z', scoreBreakdown: BREAKDOWN },
  ...over,
});
const renderCase = (over) => {
  api.get.mockImplementation(async () => ok(structuredClone(caseDoc(over))));
  return renderApp(<Routes><Route path="/analyst/cases/:id" element={<CaseDetail />} /></Routes>, { route: '/analyst/cases/c1', auth: signedIn(ME) });
};

describe('CaseDetail: breakdown + B-02 consequences', () => {
  it('shows the breakdown, explains each action before choosing, and warns in the dialog', async () => {
    renderCase();
    expect(await screen.findByTestId('score-breakdown')).toBeInTheDocument();
    expect(screen.getByText(/Resolve = fraud confirmed: a held payment is BLOCKED/)).toBeInTheDocument();
    expect(screen.getByText(/Dismiss = false positive: a held or blocked payment is RELEASED/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve case' });
    expect(within(dialog).getByText(/Fraud confirmed - payment blocked/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    const d2 = await screen.findByRole('dialog', { name: 'Dismiss case' });
    expect(within(d2).getByText(/False positive - payment released/)).toBeInTheDocument();
  });
  it('a legacy transaction (no breakdown) shows no breakdown section', async () => {
    renderCase({ transactionId: { ...caseDoc().transactionId, scoreBreakdown: [] } });
    await screen.findByRole('heading', { name: 'Case CASE-2026-00001' });
    expect(screen.queryByTestId('score-breakdown')).toBeNull();
  });
  it('closed RESOLVED case states the outcome', async () => {
    renderCase({ status: 'RESOLVED', resolvedAt: '2026-10-05T06:00:00Z', resolutionSummary: 'done' });
    expect(await screen.findAllByText('Fraud confirmed - payment blocked')).not.toHaveLength(0);
  });
});

const RESULT = {
  id: 't1', publicId: 'TXN-2026-00001', amount: 1200, merchantName: 'Cafe', merchantCategory: 'FOOD', paymentMethod: 'UPI',
  fraudScore: 55, riskLevel: 'HIGH', reasons: ['x'], recommendedAction: 'HOLD', estimatedLoss: 0, status: 'HELD', fraudAlert: { id: 'a1' },
  timestamp: '2026-10-06T05:00:00Z', scoreBreakdown: BREAKDOWN,
};
const fill = () => {
  fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1200' } });
  fireEvent.change(screen.getByLabelText(/merchant name/i), { target: { value: 'Cafe' } });
  fireEvent.change(screen.getByLabelText(/city/i), { target: { value: 'Pune' } });
  fireEvent.click(screen.getByRole('button', { name: /submit for fraud check/i }));
};
const NOTE = 'This payment was already processed - showing the original result.';

describe('SubmitTransaction: B-01 + C-01', () => {
  it('shows the breakdown in the result and no replay note on a normal 201', async () => {
    api.post.mockResolvedValueOnce(ok(RESULT));
    renderApp(<SubmitTransaction />, { auth: signedIn() });
    fill();
    expect(await screen.findByText('TXN-2026-00001')).toBeInTheDocument();
    expect(screen.getByTestId('score-breakdown')).toBeInTheDocument();
    expect(screen.queryByText(NOTE)).toBeNull();
  });
  it('C-01: a 200 with replayed:true is a success — original result plus the note', async () => {
    api.post.mockResolvedValueOnce({ data: { success: true, data: RESULT, replayed: true } });
    renderApp(<SubmitTransaction />, { auth: signedIn() });
    fill();
    expect(await screen.findByText('TXN-2026-00001')).toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('a result without scoreBreakdown (older server) still renders', async () => {
    const { scoreBreakdown, ...legacy } = RESULT; // eslint-disable-line no-unused-vars
    api.post.mockResolvedValueOnce(ok(legacy));
    renderApp(<SubmitTransaction />, { auth: signedIn() });
    fill();
    expect(await screen.findByText('TXN-2026-00001')).toBeInTheDocument();
    expect(screen.queryByTestId('score-breakdown')).toBeNull();
  });
});

describe('B-01 in the detail panels', () => {
  it('TransactionHistory detail shows the breakdown', async () => {
    const tx = { _id: 't1', publicId: 'TXN-1', merchantName: 'S', amount: 5, paymentMethod: 'UPI', fraudScore: 55, riskLevel: 'HIGH', status: 'BLOCKED', timestamp: '2026-10-05T05:00:00Z' };
    api.get.mockImplementation(async (url) => (url === '/customer-api/transactions' ? page([tx], 1) : ok({ transaction: { ...tx, reasons: [], scoreBreakdown: BREAKDOWN }, deviceReputation: null })));
    renderApp(<TransactionHistory />, { auth: signedIn() });
    expect(await screen.findByText('BLOCKED')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Details for TXN-1' }));
    expect(await screen.findByTestId('score-breakdown')).toBeInTheDocument();
  });
  it('Flagged investigation shows the breakdown', async () => {
    const tx = { _id: 't1', publicId: 'TXN-1', userId: { name: 'Asha' }, merchantName: 'S', amount: 5, fraudScore: 55, riskLevel: 'HIGH', status: 'HELD', timestamp: '2026-10-05T05:00:00Z' };
    api.get.mockImplementation(async (url) => (url === '/analyst-api/flagged-transactions' ? page([tx], 1, 1, 20)
      : ok({ transaction: { ...tx, deviceId: 'd', location: {}, scoreBreakdown: BREAKDOWN }, deviceReputation: null, fraudAlert: { _id: 'fa1', status: 'OPEN' }, existingCase: null })));
    renderApp(<FlaggedTransactions />, { auth: signedIn(ME) });
    fireEvent.click(await screen.findByRole('button', { name: 'Investigate TXN-1' }));
    expect(await screen.findByTestId('score-breakdown')).toBeInTheDocument();
  });
});

describe('F-11 CSV export, SLA and queue', () => {
  let created;
  beforeEach(() => {
    created = [];
    URL.createObjectURL = vi.fn((blob) => { created.push(blob); return 'blob:x'; });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const readBlob = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsText(b, 'utf-8'); });

  it('Flagged Export CSV downloads the loaded rows with BOM, escaping and the formula guard', async () => {
    const tx = { _id: 't1', publicId: 'TXN-1', userId: { name: '=cmd|x' }, merchantName: 'Shop, "Big"', amount: 1500, fraudScore: 55, riskLevel: 'HIGH', status: 'HELD', timestamp: '2026-10-05T05:00:00Z' };
    api.get.mockResolvedValue(page([tx], 1, 1, 20));
    renderApp(<FlaggedTransactions />, { auth: signedIn(ME) });
    await screen.findByText('TXN-1');
    const link = vi.spyOn(document, 'createElement');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(created).toHaveLength(1);
    const a = link.mock.results.map((r) => r.value).find((el) => el.tagName === 'A');
    expect(a.download).toMatch(/^flagged-transactions-\d{4}-\d{2}-\d{2}\.csv$/);
    const bytes = new Uint8Array(await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsArrayBuffer(created[0]); }));
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM
    const text = await readBlob(created[0]);
    expect(text).toContain("'=cmd|x");
    expect(text).toContain('"Shop, ""Big"""');
    expect(text.split('\r\n')[0].replace('﻿', '')).toBe('Transaction,Customer,Merchant,Amount (INR),Score,Risk,Status,Date (IST)');
  });

  it('Export CSV is disabled with no rows', async () => {
    api.get.mockResolvedValue(page([], 0, 1, 20));
    renderApp(<FlaggedTransactions />, { auth: signedIn(ME) });
    await screen.findByText('No flagged transactions');
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
  });

  const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
  const row = (n, hours, over = {}) => ({
    _id: `c${n}`, publicId: `CASE-${n}`, status: 'UNDER_REVIEW', assignedAnalystId: { name: 'Ravi' }, openedAt: ago(hours),
    transactionId: { publicId: `TXN-${n}`, amount: 100, merchantName: `M${n}`, riskLevel: 'HIGH' }, ...over,
  });

  it('CaseManagement: age text with warn / critical cues (text + icon), sort control, My queue param', async () => {
    api.get.mockResolvedValue(page([row(1, 3.34), row(2, 30), row(3, 80), row(4, 100, { status: 'RESOLVED', resolvedAt: ago(98) })], 4, 1, 20));
    renderApp(<CaseManagement />, { auth: signedIn(ME) });
    expect(await screen.findByText('Open for 3 h 20 min')).toBeInTheDocument();
    expect(screen.getByText('(Over 24 h)')).toBeInTheDocument();
    expect(screen.getByText('(Over 72 h - critical)')).toBeInTheDocument();
    expect(screen.getByText(/Closed after 2 h/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'RESOLVED - fraud confirmed' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'DISMISSED - false positive' })).toBeInTheDocument();

    // default: newest first (client-side, this page only)
    const ids = () => screen.getAllByRole('link', { name: /^CASE-/ }).map((l) => l.textContent);
    expect(ids()).toEqual(['CASE-1', 'CASE-2', 'CASE-3', 'CASE-4']);
    fireEvent.change(screen.getByLabelText('Sort this page'), { target: { value: 'old' } });
    expect(ids()).toEqual(['CASE-4', 'CASE-3', 'CASE-2', 'CASE-1']);

    fireEvent.click(screen.getByRole('button', { name: 'My queue' }));
    await waitFor(() => expect(api.get.mock.calls.at(-1)[1].params).toMatchObject({ assignedToMe: true, page: 1 }));
    expect(screen.getByRole('button', { name: 'My queue (on)' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('CaseManagement Export CSV exports the sorted loaded rows incl. Age', async () => {
    api.get.mockResolvedValue(page([row(1, 3.34), row(2, 30)], 2, 1, 20));
    renderApp(<CaseManagement />, { auth: signedIn(ME) });
    await screen.findByText('CASE-1');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const text = await readBlob(created[0]);
    const lines = text.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('Case,Transaction,Merchant,Amount (INR),Risk,Status,Assigned to,Opened (IST),Age');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('CASE-1');
    expect(lines[1]).toMatch(/Open for 3 h 2\d min$|Open for 3 h 3\d min$/);
  });
});

describe('Admin dashboard KPI wording', () => {
  it('labels the open alerts KPI "Open alerts (not yet closed)"', async () => {
    api.get.mockResolvedValue(ok({ totalTransactions: 5, fraudRate: 1, openCases: 2, openAlerts: 3, lossPrevented: 10, riskDistribution: [], highRiskByHour: [], highRiskByPaymentMethod: [], highRiskByCity: [] }));
    renderApp(<AdminDashboard />, { auth: signedIn({ role: 'ADMIN' }) });
    expect(await screen.findByText('Open alerts (not yet closed)')).toBeInTheDocument();
    expect(screen.getByText('Includes alerts whose case is still in progress')).toBeInTheDocument();
  });
});
