// src/pages/__tests__/ThresholdConfig.test.jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { configureStore } from '@reduxjs/toolkit';
import ThresholdConfig from '../admin/ThresholdConfig.jsx';
import authReducer from '../../store/slices/authSlice.js';
import { getNestedError } from '../../utils/forms.js';

vi.mock('../../api/axios.js', () => ({
  default: { get: vi.fn(), patch: vi.fn() },
}));

import api from '../../api/axios.js';

const MOCK_THRESHOLDS = {
  amountThreshold: 50000,
  velocityLimit: { maxPerHour: 5, maxPerDay: 20 },
  scoreThresholds: { mediumMin: 25, highMin: 50, criticalMin: 75 },
  locationDeviationKm: 500,
  newDeviceWeight: 20,
  highRiskMerchants: ['CASINO', 'GAMBLING', 'CRYPTO_EXCHANGE'],
};

function renderThresholdConfig() {
  api.get.mockResolvedValue({
    data: { success: true, data: MOCK_THRESHOLDS }, // Phase 4 GET /thresholds returns the config document in data
  });

  const store = configureStore({
    reducer: { auth: authReducer },
    preloadedState: {
      auth: { user: { role: 'ADMIN' }, isAuthenticated: true, loading: false, error: null },
    },
  });

  return render(
    <Provider store={store}>
      <MemoryRouter>
        <ThresholdConfig />
      </MemoryRouter>
    </Provider>
  );
}

beforeEach(() => { vi.clearAllMocks(); });

describe('ThresholdConfig page', () => {
  it('renders the threshold form fields', async () => {
    renderThresholdConfig();
    await waitFor(() => {
      expect(screen.getByDisplayValue('50000')).toBeInTheDocument();
    });
  });

  it('renders nested fields (velocityLimit.maxPerHour)', async () => {
    renderThresholdConfig();
    await waitFor(() => {
      expect(screen.getByDisplayValue('5')).toBeInTheDocument();
    });
  });
});

describe('C-P7-06 — getNestedError traverses nested RHF error objects', () => {
  it('shows validation error for nested scoreThresholds field', async () => {
    renderThresholdConfig();

    await waitFor(() => {
      expect(screen.getByDisplayValue('25')).toBeInTheDocument();
    });

    // Enter invalid value: mediumMin > highMin
    const mediumMinInput = screen.getByDisplayValue('25');
    fireEvent.change(mediumMinInput, { target: { value: '80' } });

    const submitButton = screen.getByRole('button', { name: /save|update|submit/i });
    fireEvent.click(submitButton);

    // getNestedError resolves 'scoreThresholds.mediumMin' and the message renders by the field
    expect(await screen.findByText('Medium minimum must be less than the high minimum')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('getNestedError returns correct value for nested path', () => {
    const errors = {
      scoreThresholds: {
        mediumMin: { message: 'Must be less than highMin' },
      },
    };

    expect(getNestedError(errors, 'scoreThresholds.mediumMin')).toEqual({
      message: 'Must be less than highMin',
    });
    expect(getNestedError(errors, 'scoreThresholds.nonExistent')).toBeUndefined();
    expect(getNestedError(errors, 'amountThreshold')).toBeUndefined();
    expect(getNestedError({}, 'a.b.c')).toBeUndefined();
  });
});
