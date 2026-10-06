// SimulationPanel: Stop is always available, Start is blocked while running (N-12)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import SimulationPanel from '../admin/SimulationPanel.jsx';
import { renderApp, ok, fail, signedIn } from '../../tests/utils.jsx';

vi.mock('../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../api/axios.js';

const simState = (isRunning) => ({ simulation: { isRunning, events: [], stats: {} } });
const renderPanel = (isRunning = false) => renderApp(<SimulationPanel />, { auth: signedIn({ role: 'ADMIN' }), preloadedState: simState(isRunning) });

beforeEach(() => { vi.clearAllMocks(); });

describe('SimulationPanel', () => {
  it('idle: Start and Stop are both enabled (the running flag is lost on reload / lives in another tab)', () => {
    renderPanel(false);
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('running: Start is disabled, Stop is enabled', () => {
    renderPanel(true);
    expect(screen.getByText('Simulation running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('Stop sends the stop request even when the page thinks nothing is running', async () => {
    api.post.mockResolvedValueOnce(ok(null));
    const { store } = renderPanel(false);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin-api/simulation/stop'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
    expect(store.getState().simulation.isRunning).toBe(false);
  });

  it('Stop shows the server message on failure', async () => {
    api.post.mockRejectedValueOnce(fail(400, 'No simulation is running.'));
    renderPanel(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No simulation is running.');
  });

  it('Start sends an empty body when the count is blank, the number otherwise, then locks Start', async () => {
    api.post.mockResolvedValue(ok(null));
    const { store } = renderPanel(false);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin-api/simulation/start', {}));
    await waitFor(() => expect(store.getState().simulation.isRunning).toBe(true));
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(store.getState().simulation.isRunning).toBe(false));
    fireEvent.change(screen.getByLabelText(/transaction count/i), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/admin-api/simulation/start', { transactionCount: 25 }));
  });

  it('rejects a count outside 1–100 without calling the API', async () => {
    renderPanel(false);
    fireEvent.change(screen.getByLabelText(/transaction count/i), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Enter a whole number from 1 to 100')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
