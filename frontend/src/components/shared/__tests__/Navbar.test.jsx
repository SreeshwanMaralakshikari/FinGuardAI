// Navbar: sign-out label (N-15) and an honest toast when the logout request fails (F-04)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import Navbar, { LOGOUT_FAILED_MESSAGE } from '../Navbar.jsx';
import { renderApp, ok, fail, signedIn } from '../../../tests/utils.jsx';

vi.mock('../../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
import api from '../../../api/axios.js';
import toast from 'react-hot-toast';

const renderBar = (role = 'ADMIN') => renderApp(
  <Routes>
    <Route path="/" element={<Navbar onMenuClick={() => {}} />} />
    <Route path="/login" element={<p>login screen</p>} />
  </Routes>,
  { route: '/', auth: signedIn({ role, name: 'Asha Rao' }) },
);

beforeEach(() => { vi.clearAllMocks(); });

describe('Navbar', () => {
  it('N-15: the sign-out button has an accessible name even when its text is hidden (small screens)', () => {
    renderBar();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('successful logout: "Signed out" toast, state wiped, redirected to /login', async () => {
    api.post.mockResolvedValueOnce(ok(null));
    const { store } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('login screen')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/auth/logout');
    expect(toast.success).toHaveBeenCalledWith('Signed out');
    expect(toast.error).not.toHaveBeenCalled();
    expect(store.getState().auth.isAuthenticated).toBe(false);
  });

  it('F-04: when the logout request fails the user is still signed out locally but told the truth', async () => {
    api.post.mockRejectedValueOnce(fail(503, 'Service unavailable'));
    const { store } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('login screen')).toBeInTheDocument();
    expect(store.getState().auth).toMatchObject({ isAuthenticated: false });
    expect(toast.success).not.toHaveBeenCalledWith('Signed out'); // no false "clean" sign-out
    expect(toast.error).toHaveBeenCalledWith(LOGOUT_FAILED_MESSAGE, expect.any(Object));
    expect(LOGOUT_FAILED_MESSAGE).toBe('Signed out on this device. The server could not be reached, so your session may stay active until it expires.');
  });

  it('ADMIN has no notification bell; customers do', () => {
    api.get.mockResolvedValue(ok([]));
    const { unmount } = renderBar('ADMIN');
    expect(screen.queryByRole('button', { name: /notifications/i })).toBeNull();
    unmount();
    renderBar('CUSTOMER');
    expect(screen.getByRole('button', { name: /notifications/i })).toBeInTheDocument();
  });
});
