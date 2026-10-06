// NotificationPanel: disclosure semantics, Escape / outside click / focus-out, errors (N-15, N-02)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import NotificationPanel from '../NotificationPanel.jsx';
import { renderApp, page, fail, signedIn } from '../../../tests/utils.jsx';

vi.mock('../../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../../api/axios.js';

const NOTES = [
  { _id: 'n1', type: 'FRAUD_ALERT', title: 'Payment held', message: 'Your payment was held', isRead: false, createdAt: '2026-10-05T05:00:00Z' },
  { _id: 'n2', type: 'CASE_STATUS_CHANGED', title: 'Case closed', message: 'Reviewed', isRead: true, createdAt: '2026-10-04T05:00:00Z' },
];
const renderPanel = () => renderApp(
  <><NotificationPanel /><button type="button">elsewhere</button><p>plain text</p></>,
  { auth: signedIn({ role: 'CUSTOMER' }), preloadedState: { notifications: { notifications: [], unreadCount: 1, loading: false, error: '', listRequestId: null } } },
);
const bell = () => screen.getByRole('button', { name: /^notifications/i });

beforeEach(() => { vi.clearAllMocks(); api.get.mockResolvedValue(page(NOTES, 2, 1, 20)); });

describe('NotificationPanel', () => {
  it('N-15: the bell is a disclosure button (aria-expanded + aria-controls, no aria-haspopup)', async () => {
    renderPanel();
    expect(bell()).toHaveAttribute('aria-expanded', 'false');
    expect(bell()).not.toHaveAttribute('aria-haspopup');
    expect(bell()).toHaveAccessibleName('Notifications, 1 unread');
    fireEvent.click(bell());
    expect(bell()).toHaveAttribute('aria-expanded', 'true');
    const region = await screen.findByRole('region', { name: 'Notifications' });
    expect(bell().getAttribute('aria-controls')).toBe(region.id);
  });

  it('N-15: unread items carry visually hidden text instead of an aria-label on a span', async () => {
    const { container } = renderPanel();
    fireEvent.click(bell());
    await screen.findByText('Payment held');
    expect(container.querySelector('span[aria-label]')).toBeNull();
    const item = screen.getByText('Payment held').closest('button');
    expect(within(item).getByText('Unread')).toHaveClass('sr-only');
    expect(within(screen.getByText('Case closed').closest('button')).queryByText('Unread')).toBeNull();
  });

  it('Escape closes the panel and returns focus to the bell', async () => {
    renderPanel();
    fireEvent.click(bell());
    const first = await screen.findByText('Payment held');
    first.closest('button').focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
    expect(document.activeElement).toBe(bell());
  });

  it('closes on a click outside, but not on a click inside', async () => {
    renderPanel();
    fireEvent.click(bell());
    const region = await screen.findByRole('region', { name: 'Notifications' });
    fireEvent.mouseDown(region);
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText('plain text'));
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
  });

  it('closes when keyboard focus moves to something outside it', async () => {
    renderPanel();
    fireEvent.click(bell());
    const item = (await screen.findByText('Payment held')).closest('button');
    item.focus();
    fireEvent.blur(item, { relatedTarget: screen.getByRole('button', { name: 'elsewhere' }) });
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
  });

  it('stays open when focus moves within it (or to nothing, e.g. a click on plain text)', async () => {
    renderPanel();
    fireEvent.click(bell());
    const item = (await screen.findByText('Payment held')).closest('button');
    item.focus();
    fireEvent.blur(item, { relatedTarget: screen.getByRole('button', { name: 'Mark all read' }) });
    fireEvent.blur(item, { relatedTarget: null });
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('N-02: a failed load shows the error with Retry instead of "You’re all caught up"', async () => {
    api.get.mockRejectedValueOnce(fail(500, 'Notifications unavailable'));
    renderPanel();
    fireEvent.click(bell());
    expect(await screen.findByText('Notifications unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/all caught up/i)).toBeNull();
    api.get.mockResolvedValueOnce(page(NOTES, 2, 1, 20));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Payment held')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Notifications unavailable')).toBeNull());
  });
});
