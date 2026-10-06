// App routing guards with the REAL initial auth state (loading: true, user object with null fields),
// the real root reducer and App's own checkAuthThunk on mount — N-10, AUD-12, N-17.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import App from '../App.jsx';
import { renderApp, ok, page, fail } from '../tests/utils.jsx';

vi.mock('../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('../hooks/useNotifications.js', () => ({ useNotifications: () => {} }));
vi.mock('../hooks/useSocket.js', () => ({ useSocket: () => {} }));
import api from '../api/axios.js';

const CUSTOMER = { id: 'u1', name: 'Asha Rao', email: 'asha@example.com', role: 'CUSTOMER', profileImage: null, trustScore: 70 };
const ANALYST = { id: 'a1', name: 'Ravi Analyst', email: 'ravi@example.com', role: 'ANALYST', profileImage: null, trustScore: 100 };

/** Backend stand-in: check-auth answers with `sessionUser` (or 401), everything else is empty. */
function backend(sessionUser) {
  api.get.mockImplementation(async (url) => {
    if (url === '/auth/check-auth') {
      if (sessionUser) return ok(sessionUser);
      throw fail(401, 'Authentication required.');
    }
    if (url.endsWith('/unread-count')) return ok({ unreadCount: 0 });
    if (url.endsWith('/trust-score')) return ok({ trustScore: 77 });
    return page([]);
  });
}

beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, ''); });
afterEach(() => { window.history.replaceState(null, ''); });

describe('App routing guards (real initial auth state)', () => {
  it('shows a spinner — not the login form — while the first session check is running', async () => {
    api.get.mockImplementation(() => new Promise(() => {})); // check-auth never answers
    const { store } = renderApp(<App />, { route: '/customer' });
    expect(store.getState().auth.loading).toBe(true);        // the real initial state
    expect(await screen.findByRole('status')).toHaveTextContent(/loading/i);
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull();
  });

  it('a signed-out visitor is sent from a protected page to the login form', async () => {
    backend(null);
    renderApp(<App />, { route: '/admin/users' });
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('an authenticated customer reaches /customer after the session check', async () => {
    backend(CUSTOMER);
    renderApp(<App />, { route: '/customer' });
    expect(await screen.findByRole('heading', { name: /welcome back, asha/i })).toBeInTheDocument();
  });

  it('a hard refresh on a deep page keeps the user there (no flash redirect to /login)', async () => {
    backend(CUSTOMER);
    renderApp(<App />, { route: '/customer/transactions' });
    expect(await screen.findByRole('heading', { name: /transaction history/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
  });

  it('an analyst cannot open admin pages', async () => {
    backend(ANALYST);
    renderApp(<App />, { route: '/admin' });
    expect(await screen.findByRole('heading', { name: /access denied/i })).toBeInTheDocument();
    expect(screen.getByText(/ANALYST/)).toBeInTheDocument();
  });

  it('a customer cannot open analyst pages', async () => {
    backend(CUSTOMER);
    renderApp(<App />, { route: '/analyst/cases' });
    expect(await screen.findByRole('heading', { name: /access denied/i })).toBeInTheDocument();
  });

  it('shows the 404 page for unknown paths, with a spinner first while the role is unknown', async () => {
    api.get.mockImplementation(() => new Promise(() => {}));
    renderApp(<App />, { route: '/definitely/not/here' });
    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /not found/i })).toBeNull();
  });

  it('404 once the session check is done', async () => {
    backend(null);
    renderApp(<App />, { route: '/definitely/not/here' });
    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });
});

describe('N-17: return to the page the visitor wanted after signing in', () => {
  const signIn = async (email) => {
    fireEvent.change(await screen.findByLabelText(/email/i), { target: { value: email } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'Password@123' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
  };

  it('deep link → login → back on the deep link when the role may open it', async () => {
    backend(null);
    api.post.mockResolvedValueOnce(ok(ANALYST));
    renderApp(<App />, { route: '/analyst/cases' });
    await signIn('ravi@example.com');
    expect(await screen.findByRole('heading', { name: /fraud cases/i })).toBeInTheDocument();
  });

  it('keeps the query string of the deep link', async () => {
    backend(null);
    api.post.mockResolvedValueOnce(ok(ANALYST));
    renderApp(<App />, { route: '/analyst/device-reputation?deviceId=web-123' });
    await signIn('ravi@example.com');
    expect(await screen.findByRole('heading', { name: /device reputation/i })).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/analyst-api/devices/web-123'));
  });

  it('falls back to the role home when the remembered page belongs to another role', async () => {
    backend(null);
    api.post.mockResolvedValueOnce(ok(CUSTOMER));
    renderApp(<App />, { route: '/analyst/cases' });
    await signIn('asha@example.com');
    expect(await screen.findByRole('heading', { name: /welcome back, asha/i })).toBeInTheDocument();
  });

  it('plain login without a remembered page goes to the role home', async () => {
    backend(null);
    api.post.mockResolvedValueOnce(ok(ANALYST));
    renderApp(<App />, { route: '/login' });
    await signIn('ravi@example.com');
    expect(await screen.findByRole('heading', { name: /hello, ravi/i })).toBeInTheDocument();
  });
});

describe('N-17: "Go back" on the 403 / 404 pages', () => {
  it('opened directly (no history): goes to the role home instead of leaving the app', async () => {
    backend(CUSTOMER);
    renderApp(<App />, { route: '/nowhere' });
    fireEvent.click(await screen.findByRole('button', { name: /go back/i }));
    expect(await screen.findByRole('heading', { name: /welcome back, asha/i })).toBeInTheDocument();
  });

  it('signed out: goes to the login page', async () => {
    backend(null);
    renderApp(<App />, { route: '/nowhere' });
    fireEvent.click(await screen.findByRole('button', { name: /go back/i }));
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });
});
