// src/pages/__tests__/LoginPage.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { configureStore } from '@reduxjs/toolkit';
import LoginPage from '../auth/LoginPage.jsx'; // C-P8-32: file lives at src/pages/auth/LoginPage.jsx
import authReducer from '../../store/slices/authSlice.js';

vi.mock('../../api/axios.js', () => ({
  default: { post: vi.fn() },
}));

import api from '../../api/axios.js';

function renderLoginPage() {
  const store = configureStore({ reducer: { auth: authReducer } });
  return render(
    <Provider store={store}>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </Provider>
  );
}

beforeEach(() => { vi.clearAllMocks(); });

describe('LoginPage', () => {
  it('renders email and password inputs', () => {
    renderLoginPage();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('renders submit button', () => {
    renderLoginPage();
    expect(screen.getByRole('button', { name: /login|sign in/i })).toBeInTheDocument();
  });

  it('shows validation error when submitted empty', async () => {
    renderLoginPage();
    fireEvent.click(screen.getByRole('button', { name: /login|sign in/i }));

    expect(await screen.findByText('Email is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('calls loginThunk with form values on submit', async () => {
    api.post.mockResolvedValueOnce({
      data: { success: true, data: { id: 'u1', email: 'test@test.com', role: 'CUSTOMER' } }, // Phase 4 flat user
    });

    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'test@test.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'Password@123' },
    });

    fireEvent.click(screen.getByRole('button', { name: /login|sign in/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        expect.stringContaining('/auth/login'),
        expect.objectContaining({ email: 'test@test.com' })
      );
    });
  });

  it('displays error message on login failure', async () => {
    api.post.mockRejectedValueOnce({
      response: { data: { message: 'Invalid credentials' } },
    });

    renderLoginPage();

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'bad@test.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'wrong' },
    });

    fireEvent.click(screen.getByRole('button', { name: /login|sign in/i }));

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
  });
});
