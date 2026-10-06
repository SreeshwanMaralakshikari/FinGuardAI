// DeviceReputation: one request per search, URL-driven, input follows back / forward (N-05)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { useNavigate } from 'react-router-dom';
import DeviceReputation from '../analyst/DeviceReputation.jsx';
import { renderApp, ok, fail, signedIn } from '../../tests/utils.jsx';

vi.mock('../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../api/axios.js';

const device = (deviceId) => ({
  device: { deviceId, reputationScore: 40, flagCount: 3, fraudTransactionCount: 2, isBlacklisted: false, firstSeenAt: '2026-09-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z', associatedUserIds: [] },
  recentTransactions: [],
});

function Nav() {
  const navigate = useNavigate();
  return (<><button type="button" onClick={() => navigate(-1)}>history back</button><button type="button" onClick={() => navigate(1)}>history forward</button></>);
}
const renderPage = (route = '/analyst/device-reputation') =>
  renderApp(<><Nav /><DeviceReputation /></>, { route, auth: signedIn({ role: 'ANALYST' }) });
const deviceCalls = () => api.get.mock.calls.map(([u]) => u);
const search = (value) => {
  fireEvent.change(screen.getByLabelText('Device ID'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
};

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockImplementation(async (url) => {
    const id = decodeURIComponent(url.split('/').pop());
    if (id === 'ghost') throw fail(404, 'Device not found');
    if (id === 'broken') throw fail(500, 'Lookup exploded');
    return ok(device(id));
  });
});

describe('DeviceReputation', () => {
  it('starts idle and sends no request', () => {
    renderPage();
    expect(screen.getByText('Search for a device')).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('N-05: one search = exactly ONE request (it used to send two)', async () => {
    renderPage();
    search('web-abc');
    expect(await screen.findByRole('heading', { name: 'web-abc' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30)); // give a duplicate request time to show up
    expect(deviceCalls()).toEqual(['/analyst-api/devices/web-abc']);
  });

  it('a deep link (?deviceId=) performs one lookup and fills the input', async () => {
    renderPage('/analyst/device-reputation?deviceId=web-deep');
    expect(await screen.findByRole('heading', { name: 'web-deep' })).toBeInTheDocument();
    expect(screen.getByLabelText('Device ID')).toHaveValue('web-deep');
    await new Promise((r) => setTimeout(r, 30));
    expect(deviceCalls()).toEqual(['/analyst-api/devices/web-deep']);
  });

  it('encodes the id in the URL path', async () => {
    renderPage();
    search('a/b c');
    await waitFor(() => expect(deviceCalls()).toEqual(['/analyst-api/devices/a%2Fb%20c']));
  });

  it('N-05: browser back / forward restores both the input text and the result', async () => {
    renderPage();
    search('web-one');
    await screen.findByRole('heading', { name: 'web-one' });
    search('web-two');
    await screen.findByRole('heading', { name: 'web-two' });

    fireEvent.click(screen.getByRole('button', { name: 'history back' }));
    expect(await screen.findByRole('heading', { name: 'web-one' })).toBeInTheDocument();
    expect(screen.getByLabelText('Device ID')).toHaveValue('web-one');

    fireEvent.click(screen.getByRole('button', { name: 'history back' }));
    expect(await screen.findByText('Search for a device')).toBeInTheDocument();
    expect(screen.getByLabelText('Device ID')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'history forward' }));
    expect(await screen.findByRole('heading', { name: 'web-one' })).toBeInTheDocument();
    expect(screen.getByLabelText('Device ID')).toHaveValue('web-one');
    // one request per navigation to a device, never doubles
    expect(deviceCalls()).toEqual([
      '/analyst-api/devices/web-one', '/analyst-api/devices/web-two',
      '/analyst-api/devices/web-one', '/analyst-api/devices/web-one',
    ]);
  });

  it('searching the same id again refreshes with one more request', async () => {
    renderPage();
    search('web-same');
    await screen.findByRole('heading', { name: 'web-same' });
    search('web-same');
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await screen.findByRole('heading', { name: 'web-same' });
  });

  it('404 is "not found", not an error', async () => {
    renderPage();
    search('ghost');
    expect(await screen.findByText('Device not found')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a real failure shows the error with Retry', async () => {
    renderPage();
    search('broken');
    expect(await screen.findByRole('alert')).toHaveTextContent('Lookup exploded');
    api.get.mockResolvedValueOnce(ok(device('broken')));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'broken' })).toBeInTheDocument();
  });
});
