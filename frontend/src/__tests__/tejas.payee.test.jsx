// TEJAS D1 (step 1, frontend): payee helpers, the UPI ID field and result notice on Submit, the payee panel for
// analysts, the payee profile page and the payee watchlist page.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderApp, ok, page, fail, signedIn } from '../tests/utils.jsx';
import {
  VPA_PATTERN, normalizeVpa, isValidVpa, normalizeMerchantName, payeeKeyFromInput, payeeProfilePath, payeeLabel,
  labelFromKey, payeeChips, buildWatchlistBody, MANY_SENDERS,
} from '../utils/payee.js';
import { SCENARIOS } from '../utils/scenarios.js';
import { ANALYST_NAV } from '../utils/navigation.js';
import SubmitTransaction from '../pages/customer/SubmitTransaction.jsx';
import PayeePanel from '../components/common/PayeePanel.jsx';
import PayeeNotice from '../components/common/PayeeNotice.jsx';
import PayeeProfile from '../pages/analyst/PayeeProfile.jsx';
import PayeeWatchlist from '../pages/analyst/PayeeWatchlist.jsx';

vi.mock('../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
import api from '../api/axios.js';
import toast from 'react-hot-toast';

const ANALYST = signedIn({ role: 'ANALYST', name: 'Alice Analyst' });
const MULE = 'easyloan.helpdesk@ybl';

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

// ─── helpers ────────────────────────────────────────────────────────────────────────────────────────────────
describe('utils/payee (same rules as backend/utils/payee.js)', () => {
  // The SAME examples as backend/tests/tejas.payee.units.test.js, so the two copies cannot drift apart.
  it.each([
    ['ravi@okaxis', true], ['ravi.kumar-99_x@ybl', true], ['9876543210@paytm', true], ['ab@upi', true],
    ['a@upi', false], ['.ravi@ybl', false], ['ravi@', false], ['@ybl', false], ['ravi', false], ['ravi@ok axis', false],
    ['ravi@ybl1', false], ['ravi@@ybl', false], ['ra vi@ybl', false], ['ravi@y', false],
    [`${'a'.repeat(65)}@ybl`, false], [`${'a'.repeat(64)}@ybl`, true],
  ])('isValidVpa(%j) → %s', (value, valid) => expect(isValidVpa(value)).toBe(valid));

  it('normalises like the backend', () => {
    expect(normalizeVpa('  Ravi.K@OkAxis ')).toBe('ravi.k@okaxis');
    expect(normalizeVpa('ｒａｖｉ@ybl')).toBe('ravi@ybl');
    expect(normalizeVpa(5)).toBe('');
    expect(normalizeMerchantName('\tBook  Store\n')).toBe('book store');
    expect(VPA_PATTERN.test('x ravi@ybl')).toBe(false);
  });

  it('payeeKeyFromInput: "@" means UPI ID, otherwise merchant', () => {
    expect(payeeKeyFromInput(' Easyloan.Helpdesk@YBL ')).toEqual({ key: `vpa:${MULE}`, kind: 'vpa' });
    expect(payeeKeyFromInput('  Gadget   Hub ')).toEqual({ key: 'merchant:gadget hub', kind: 'merchant' });
    expect(payeeKeyFromInput('bad@')).toEqual({ error: expect.stringMatching(/name@bank/) });
    expect(payeeKeyFromInput('   ')).toEqual({ error: 'Enter a UPI ID or a merchant name' });
    expect(payeeKeyFromInput('x'.repeat(201)).error).toMatch(/200/);
  });

  it('labels and links', () => {
    expect(labelFromKey('vpa:a1@ybl')).toBe('a1@ybl');
    expect(labelFromKey('merchant:book store')).toBe('book store');
    expect(payeeProfilePath('merchant:book store')).toBe('/analyst/payees?key=merchant%3Abook%20store');
    expect(payeeLabel({ payee: { key: 'vpa:a1@ybl', vpa: 'a1@ybl' }, merchantName: 'X' })).toBe('a1@ybl');
    expect(payeeLabel({ merchantName: 'Shop' })).toBe('Shop');
    expect(payeeLabel(null)).toBe('Unknown payee');
  });

  it('payeeChips: most serious first, and only what applies', () => {
    expect(payeeChips(null)).toEqual([]);
    const all = payeeChips({ watchlisted: true, sendersLast24h: MANY_SENDERS, firstTimePayee: true, payeeAgeDays: 0 }).map((c) => c.text);
    expect(all).toEqual(['On the payee watchlist', `Paid by ${MANY_SENDERS} customers in 24 h`, 'First payment from this customer to this payee', 'New payee (first paid under a day ago)']);
    const quiet = payeeChips({ watchlisted: false, sendersLast24h: MANY_SENDERS - 1, firstTimePayee: false, payeeAgeDays: 1 });
    expect(quiet).toEqual([{ tone: 'neutral', text: 'Payee known for 1 day' }]);
    expect(payeeChips({ watchlisted: false, sendersLast24h: 0, firstTimePayee: false, payeeAgeDays: 30 })[0].text).toBe('Payee known for 30 days');
  });

  it('buildWatchlistBody mirrors the API rules', () => {
    expect(buildWatchlistBody(' Easyloan.Helpdesk@YBL ', ' 3 victims ')).toEqual({ body: { vpa: MULE, note: '3 victims' } });
    expect(buildWatchlistBody('Lucky Prize Desk', '')).toEqual({ body: { merchantName: 'Lucky Prize Desk' } });
    expect(buildWatchlistBody('nope@', '').error).toMatch(/name@bank/);
    expect(buildWatchlistBody('  ', '').error).toBe('Enter a UPI ID or a merchant name');
    expect(buildWatchlistBody('ok12@ybl', 'x'.repeat(301)).error).toMatch(/300/);
  });

  it('every example payment sets payeeVpa, and the analyst menu has the two payee pages', () => {
    for (const s of SCENARIOS) {
      const v = s.values({ deviceId: 'd', city: 'Pune' });
      expect(v).toHaveProperty('payeeVpa');
      expect(v.payeeVpa === '' || isValidVpa(v.payeeVpa)).toBe(true);
    }
    expect(ANALYST_NAV.map((n) => n.to)).toEqual(expect.arrayContaining(['/analyst/payees', '/analyst/payee-watchlist']));
  });
});

// ─── customer: submit form and result ───────────────────────────────────────────────────────────────────────
describe('SubmitTransaction: payee UPI ID', () => {
  const RESULT = {
    id: 't1', publicId: 'TXN-2026-00001', amount: 9500, merchantName: 'Easy Loan Helpdesk', paymentMethod: 'UPI',
    fraudScore: 10, riskLevel: 'LOW', reasons: [], recommendedAction: 'APPROVE', estimatedLoss: 0, status: 'APPROVED',
    fraudAlert: null, timestamp: '2026-11-23T05:00:00Z',
  };
  const renderPage = () => renderApp(<SubmitTransaction />, { auth: signedIn() });
  const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const fill = () => { type(/amount/i, '9500'); type(/merchant name/i, 'Easy Loan Helpdesk'); type('City', 'Pune'); };
  const submit = () => fireEvent.click(screen.getByRole('button', { name: /submit for fraud check/i }));

  it('a malformed UPI ID is refused in the form and nothing is sent', async () => {
    renderPage();
    fill();
    type(/payee upi id/i, 'ravi@');
    submit();
    expect(await screen.findByText(/like name@bank/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a valid UPI ID is sent (trimmed); an empty one is left out', async () => {
    api.post.mockResolvedValue(ok(RESULT));
    renderPage();
    fill();
    type(/payee upi id/i, `  ${MULE} `);
    submit();
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1].payeeVpa).toBe(MULE);

    fireEvent.click(await screen.findByRole('button', { name: 'Submit another' }));
    fill();
    submit();
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post.mock.calls[1][1]).not.toHaveProperty('payeeVpa');
  });

  it('the result names the payee and warns about a watchlisted one', async () => {
    api.post.mockResolvedValue(ok({ ...RESULT, payee: { key: `vpa:${MULE}`, vpa: MULE }, payeeSignals: { firstTimePayee: true, watchlisted: true } }));
    renderPage();
    fill();
    type(/payee upi id/i, MULE);
    submit();
    expect(await screen.findByText(/received money in confirmed fraud cases/)).toBeInTheDocument();
    expect(screen.getByText('Paid to').parentElement).toHaveTextContent(`Paid to${MULE}`);
  });

  it('"Unknown UPI ID" example fills the UPI ID; switching example clears it', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Unknown UPI ID' }));
    expect(screen.getByLabelText(/payee upi id/i)).toHaveValue(MULE);
    fireEvent.click(screen.getByRole('button', { name: 'Account takeover' }));
    expect(screen.getByLabelText(/payee upi id/i)).toHaveValue('');
  });
});

describe('PayeeNotice', () => {
  it('first payment to a UPI ID → info; merchant payee or a known payee → nothing; no signals → nothing', () => {
    const { rerender, container } = render(<PayeeNotice result={{ payee: { vpa: MULE }, payeeSignals: { firstTimePayee: true, watchlisted: false } }} />);
    expect(screen.getByRole('status')).toHaveTextContent(`first payment to ${MULE}`);
    rerender(<PayeeNotice result={{ payee: { key: 'merchant:x' }, payeeSignals: { firstTimePayee: true, watchlisted: false } }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PayeeNotice result={{ payee: { vpa: MULE }, payeeSignals: { firstTimePayee: false, watchlisted: false } }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PayeeNotice result={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// ─── analyst: payee panel ───────────────────────────────────────────────────────────────────────────────────
describe('PayeePanel', () => {
  const panel = (t) => render(<MemoryRouter><PayeePanel transaction={t} /></MemoryRouter>);

  it('links the UPI ID to its profile and shows the signals', () => {
    panel({
      merchantName: 'Easy Loan Helpdesk', payee: { key: `vpa:${MULE}`, vpa: MULE },
      payeeSignals: { firstTimePayee: true, payeeAgeDays: 0, sendersLast24h: 4, inflowLast24h: 38000, watchlisted: true },
    });
    expect(screen.getByRole('link', { name: MULE })).toHaveAttribute('href', payeeProfilePath(`vpa:${MULE}`));
    const chips = within(screen.getByRole('list', { name: 'Payee signals' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(chips).toEqual(['On the payee watchlist', 'Paid by 4 customers in 24 h', 'First payment from this customer to this payee', 'New payee (first paid under a day ago)']);
    expect(screen.getByTestId('payee-panel')).toHaveTextContent('4 customers paid this payee');
    expect(screen.getByTestId('payee-panel')).toHaveTextContent('not part of the score yet');
  });

  it('a payment from before payee tracking shows the merchant and a note, without a link', () => {
    panel({ merchantName: 'Old Shop' });
    expect(screen.getByText('Old Shop')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/before payee tracking started/)).toBeInTheDocument();
  });

  it('a merchant payee is linked by its merchant key', () => {
    panel({ merchantName: 'Book Store', payee: { key: 'merchant:book store' }, payeeSignals: { firstTimePayee: false, payeeAgeDays: 12, sendersLast24h: 1, inflowLast24h: 500, watchlisted: false } });
    expect(screen.getByRole('link', { name: 'Book Store' })).toHaveAttribute('href', payeeProfilePath('merchant:book store'));
    expect(screen.getByText('(merchant)')).toBeInTheDocument();
  });
});

// ─── analyst: payee profile page ────────────────────────────────────────────────────────────────────────────
const PROFILE = {
  key: `vpa:${MULE}`, label: MULE,
  totals: { payments: 3, amount: 28500, distinctSenders: 3, firstPaymentAt: '2026-11-23T03:00:00Z', lastPaymentAt: '2026-11-23T05:00:00Z' },
  last24h: { payments: 3, amount: 28500, distinctSenders: 3 },
  riskMix: { LOW: 2, MEDIUM: 1, HIGH: 0, CRITICAL: 0 },
  watchlist: null,
  recentPayments: [
    { id: 'p1', publicId: 'TXN-2026-00003', customer: { id: 'c1', name: 'Asha' }, amount: 9500, paymentMethod: 'UPI', riskLevel: 'MEDIUM', fraudScore: 30, status: 'APPROVED', timestamp: '2026-11-23T05:00:00Z' },
  ],
};

describe('PayeeProfile', () => {
  const renderPage = (route = '/analyst/payees') => renderApp(<PayeeProfile />, { route, auth: ANALYST });

  it('starts idle and sends no request', async () => {
    api.get.mockResolvedValue(ok(PROFILE));
    renderPage();
    expect(screen.getByText('Search for a payee')).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('a deep link (?key=) does ONE lookup and fills the box with the readable payee', async () => {
    api.get.mockResolvedValue(ok(PROFILE));
    renderPage(`/analyst/payees?key=${encodeURIComponent(`vpa:${MULE}`)}`);
    expect(await screen.findByRole('heading', { name: MULE })).toBeInTheDocument();
    expect(screen.getByLabelText('UPI ID or merchant name')).toHaveValue(MULE);
    await new Promise((r) => setTimeout(r, 30));
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls[0][0]).toBe('/analyst-api/payees/profile');
    expect(api.get.mock.calls[0][1].params).toEqual({ key: `vpa:${MULE}` });
    expect(screen.getByText('Not on the payee watchlist.')).toBeInTheDocument();
    expect(screen.getByText('Asha')).toBeInTheDocument();
  });

  it('searching a merchant name builds the merchant key; a bad UPI ID is refused without a request', async () => {
    api.get.mockResolvedValue(ok({ ...PROFILE, key: 'merchant:gadget hub', label: 'Gadget Hub' }));
    renderPage();
    fireEvent.change(screen.getByLabelText('UPI ID or merchant name'), { target: { value: 'nope@' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/like name@bank/)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('UPI ID or merchant name'), { target: { value: '  Gadget   Hub ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('heading', { name: 'Gadget Hub' })).toBeInTheDocument();
    expect(api.get.mock.calls[0][1].params).toEqual({ key: 'merchant:gadget hub' });
  });

  it('404 is a result, not an error', async () => {
    api.get.mockRejectedValue(fail(404, 'No payments to this payee were found.'));
    renderPage(`/analyst/payees?key=${encodeURIComponent('vpa:nobody01@ybl')}`);
    expect(await screen.findByText('No payments to this payee')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('"Add to watchlist" posts the UPI ID and reloads', async () => {
    api.get.mockResolvedValueOnce(ok(PROFILE))
      .mockResolvedValueOnce(ok({ ...PROFILE, watchlist: { active: true, source: 'ANALYST_REPORT', caseCount: 0, addedAt: '2026-11-23T06:00:00Z', note: '' } }));
    api.post.mockResolvedValue(ok({ id: 'w1' }, { message: 'Payee added to the watchlist.' }));
    renderPage(`/analyst/payees?key=${encodeURIComponent(`vpa:${MULE}`)}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Add to watchlist' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/analyst-api/payees/watchlist', { vpa: MULE }));
    expect(await screen.findByText(/On the payee watchlist \(reported by an analyst/)).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Payee added to the watchlist.');
  });
});

// ─── analyst: watchlist page ────────────────────────────────────────────────────────────────────────────────
const ENTRY = {
  id: 'w1', key: `vpa:${MULE}`, vpa: MULE, label: MULE, source: 'CONFIRMED_FRAUD', note: 'Fraud confirmed in case CASE-2026-00001',
  active: true, caseCount: 2, addedBy: { _id: 'a1', name: 'Alice Analyst' }, addedAt: '2026-11-23T05:00:00Z',
};

describe('PayeeWatchlist', () => {
  const renderPage = () => renderApp(<PayeeWatchlist />, { route: '/analyst/payee-watchlist', auth: ANALYST });

  it('lists active entries with their source, cases and a profile link', async () => {
    api.get.mockResolvedValue(page([ENTRY], 1, 1, 20));
    renderPage();
    expect(await screen.findByRole('link', { name: MULE })).toHaveAttribute('href', payeeProfilePath(ENTRY.key));
    expect(screen.getByText('Fraud confirmed')).toBeInTheDocument();
    expect(api.get.mock.calls[0][1].params).toEqual({ status: 'active', page: 1, limit: 20 });
  });

  it('the filter asks the server for removed entries; the Status column appears only there', async () => {
    const removed = { ...ENTRY, id: 'w9', active: false, removedAt: '2026-11-23T07:00:00Z', removalNote: 'false report' };
    api.get.mockImplementation(async (_url, { params }) => page(params.status === 'removed' ? [removed] : [ENTRY], 1, 1, 20));
    renderPage();
    await screen.findByRole('link', { name: MULE });
    expect(screen.queryByRole('columnheader', { name: 'Status' })).toBeNull();
    expect(screen.getByRole('button', { name: `Remove ${MULE}` })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'removed' } });
    await waitFor(() => expect(api.get.mock.calls.at(-1)[1].params).toEqual({ status: 'removed', page: 1, limit: 20 }));
    expect(await screen.findByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(await screen.findByText('false report')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Remove ${MULE}` })).toBeNull(); // removed entries cannot be removed again
  });

  it('adds a payee (validated first) and reloads the list', async () => {
    api.get.mockResolvedValue(page([], 0, 1, 20));
    api.post.mockResolvedValue(ok(ENTRY, { message: 'Payee added to the watchlist.' }));
    renderPage();
    await screen.findByText('No payees here');
    fireEvent.change(screen.getByLabelText('UPI ID or merchant name'), { target: { value: 'nope@' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to watchlist' }));
    expect(await screen.findByText(/like name@bank/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('UPI ID or merchant name'), { target: { value: ` ${MULE.toUpperCase()} ` } });
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'reported by 3 customers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to watchlist' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/analyst-api/payees/watchlist', { vpa: MULE, note: 'reported by 3 customers' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('UPI ID or merchant name')).toHaveValue('');
  });

  it('a server error on add is shown in the form', async () => {
    api.get.mockResolvedValue(page([], 0, 1, 20));
    api.post.mockRejectedValue(fail(422, 'Validation failed.', { errors: [{ field: 'vpa', message: 'Payee UPI ID must look like name@bank' }] }));
    renderPage();
    await screen.findByText('No payees here');
    fireEvent.change(screen.getByLabelText('UPI ID or merchant name'), { target: { value: 'Lucky Prize Desk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to watchlist' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('removing asks first, sends the reason and reloads', async () => {
    api.get.mockResolvedValueOnce(page([ENTRY], 1, 1, 20)).mockResolvedValue(page([], 0, 1, 20));
    api.delete.mockResolvedValue(ok({ ...ENTRY, active: false }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: `Remove ${MULE}` }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'false report' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/analyst-api/payees/watchlist/w1', { data: { note: 'false report' } }));
    expect(await screen.findByText('No payees here')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
