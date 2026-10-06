// Dashboards (N-08/N-02), FlaggedTransactions (N-22/N-02), common LoadError / BusyRegion / StatCard
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, render } from '@testing-library/react';
import CustomerDashboard from '../customer/CustomerDashboard.jsx';
import AdminDashboard from '../admin/AdminDashboard.jsx';
import FlaggedTransactions from '../analyst/FlaggedTransactions.jsx';
import LoadError from '../../components/common/LoadError.jsx';
import BusyRegion from '../../components/common/BusyRegion.jsx';
import StatCard from '../../components/common/StatCard.jsx';
import { renderApp, page, fail, signedIn } from '../../tests/utils.jsx';

vi.mock('../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../api/axios.js';

beforeEach(() => { vi.clearAllMocks(); });

describe('CustomerDashboard', () => {
  it('shows trust-score and open-alerts errors independently, each with Retry', async () => {
    api.get.mockImplementation((url, cfg) => {
      if (url === '/customer-api/trust-score') return Promise.reject(fail(500, 'Trust down'));
      if (url === '/customer-api/fraud-alerts' && cfg?.params?.status === 'OPEN') return Promise.reject(fail(500, 'Alerts down'));
      return Promise.resolve(page([], 0));
    });
    renderApp(<CustomerDashboard />, { auth: signedIn() });
    expect(await screen.findByText('Trust score: Trust down')).toBeInTheDocument();
    expect(screen.getByText('Open alerts: Alerts down')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThanOrEqual(2);
  });
});

describe('AdminDashboard', () => {
  it('on a failed load shows the error with Retry and no zero KPIs', async () => {
    api.get.mockRejectedValueOnce(fail(500, 'Analytics unavailable'));
    renderApp(<AdminDashboard />, { auth: signedIn({ role: 'ADMIN' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Analytics unavailable');
    expect(screen.queryByText('Fraud rate')).toBeNull();
    expect(screen.queryByText('Transactions')).toBeNull();
    api.get.mockRejectedValueOnce(fail(500, 'Still down'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Still down')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});

describe('FlaggedTransactions', () => {
  const TX = { _id: 't1', publicId: 'TXN-1', merchantName: 'Shop', amount: 500, fraudScore: 80, riskLevel: 'HIGH', status: 'FLAGGED', timestamp: '2026-10-05T05:00:00Z', userId: { name: 'Asha' } };
  it('puts Investigate in the first column', async () => {
    api.get.mockResolvedValue(page([TX], 1));
    renderApp(<FlaggedTransactions />, { auth: signedIn({ role: 'ANALYST' }) });
    const btn = await screen.findByRole('button', { name: /^Investigate/ });
    expect(btn.closest('td').previousElementSibling).toBeNull();
    expect(btn.closest('tr').children[1]).toHaveTextContent('TXN-1');
  });
  it('shows an error with Retry instead of the empty state', async () => {
    api.get.mockRejectedValueOnce(fail(500, 'Boom'));
    renderApp(<FlaggedTransactions />, { auth: signedIn({ role: 'ANALYST' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
    expect(screen.queryByText('No flagged transactions')).toBeNull();
    api.get.mockResolvedValueOnce(page([TX], 1));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('TXN-1')).toBeInTheDocument();
  });
});

describe('common widgets', () => {
  it('LoadError renders nothing without a message, and Retry calls back', () => {
    const { container, rerender } = render(<LoadError message="" onRetry={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    const onRetry = vi.fn();
    rerender(<LoadError message="Bad" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it('BusyRegion shows the status pill only while busy and keeps children', () => {
    const { rerender } = render(<BusyRegion busy><p>rows</p></BusyRegion>);
    expect(screen.getByRole('status')).toHaveTextContent(/Updating/);
    expect(screen.getByText('rows')).toBeInTheDocument();
    rerender(<BusyRegion busy={false}><p>rows</p></BusyRegion>);
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('StatCard skeleton exposes an sr-only Loading label', () => {
    render(<StatCard label="X" value={1} loading />);
    expect(screen.getByText('Loading')).toHaveClass('sr-only');
  });
});
