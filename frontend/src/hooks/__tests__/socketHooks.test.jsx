// useNotifications / useSocket: lazy socket, rooms, live events, reconnect refetch (F-01), auth rejection,
// debounced analytics refresh (F-08), cleanup. The socket.io-client module is replaced by a fake.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { rootReducer } from '../../store/index.js';
import { signedIn } from '../../tests/utils.jsx';

vi.mock('../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('socket.io-client', () => ({ io: vi.fn() }));
import api from '../../api/axios.js';
import toast from 'react-hot-toast';
import { io } from 'socket.io-client';
import { useNotifications } from '../useNotifications.js';
import { useSocket, ANALYTICS_REFRESH_DEBOUNCE_MS } from '../useSocket.js';
import { resetSocketAuthGuard } from '../../api/socketClient.js';

/** Minimal socket: records handlers, lets the test fire server events. */
function fakeSocket() {
  const handlers = {};
  return {
    handlers,
    emit: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn((event, fn) => { handlers[event] = fn; }),
    fire: (event, payload) => handlers[event]?.(payload),
  };
}

const makeStore = (auth, extra = {}) => configureStore({ reducer: rootReducer, preloadedState: { auth, ...extra } });
const wrap = (store) => ({ children }) => <Provider store={store}>{children}</Provider>;
const mount = async (hook, store) => {
  const result = renderHook(hook, { wrapper: wrap(store) });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); }); // lazy import() settles
  return result;
};

let socket;
beforeEach(() => {
  vi.clearAllMocks();
  resetSocketAuthGuard();
  socket = fakeSocket();
  io.mockReturnValue(socket);
  api.get.mockResolvedValue({ data: { success: true, data: { unreadCount: 3 } } });
});
afterEach(() => { vi.useRealTimers(); });

describe('useNotifications (CUSTOMER / ANALYST)', () => {
  it('connects with the cookie over websocket only and joins the user room on connect', async () => {
    const store = makeStore(signedIn({ id: 'u1', role: 'CUSTOMER' }));
    await mount(() => useNotifications(), store);
    expect(io).toHaveBeenCalledTimes(1);
    expect(io.mock.calls[0][1]).toEqual({ withCredentials: true, transports: ['websocket'] });
    socket.fire('connect');
    expect(socket.emit).toHaveBeenCalledWith('join', 'u1');
  });

  it('does not connect for ADMIN or for a signed-out visitor', async () => {
    await mount(() => useNotifications(), makeStore(signedIn({ role: 'ADMIN' })));
    await mount(() => useNotifications(), makeStore({ ...signedIn(), isAuthenticated: false }));
    expect(io).not.toHaveBeenCalled();
  });

  it('a pushed notification increments the badge, lands in the list and shows a toast', async () => {
    const store = makeStore(signedIn({ role: 'CUSTOMER' }));
    await mount(() => useNotifications(), store);
    act(() => socket.fire('new-notification', { id: 'n1', type: 'FRAUD_ALERT', message: 'Payment held' }));
    expect(store.getState().notifications).toMatchObject({ unreadCount: 1 });
    expect(store.getState().notifications.notifications[0]).toMatchObject({ _id: 'n1', message: 'Payment held' });
    expect(toast).toHaveBeenCalledWith('Payment held', { icon: '🚨' });

    act(() => socket.fire('new-notification', { id: 'n2', type: 'CASE_ASSIGNED' }));
    expect(toast).toHaveBeenLastCalledWith('You have a new notification', { icon: '🔔' });
  });

  it('F-01: the FIRST connect does not refetch; the 2nd and later ones refetch the unread count', async () => {
    const store = makeStore(signedIn({ role: 'CUSTOMER' }));
    await mount(() => useNotifications(), store);
    socket.fire('connect');
    expect(api.get).not.toHaveBeenCalled();
    await act(async () => { socket.fire('connect'); }); // reconnect
    await waitFor(() => expect(store.getState().notifications.unreadCount).toBe(3));
    expect(api.get).toHaveBeenCalledWith('/notification-api/notifications/unread-count');
    expect(api.get).toHaveBeenCalledTimes(1); // panel closed → no list refetch
  });

  it('F-01: ...and the list too when the panel is open', async () => {
    const store = makeStore(signedIn({ role: 'CUSTOMER' }), {
      notifications: { notifications: [], unreadCount: 0, loading: false, error: '', listRequestId: null, panelOpen: true },
    });
    api.get.mockImplementation(async (url) => (url.endsWith('unread-count')
      ? { data: { success: true, data: { unreadCount: 2 } } }
      : { data: { success: true, data: [{ _id: 'n9', message: 'missed while offline', isRead: false }], pagination: {} } }));
    await mount(() => useNotifications(), store);
    socket.fire('connect');
    await act(async () => { socket.fire('connect'); });
    await waitFor(() => expect(store.getState().notifications.notifications).toHaveLength(1));
    expect(api.get).toHaveBeenCalledWith('/notification-api/notifications', { params: { limit: 20 } });
  });

  it('F-01: an auth rejection stops the reconnect loop and re-runs the session check', async () => {
    const store = makeStore(signedIn({ role: 'CUSTOMER' }));
    api.get.mockRejectedValue({ response: { status: 401, data: { message: 'Authentication required' } } });
    await mount(() => useNotifications(), store);
    await act(async () => { socket.fire('connect_error', new Error('UNAUTHENTICATED')); });
    expect(socket.disconnect).toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledWith('/auth/check-auth');
    await waitFor(() => expect(store.getState().auth.isAuthenticated).toBe(false)); // → ProtectedRoute sends the user to /login
  });

  it('F-01: repeated auth rejections do not start a session-check loop', async () => {
    const store = makeStore(signedIn({ role: 'CUSTOMER' }));
    api.get.mockResolvedValue({ data: { success: true, data: { id: 'u1', role: 'CUSTOMER' } } }); // session still valid
    await mount(() => useNotifications(), store);
    await act(async () => { socket.fire('connect_error', new Error('UNAUTHENTICATED')); });
    await act(async () => { socket.fire('connect_error', new Error('UNAUTHENTICATED')); });
    const checks = api.get.mock.calls.filter(([url]) => url === '/auth/check-auth');
    expect(checks).toHaveLength(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(2);
  });

  it('other connect errors (server down) are left to socket.io\'s automatic retry', async () => {
    await mount(() => useNotifications(), makeStore(signedIn({ role: 'CUSTOMER' })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    act(() => socket.fire('connect_error', new Error('websocket error')));
    warn.mockRestore();
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('disconnects on unmount', async () => {
    const { unmount } = await mount(() => useNotifications(), makeStore(signedIn({ role: 'CUSTOMER' })));
    unmount();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('F-04: unmounting before the lazily loaded socket library arrives still ends in a disconnect', async () => {
    const { unmount } = renderHook(() => useNotifications(), { wrapper: wrap(makeStore(signedIn({ role: 'CUSTOMER' }))) });
    unmount(); // import() has not resolved yet
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(socket.disconnect).toHaveBeenCalledTimes(1));
    expect(socket.on).not.toHaveBeenCalled(); // no listeners left behind
  });
});

describe('useSocket (ADMIN)', () => {
  const adminStore = (extra) => makeStore(signedIn({ id: 'a1', role: 'ADMIN' }), extra);

  it('only connects for a signed-in ADMIN, joins its room and disconnects on unmount', async () => {
    await mount(() => useSocket(), makeStore(signedIn({ role: 'CUSTOMER' })));
    expect(io).not.toHaveBeenCalled();
    const { unmount } = await mount(() => useSocket(), adminStore());
    expect(io).toHaveBeenCalledTimes(1);
    socket.fire('connect');
    expect(socket.emit).toHaveBeenCalledWith('join', 'a1');
    unmount();
    expect(socket.disconnect).toHaveBeenCalled();
  });

  it('no longer registers a (no-op) new-notification listener', async () => {
    await mount(() => useSocket(), adminStore());
    expect(Object.keys(socket.handlers).sort()).toEqual(['connect', 'connect_error', 'fraud_alert', 'simulation_start', 'simulation_stop']);
  });

  it('fraud_alert feeds the live list; the simulation feed only while a simulation runs', async () => {
    const store = adminStore();
    await mount(() => useSocket(), store);
    act(() => socket.fire('fraud_alert', { transactionId: 't1', publicId: 'TXN-1', riskLevel: 'HIGH' }));
    expect(store.getState().fraudAlerts.alerts[0]).toMatchObject({ _id: 't1', status: 'OPEN' });
    expect(store.getState().simulation.events).toHaveLength(0);

    act(() => socket.fire('simulation_start', { transactionCount: 5 }));
    expect(store.getState().simulation.isRunning).toBe(true);
    act(() => socket.fire('fraud_alert', { transactionId: 't2' }));
    expect(store.getState().simulation.events).toHaveLength(1);

    act(() => socket.fire('simulation_stop', { stoppedBy: 'admin' }));
    expect(store.getState().simulation.isRunning).toBe(false);
  });

  it('F-08: a burst of alerts triggers ONE analytics refresh, after the debounce', async () => {
    vi.useFakeTimers();
    api.get.mockResolvedValue({ data: { success: true, data: { totalTransactions: 42 } } });
    const store = adminStore();
    renderHook(() => useSocket(), { wrapper: wrap(store) });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => {
      socket.fire('fraud_alert', { transactionId: 't1' });
      socket.fire('fraud_alert', { transactionId: 't2' });
      socket.fire('fraud_alert', { transactionId: 't3' });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(ANALYTICS_REFRESH_DEBOUNCE_MS - 100); });
    expect(api.get).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/admin-api/analytics');
    expect(store.getState().analytics.totalTransactions).toBe(42);
  });

  it('F-08: a refresh is skipped while an analytics request is already in flight, and cancelled on unmount', async () => {
    vi.useFakeTimers();
    const store = adminStore({ analytics: { ...makeStore(signedIn()).getState().analytics, loading: true } });
    const { unmount } = renderHook(() => useSocket(), { wrapper: wrap(store) });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => socket.fire('fraud_alert', { transactionId: 't1' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(ANALYTICS_REFRESH_DEBOUNCE_MS + 10); });
    expect(api.get).not.toHaveBeenCalled();

    act(() => socket.fire('fraud_alert', { transactionId: 't2' }));
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(ANALYTICS_REFRESH_DEBOUNCE_MS + 10); });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('F-01: after a reconnect the analytics are refreshed; an auth rejection stops the loop', async () => {
    vi.useFakeTimers();
    api.get.mockResolvedValue({ data: { success: true, data: {} } });
    const store = adminStore();
    renderHook(() => useSocket(), { wrapper: wrap(store) });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    socket.fire('connect');
    await act(async () => { await vi.advanceTimersByTimeAsync(ANALYTICS_REFRESH_DEBOUNCE_MS + 10); });
    expect(api.get).not.toHaveBeenCalled();
    socket.fire('connect'); // reconnect
    await act(async () => { await vi.advanceTimersByTimeAsync(ANALYTICS_REFRESH_DEBOUNCE_MS + 10); });
    expect(api.get).toHaveBeenCalledWith('/admin-api/analytics');

    api.get.mockClear();
    await act(async () => { socket.fire('connect_error', new Error('UNAUTHENTICATED')); });
    expect(socket.disconnect).toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledWith('/auth/check-auth');
  });
});
