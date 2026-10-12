// ServerWakeGate: warm start renders the app without a flash, cold start shows the waking screen, failure offers Retry
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import ServerWakeGate from '../ServerWakeGate.jsx';

vi.mock('../../../api/serverHealth.js', () => ({ pingServer: vi.fn(), waitForServer: vi.fn() }));
import { pingServer, waitForServer } from '../../../api/serverHealth.js';

const renderGate = () => render(<ServerWakeGate><p>the app</p></ServerWakeGate>);
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ServerWakeGate', () => {
  it('a warm server: renders the app after the probe and never draws a spinner', async () => {
    pingServer.mockResolvedValue(true);
    const { container } = renderGate();
    expect(container).toBeEmptyDOMElement(); // nothing during the first 400 ms
    await flush();
    expect(screen.getByText('the app')).toBeInTheDocument();
    expect(waitForServer).not.toHaveBeenCalled();
  });

  it('shows a neutral "Connecting" loader only after 400 ms of waiting', async () => {
    pingServer.mockReturnValue(new Promise(() => {})); // probe never answers
    renderGate();
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to FinGuardAI');
    expect(screen.queryByText('the app')).toBeNull();
  });

  it('a cold server: "Starting the secure server" with an elapsed-seconds counter, then the app', async () => {
    pingServer.mockResolvedValue(false);
    let wake;
    waitForServer.mockReturnValue(new Promise((resolve) => { wake = resolve; }));
    renderGate();
    await flush();
    expect(screen.getByRole('heading', { name: /starting the secure server/i })).toBeInTheDocument();
    expect(screen.getByText('0s elapsed')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('3s elapsed')).toBeInTheDocument();
    expect(waitForServer).toHaveBeenCalledWith({ maxWaitMs: 90_000 });

    await act(async () => { wake(true); });
    expect(screen.getByText('the app')).toBeInTheDocument();
  });

  it('a server that stays down: error message, and "Try again" probes once more', async () => {
    pingServer.mockResolvedValue(false);
    waitForServer.mockResolvedValue(false);
    renderGate();
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(/did not respond in time/i);
    expect(screen.getByRole('heading', { name: /can’t reach the finguardai server/i })).toBeInTheDocument();
    expect(screen.queryByText('the app')).toBeNull();

    pingServer.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await flush();
    expect(screen.getByText('the app')).toBeInTheDocument();
    expect(pingServer).toHaveBeenCalledTimes(2);
  });

  it('a cold server that wakes up during the wait → ready (no failure screen)', async () => {
    pingServer.mockResolvedValue(false);
    waitForServer.mockResolvedValue(true);
    renderGate();
    await flush();
    expect(screen.getByText('the app')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
