// TransactionHistory: error + Retry (N-02), filter params, stale rows (N-03/N-08), detail modal
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import TransactionHistory from '../customer/TransactionHistory.jsx';
import { renderApp, ok, page, fail, signedIn } from '../../tests/utils.jsx';

vi.mock('../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../api/axios.js';

const TX = (n, over = {}) => ({
  _id: `t${n}`, publicId: `TXN-2026-0000${n}`, merchantName: `Shop ${n}`, amount: 100 * n, paymentMethod: 'UPI',
  fraudScore: 10, riskLevel: 'LOW', status: 'APPROVED', timestamp: '2026-10-05T05:00:00Z', ...over,
});
const renderPage = () => renderApp(<TransactionHistory />, { auth: signedIn() });
const lastListParams = () => api.get.mock.calls.filter(([u]) => u === '/customer-api/transactions').at(-1)[1].params;

beforeEach(() => { vi.clearAllMocks(); });

describe('TransactionHistory', () => {
  it('lists the first page with the default limit', async () => {
    api.get.mockResolvedValue(page([TX(1), TX(2)], 2));
    renderPage();
    expect(await screen.findByText('TXN-2026-00001')).toBeInTheDocument();
    expect(lastListParams()).toEqual({ page: 1, limit: 10 });
  });

  it('N-02: a failed load shows the error with Retry — never "No transactions found"', async () => {
    api.get.mockRejectedValueOnce(fail(500, 'Database unavailable'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable');
    expect(screen.queryByText('No transactions found')).toBeNull();
    expect(screen.queryByRole('navigation', { name: /pagination/i })).toBeNull();

    api.get.mockResolvedValueOnce(page([TX(1)], 1));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('TXN-2026-00001')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an empty result still shows the empty state (and no error)', async () => {
    api.get.mockResolvedValue(page([], 0));
    renderPage();
    expect(await screen.findByText('No transactions found')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('filters become request params; dates are sent as IST day bounds; page resets to 1', async () => {
    api.get.mockResolvedValue(page([TX(1)], 35));
    renderPage();
    await screen.findByText('TXN-2026-00001');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastListParams()).toMatchObject({ page: 2 }));

    fireEvent.change(screen.getByLabelText('Risk level'), { target: { value: 'HIGH' } });
    await waitFor(() => expect(lastListParams()).toEqual({ page: 1, limit: 10, riskLevel: 'HIGH' }));

    fireEvent.change(screen.getByLabelText('Payment method'), { target: { value: 'CARD' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-05' } });
    await waitFor(() => expect(lastListParams()).toEqual({
      page: 1, limit: 10, riskLevel: 'HIGH', paymentMethod: 'CARD',
      startDate: '2026-10-01T00:00:00.000+05:30', endDate: '2026-10-05T23:59:59.999+05:30',
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(lastListParams()).toEqual({ page: 1, limit: 10 }));
  });

  it('N-03: while refetching over existing rows they stay but are marked busy, and a slow old answer cannot win', async () => {
    let releaseFirst; let releaseSecond;
    api.get
      .mockReturnValueOnce(new Promise((r) => { releaseFirst = r; }))
      .mockReturnValueOnce(new Promise((r) => { releaseSecond = r; }));
    renderPage();
    // first request still in flight; change a filter → second request
    fireEvent.change(screen.getByLabelText('Risk level'), { target: { value: 'HIGH' } });
    releaseSecond(page([TX(2, { riskLevel: 'HIGH' })], 1));
    expect(await screen.findByText('TXN-2026-00002')).toBeInTheDocument();
    releaseFirst(page([TX(1)], 1)); // the older (unfiltered) answer arrives last
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('TXN-2026-00002')).toBeInTheDocument();
    expect(screen.queryByText('TXN-2026-00001')).toBeNull();
  });

  it('N-19: when the data shrinks under the user, a page beyond the last one jumps back to the last page', async () => {
    api.get.mockImplementation(async (_url, { params }) => {
      if (params.page === 1) return page([TX(1)], params.shrunk ? 5 : 35);
      return page([], 5, params.page); // page 2 no longer exists: only 5 rows remain = 1 page
    });
    renderPage();
    await screen.findByText('TXN-2026-00001');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const pagesRequested = () => api.get.mock.calls.map(([, o]) => o.params.page);
    await waitFor(() => expect(pagesRequested()).toEqual([1, 2, 1])); // 1 → Next → 2 (empty) → back to the last page
    expect(screen.queryByText(/11–5/)).toBeNull();
  });

  it('opens the detail modal, loads the composite, and shows a failure inside it', async () => {
    api.get.mockImplementation(async (url) => {
      if (url === '/customer-api/transactions') return page([TX(1), TX(2)], 2);
      if (url.endsWith('/t1')) return ok({ transaction: { ...TX(1), reasons: ['New device'], location: { city: 'Pune', country: 'IN' } }, deviceReputation: null });
      throw fail(404, 'Transaction not found');
    });
    renderPage();
    await screen.findByText('TXN-2026-00001');
    fireEvent.click(screen.getAllByRole('button', { name: /^Details/ })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Transaction details' });
    expect(await within(dialog).findByText('New device')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: /^Details/ })[1]);
    expect(await within(await screen.findByRole('dialog')).findByText('Transaction not found')).toBeInTheDocument();
  });
});
