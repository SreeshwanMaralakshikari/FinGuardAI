// UserManagement: load error + Retry (N-02), toggle payload, locked rows, dismissible confirm (N-07)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import UserManagement from '../admin/UserManagement.jsx';
import { renderApp, ok, page, fail, signedIn } from '../../tests/utils.jsx';

vi.mock('../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../api/axios.js';

const user = (id, over = {}) => ({
  _id: id, name: `User ${id}`, email: `${id}@example.com`, role: 'CUSTOMER', trustScore: 80, isActive: true,
  createdAt: '2026-09-01T00:00:00Z', lastLogin: '2026-10-01T00:00:00Z', ...over,
});
const USERS = [user('c1'), user('c2', { isActive: false }), user('adm', { role: 'ADMIN', name: 'Boss' }), user('me', { role: 'ADMIN', name: 'Me Admin' })];
const renderPage = () => renderApp(<UserManagement />, { auth: signedIn({ id: 'me', role: 'ADMIN', name: 'Me Admin' }) });
const rowOf = (name) => screen.getByText(name).closest('tr');

beforeEach(() => { vi.clearAllMocks(); });

describe('UserManagement', () => {
  it('lists users with filters as params', async () => {
    api.get.mockResolvedValue(page(USERS, 4, 1, 50));
    renderPage();
    expect(await screen.findByText('User c1')).toBeInTheDocument();
    expect(api.get).toHaveBeenLastCalledWith('/admin-api/users', { params: { page: 1, limit: 50 } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'ANALYST' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'false' } });
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith('/admin-api/users', { params: { page: 1, limit: 50, role: 'ANALYST', isActive: 'false' } }));
  });

  it('N-02: a failed load shows the error + Retry and NOT the "No users found" empty state', async () => {
    api.get.mockRejectedValueOnce(fail(500, 'Users unavailable'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Users unavailable');
    expect(screen.queryByText('No users found')).toBeNull();
    api.get.mockResolvedValueOnce(page(USERS, 4, 1, 50));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('User c1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an empty result shows the empty state without an error', async () => {
    api.get.mockResolvedValue(page([], 0, 1, 50));
    renderPage();
    expect(await screen.findByText('No users found')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ADMIN rows and your own row cannot be toggled', async () => {
    api.get.mockResolvedValue(page(USERS, 4, 1, 50));
    renderPage();
    await screen.findByText('User c1');
    expect(within(rowOf('Boss')).getByRole('button', { name: /^Deactivate/ })).toBeDisabled();
    expect(within(rowOf('Me Admin')).getByRole('button', { name: /^Deactivate/ })).toBeDisabled();
    expect(within(rowOf('User c1')).getByRole('button', { name: /^Deactivate/ })).toBeEnabled();
    expect(within(rowOf('User c2')).getByRole('button', { name: /^Activate/ })).toBeEnabled();
  });

  it('deactivate: confirm dialog → PATCH { isActive: false } → list reloads', async () => {
    api.get.mockResolvedValue(page(USERS, 4, 1, 50));
    api.patch.mockResolvedValueOnce(ok({}));
    renderPage();
    await screen.findByText('User c1');
    fireEvent.click(within(rowOf('User c1')).getByRole('button', { name: /^Deactivate/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate user' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin-api/users/c1/status', { isActive: false }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.get).toHaveBeenCalledTimes(2); // initial + reload
  });

  it('activate sends { isActive: true }', async () => {
    api.get.mockResolvedValue(page(USERS, 4, 1, 50));
    api.patch.mockResolvedValueOnce(ok({}));
    renderPage();
    await screen.findByText('User c2');
    fireEvent.click(within(rowOf('User c2')).getByRole('button', { name: /^Activate/ }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Activate user' })).getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin-api/users/c2/status', { isActive: true }));
  });

  it('a failed toggle keeps the dialog open with the message inside it', async () => {
    api.get.mockResolvedValue(page(USERS, 4, 1, 50));
    api.patch.mockRejectedValueOnce(fail(403, 'Admin accounts cannot be changed.'));
    renderPage();
    await screen.findByText('User c1');
    fireEvent.click(within(rowOf('User c1')).getByRole('button', { name: /^Deactivate/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    expect(await within(dialog).findByText('Admin accounts cannot be changed.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('N-07: the confirm dialog cannot be dismissed while the request runs', async () => {
    api.get.mockResolvedValue(page(USERS, 4, 1, 50));
    let finish;
    api.patch.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    renderPage();
    await screen.findByText('User c1');
    fireEvent.click(within(rowOf('User c1')).getByRole('button', { name: /^Deactivate/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Saving…' })).toBeDisabled());
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => { finish(ok({})); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
