// RegisterPage: validation parity with the server (N-16), analyst invite code (L-11), payload
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import RegisterPage from '../auth/RegisterPage.jsx';
import { renderApp, ok, fail } from '../../tests/utils.jsx';

vi.mock('../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../api/axios.js';

const AUTH_SETTLED = { user: { id: null, name: null, email: null, role: null }, isAuthenticated: false, loading: false, error: null, checkAuthRequestId: null };

function renderRegister() {
  return renderApp(
    <Routes>
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/login" element={<p>login screen</p>} />
    </Routes>,
    { route: '/register', auth: AUTH_SETTLED },
  );
}
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const fillValid = (over = {}) => {
  type(/full name/i, over.name ?? 'Asha Rao');
  type(/^email/i, over.email ?? 'asha@example.com');
  type(/^password/i, over.password ?? 'Password@123');
  type(/confirm password/i, over.confirm ?? over.password ?? 'Password@123');
};
const submit = () => fireEvent.click(screen.getByRole('button', { name: /create account/i }));

beforeEach(() => vi.clearAllMocks());

describe('RegisterPage validation', () => {
  it('requires every field', async () => {
    renderRegister();
    submit();
    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('Email is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(screen.getByText('Please confirm your password')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('N-16: a name that is too short AFTER trimming is rejected ("a " used to pass)', async () => {
    renderRegister();
    fillValid({ name: 'a ' });
    submit();
    expect(await screen.findByText('Name must be at least 2 characters')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each(['a@b.c', 'a@b..c', 'a..b@example.com', '.a@example.com', 'a@-b.com', 'plain', 'a b@example.com'])(
    'N-16: rejects the invalid email %s',
    async (email) => {
      renderRegister();
      fillValid({ email });
      submit();
      expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalled();
    },
  );

  it.each(['asha@example.com', 'first.last+tag@sub.example.co.in', "o'brien@example.org"])('accepts %s', async (email) => {
    api.post.mockResolvedValueOnce(ok({ id: 'n1' }));
    renderRegister();
    fillValid({ email });
    submit();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
  });

  it('password must be 8–72 characters', async () => {
    renderRegister();
    fillValid({ password: 'short' });
    submit();
    expect(await screen.findByText('Password must be at least 8 characters')).toBeInTheDocument();
    fillValid({ password: 'x'.repeat(73) });
    submit();
    expect(await screen.findByText('Password cannot exceed 72 characters')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('N-16: the confirmation is re-validated when the password changes after a failed submit', async () => {
    renderRegister();
    fillValid({ password: 'Password@123', confirm: 'Password@123' });
    type(/^password/i, 'Different@999'); // now they differ
    submit();
    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    type(/^password/i, 'Password@123'); // fix the PASSWORD, not the confirmation
    await waitFor(() => expect(screen.queryByText('Passwords do not match')).toBeNull());
  });

  it('N-16: the role select takes its classes from the field (so its error style is not overridden)', () => {
    renderRegister();
    expect(screen.getByLabelText(/i am a/i).className).toBe(screen.getByLabelText(/full name/i).className);
  });
});

describe('RegisterPage payload and server answers', () => {
  it('CUSTOMER: sends trimmed name/email, the role and NO inviteCode, then goes to /login', async () => {
    api.post.mockResolvedValueOnce(ok({ id: 'n1', role: 'CUSTOMER' }));
    renderRegister();
    expect(screen.queryByLabelText(/analyst invite code/i)).toBeNull();
    fillValid({ name: '  Asha Rao  ', email: ' asha@example.com ' });
    submit();
    expect(await screen.findByText('login screen')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/auth/register', {
      name: 'Asha Rao', email: 'asha@example.com', password: 'Password@123', role: 'CUSTOMER',
    });
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('inviteCode');
  });

  it('L-11: ANALYST shows the invite-code field, requires it and sends it as inviteCode', async () => {
    api.post.mockResolvedValueOnce(ok({ id: 'n2', role: 'ANALYST' }));
    renderRegister();
    fireEvent.change(screen.getByLabelText(/i am a/i), { target: { value: 'ANALYST' } });
    expect(await screen.findByLabelText('Analyst invite code')).toBeInTheDocument();
    fillValid();
    submit();
    expect(await screen.findByText('The invite code is required for analyst accounts')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    type('Analyst invite code', '  test-invite-code ');
    submit();
    expect(await screen.findByText('login screen')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/auth/register', {
      name: 'Asha Rao', email: 'asha@example.com', password: 'Password@123', role: 'ANALYST', inviteCode: 'test-invite-code',
    });
  });

  it('switching back to CUSTOMER drops the invite code from the request', async () => {
    api.post.mockResolvedValueOnce(ok({ id: 'n1' }));
    renderRegister();
    fireEvent.change(screen.getByLabelText(/i am a/i), { target: { value: 'ANALYST' } });
    type('Analyst invite code', 'test-invite-code');
    fireEvent.change(screen.getByLabelText(/i am a/i), { target: { value: 'CUSTOMER' } });
    fillValid();
    submit();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1]).toMatchObject({ role: 'CUSTOMER' });
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('inviteCode');
  });

  it.each([
    ['Analyst registration is disabled.'],
    ['Invalid invite code.'],
  ])('shows the backend 403 message: %s', async (message) => {
    api.post.mockRejectedValueOnce(fail(403, message));
    renderRegister();
    fireEvent.change(screen.getByLabelText(/i am a/i), { target: { value: 'ANALYST' } });
    fillValid();
    type('Analyst invite code', 'whatever');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('shows the 422 message the validators now return', async () => {
    api.post.mockRejectedValueOnce(fail(422, 'A valid email address is required', { errors: [{ msg: 'A valid email address is required' }] }));
    renderRegister();
    fillValid();
    submit();
    expect(await screen.findByText('A valid email address is required')).toBeInTheDocument();
  });
});
