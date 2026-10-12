// E-19: an axe-like DOM check without extra dependencies — every table header has a name (no empty
// <th>) and heading levels never skip (h1 → h2 → h3), on the pages that had these defects.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import UserManagement from '../admin/UserManagement.jsx';
import AuditLogs from '../admin/AuditLogs.jsx';
import AdminDashboard from '../admin/AdminDashboard.jsx';
import AdminTrends from '../admin/AdminTrends.jsx';
import TransactionHistory from '../customer/TransactionHistory.jsx';
import FlaggedTransactions from '../analyst/FlaggedTransactions.jsx';
import { renderApp, ok, page, signedIn } from '../../tests/utils.jsx';

vi.mock('../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../api/axios.js';

/** Table headers (th) with no text, aria-label or labelled content. */
const emptyHeaders = (root) => [...root.querySelectorAll('th')].filter((th) => !th.textContent.trim() && !th.getAttribute('aria-label'));
/** Headings that jump down more than one level (h1 → h3). */
const headingSkips = (root) => {
  const levels = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]));
  return levels.filter((l, i) => i > 0 && l > levels[i - 1] + 1);
};

const ROW = {
  _id: 'r1', publicId: 'TXN-1', merchantName: 'Shop', amount: 10, paymentMethod: 'UPI', fraudScore: 80, riskLevel: 'HIGH', status: 'HELD',
  timestamp: '2026-10-05T05:00:00Z', userId: { name: 'Asha' },
};

beforeEach(() => { vi.clearAllMocks(); });

describe('no empty table headers', () => {
  it('UserManagement', async () => {
    api.get.mockResolvedValue(page([{ _id: 'u1', name: 'Asha', email: 'a@x.com', role: 'CUSTOMER', trustScore: 80, isActive: true, createdAt: '2026-09-01T00:00:00Z' }], 1, 1, 50));
    const { container } = renderApp(<UserManagement />, { auth: signedIn({ id: 'me', role: 'ADMIN' }) });
    await screen.findByText('Asha');
    expect(emptyHeaders(container)).toHaveLength(0);
    expect(screen.getAllByText('Actions').every((el) => el.classList.contains('sr-only'))).toBe(true);
  });

  it('AuditLogs', async () => {
    api.get.mockResolvedValue(page([{ _id: 'l1', action: 'USER_LOGIN', entityType: 'User', entityId: 'u1', timestamp: '2026-10-05T05:00:00Z' }], 1, 1, 50));
    const { container } = renderApp(<AuditLogs />, { auth: signedIn({ role: 'ADMIN' }) });
    await screen.findByText('USER LOGIN');
    expect(emptyHeaders(container)).toHaveLength(0);
  });

  it('TransactionHistory', async () => {
    api.get.mockResolvedValue(page([ROW]));
    const { container } = renderApp(<TransactionHistory />, { auth: signedIn() });
    await screen.findByText('TXN-1');
    expect(emptyHeaders(container)).toHaveLength(0);
  });

  it('FlaggedTransactions', async () => {
    api.get.mockResolvedValue(page([ROW]));
    const { container } = renderApp(<FlaggedTransactions />, { auth: signedIn({ role: 'ANALYST' }) });
    await screen.findByText('TXN-1');
    expect(emptyHeaders(container)).toHaveLength(0);
  });
});

describe('heading levels do not skip', () => {
  it('AdminDashboard: h1, then the chart cards and the live feed as h2', async () => {
    api.get.mockResolvedValue(ok({
      totalTransactions: 5, fraudRate: 20, openCases: 1, openAlerts: 2, lossPrevented: 100,
      riskDistribution: [{ _id: 'HIGH', count: 2 }], fraudByHour: [{ hour: 9, count: 2 }], fraudByPaymentMethod: [{ paymentMethod: 'UPI', count: 2 }],
      fraudByLocation: [{ city: 'Pune', count: 2 }, { city: 'Unknown', count: 1 }],
    }));
    const { container } = renderApp(<AdminDashboard />, { auth: signedIn({ role: 'ADMIN' }) });
    await screen.findByRole('heading', { level: 2, name: 'Risk distribution' });
    expect(headingSkips(container)).toEqual([]);
    expect(container.querySelectorAll('h3')).toHaveLength(0);
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThanOrEqual(5);
  });

  it('AdminTrends', async () => {
    api.get.mockResolvedValue(ok({ dailyTrend: [{ date: '2026-10-03', count: 2, totalAmount: 10, avgFraudScore: 60, movingAvg: 1 }], peakFraudHours: [] }));
    const { container } = renderApp(<AdminTrends />, { auth: signedIn({ role: 'ADMIN' }) });
    await screen.findByRole('heading', { level: 2, name: 'High-risk transactions per day' });
    expect(headingSkips(container)).toEqual([]);
  });

  it('F-10: the city chart labels a missing / "Unknown" city as "Unknown location"', async () => {
    api.get.mockResolvedValue(ok({
      totalTransactions: 5, fraudRate: 20, openCases: 0, openAlerts: 0, lossPrevented: 0, riskDistribution: [], fraudByHour: [], fraudByPaymentMethod: [],
      fraudByLocation: [{ city: 'Unknown', count: 3 }, { city: null, count: 1 }, { city: 'Pune', count: 2 }],
    }));
    renderApp(<AdminDashboard />, { auth: signedIn({ role: 'ADMIN' }) });
    await screen.findByRole('heading', { level: 2, name: 'High-risk by city' });
    expect(screen.getAllByText('Unknown location').length).toBeGreaterThanOrEqual(2); // table alternative rows
    expect(screen.queryByText('Unknown')).toBeNull();
  });
});

describe('F-10: transaction detail shows an explicit unknown location', () => {
  it('TransactionHistory modal', async () => {
    api.get.mockImplementation(async (url) => (url === '/customer-api/transactions'
      ? page([{ ...ROW, location: { city: 'Unknown', country: 'IN' } }])
      : ok({ transaction: { ...ROW, location: { city: 'Unknown', country: 'IN' } }, deviceReputation: null })));
    renderApp(<TransactionHistory />, { auth: signedIn() });
    const cell = await screen.findByText('TXN-1');
    fireEvent.click(cell.closest('tr').querySelector('button'));
    expect(await screen.findByText('Unknown location, IN')).toBeInTheDocument();
  });
});
