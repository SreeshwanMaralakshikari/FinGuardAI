// Fix round 1 (frontend): errors.js (F-03), notification cap (F-07), ScoreBar (F-06), labels (F-10),
// idempotency key (C-01), LoginPage notice (E-01), AppShell skip link / focus (F-05), Modal / Spinner a11y,
// TableSkeleton, charts' headings (E-19), table action headers (E-19), StatusPage (H-10), dead exports (H-02).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Route, Routes, Link } from 'react-router-dom';
import { getErrorMessage, UNREACHABLE_MESSAGE, rejectedMessage } from '../api/errors.js';
import notificationReducer, { addLiveNotification, setPanelOpen, MAX_LIVE_NOTIFICATIONS } from '../store/slices/notificationSlice.js';
import ScoreBar from '../components/common/ScoreBar.jsx';
import Modal from '../components/common/Modal.jsx';
import Spinner from '../components/common/Spinner.jsx';
import TableSkeleton from '../components/common/TableSkeleton.jsx';
import PageHeader from '../components/common/PageHeader.jsx';
import BarCard from '../components/charts/BarCard.jsx';
import TrendChart from '../components/charts/TrendChart.jsx';
import AppShell from '../components/shared/AppShell.jsx';
import LoginPage from '../pages/auth/LoginPage.jsx';
import NotFound from '../pages/shared/NotFound.jsx';
import Unauthorized from '../pages/shared/Unauthorized.jsx';
import * as common from '../utils/common.js';
import * as constants from '../utils/constants.js';
import * as forms from '../utils/forms.js';
import { newIdempotencyKey } from '../utils/device.js';
import { rememberSessionNotice, peekSessionNotice, clearSessionNotice, DEACTIVATED_NOTICE } from '../api/session.js';
import { requestRouteFocus, consumeRouteFocus } from '../utils/routeFocus.js';
import { renderApp, signedIn, ok } from '../tests/utils.jsx';

vi.mock('../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('socket.io-client', () => ({ io: vi.fn() }));
import api from '../api/axios.js';

beforeEach(() => { vi.clearAllMocks(); clearSessionNotice(); api.get.mockResolvedValue(ok([])); });
afterEach(() => { vi.useRealTimers(); });

describe('F-03: getErrorMessage', () => {
  const networkErr = (extra) => Object.assign(new Error('Network Error'), { isAxiosError: true, ...extra });

  it('an error without any response (timeout, offline, CORS) says the server cannot be reached', () => {
    expect(UNREACHABLE_MESSAGE).toBe('Cannot reach the server - check your connection and try again.');
    expect(getErrorMessage(networkErr({ code: 'ERR_NETWORK' }), 'Login failed')).toBe(UNREACHABLE_MESSAGE);
    expect(getErrorMessage(networkErr({ code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded' }), 'x')).toBe(UNREACHABLE_MESSAGE);
    expect(getErrorMessage(new Error('Network Error'), 'x')).toBe(UNREACHABLE_MESSAGE);
    expect(getErrorMessage({ request: {}, message: 'x' }, 'x')).toBe(UNREACHABLE_MESSAGE);
  });

  it('server answers keep their own message (errors[0].msg, then message, then the fallback)', () => {
    expect(getErrorMessage({ response: { data: { errors: [{ msg: 'bad' }], message: 'Validation failed.' } } }, 'f')).toBe('bad');
    expect(getErrorMessage({ response: { data: { message: 'Nope' } } }, 'f')).toBe('Nope');
    expect(getErrorMessage({ response: { status: 502, data: '<html>' } }, 'Fallback')).toBe('Fallback');
  });

  it('cancellations and non-network exceptions keep the caller\'s fallback', () => {
    expect(getErrorMessage(networkErr({ code: 'ERR_CANCELED', message: 'canceled' }), 'Fallback')).toBe('Fallback');
    expect(getErrorMessage(new TypeError('x is undefined'), 'Fallback')).toBe('Fallback');
    expect(getErrorMessage(undefined, 'Fallback')).toBe('Fallback');
    expect(getErrorMessage(null, 'Fallback')).toBe('Fallback');
  });

  it('rejectedMessage prefers the payload, then the thrown message, then the fallback', () => {
    expect(rejectedMessage({ payload: 'p', error: { message: 'e' } }, 'f')).toBe('p');
    expect(rejectedMessage({ error: { message: 'e' } }, 'f')).toBe('e');
    expect(rejectedMessage({}, 'f')).toBe('f');
  });
});

describe('F-07 / F-01: notification slice', () => {
  it('addLiveNotification keeps at most 50 items (newest first) but still counts every unread push', () => {
    let state = notificationReducer(undefined, { type: '@@INIT' });
    for (let i = 1; i <= MAX_LIVE_NOTIFICATIONS + 10; i += 1) state = notificationReducer(state, addLiveNotification({ id: `n${i}`, message: `m${i}` }));
    expect(MAX_LIVE_NOTIFICATIONS).toBe(50);
    expect(state.notifications).toHaveLength(50);
    expect(state.notifications[0]._id).toBe('n60');
    expect(state.notifications.at(-1)._id).toBe('n11');
    expect(state.unreadCount).toBe(60);
  });

  it('setPanelOpen records whether the bell panel is open', () => {
    let state = notificationReducer(undefined, { type: '@@INIT' });
    expect(state.panelOpen).toBe(false);
    state = notificationReducer(state, setPanelOpen(true));
    expect(state.panelOpen).toBe(true);
    state = notificationReducer(state, setPanelOpen(false));
    expect(state.panelOpen).toBe(false);
  });
});

describe('F-06: ScoreBar', () => {
  const fillOf = (container) => container.querySelector('[role="meter"] > div');

  it('colours the bar by the risk LEVEL the server computed (live thresholds), not by fixed 25/50/75 bands', () => {
    // score 45 would be MEDIUM (yellow) by the defaults; with admin thresholds it is HIGH
    const { container } = render(<ScoreBar value={45} riskLevel="HIGH" label="Fraud score" />);
    expect(fillOf(container)).toHaveClass('bg-orange-500');
    expect(fillOf(container)).not.toHaveClass('bg-yellow-500');
  });

  it.each([['LOW', 'bg-emerald-500'], ['MEDIUM', 'bg-yellow-500'], ['HIGH', 'bg-orange-500'], ['CRITICAL', 'bg-red-600']])('%s → %s', (level, cls) => {
    expect(fillOf(render(<ScoreBar value={10} riskLevel={level} />).container)).toHaveClass(cls);
  });

  it('without a level (reputation, trust) the default bands apply, flipped when invert is set', () => {
    expect(fillOf(render(<ScoreBar value={80} />).container)).toHaveClass('bg-red-600');
    expect(fillOf(render(<ScoreBar value={80} invert />).container)).toHaveClass('bg-emerald-500');
  });

  it('an unknown level falls back to the bands; the value is clamped to 0–100', () => {
    const { container } = render(<ScoreBar value={150} riskLevel="WHATEVER" />);
    expect(fillOf(container)).toHaveClass('bg-red-600');
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
  });
});

describe('F-10: unknown locations', () => {
  it('cityLabel / formatLocation', () => {
    expect(common.UNKNOWN_LOCATION).toBe('Unknown location');
    expect(common.cityLabel('Mumbai')).toBe('Mumbai');
    expect(common.cityLabel('  ')).toBe('Unknown location');
    expect(common.cityLabel(undefined)).toBe('Unknown location');
    expect(common.cityLabel('unknown')).toBe('Unknown location');
    expect(common.cityLabel('UNKNOWN')).toBe('Unknown location');
    expect(common.formatLocation({ city: 'Pune', country: 'IN' })).toBe('Pune, IN');
    expect(common.formatLocation({ city: 'Unknown', country: 'IN' })).toBe('Unknown location, IN');
    expect(common.formatLocation({ city: 'Pune' })).toBe('Pune');
    expect(common.formatLocation(undefined)).toBe('Unknown location');
  });
});

describe('C-01: newIdempotencyKey', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('uses crypto.randomUUID when it exists and returns different keys', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(UUID);
    expect(newIdempotencyKey()).not.toBe(a);
  });

  it('falls back to getRandomValues (insecure context) and then to Math.random, still producing a v4 UUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: (arr) => { arr.fill(0xab); return arr; } });
    expect(newIdempotencyKey()).toMatch(UUID);
    vi.stubGlobal('crypto', undefined);
    expect(newIdempotencyKey()).toMatch(UUID);
    vi.unstubAllGlobals();
  });
});

describe('E-01: LoginPage shows why the user was signed out', () => {
  const renderLogin = () => renderApp(<Routes><Route path="/login" element={<LoginPage />} /></Routes>, { route: '/login', auth: { ...signedIn(), isAuthenticated: false, user: { id: null, name: null, email: null, role: null, profileImage: null, trustScore: null } } });

  it('displays the deactivation message once and clears it from storage', async () => {
    rememberSessionNotice(DEACTIVATED_NOTICE);
    renderLogin();
    expect(screen.getByRole('status')).toHaveTextContent('Account has been deactivated. Contact support.');
    await waitFor(() => expect(peekSessionNotice()).toBe(''));
  });

  it('shows nothing when there is no notice', () => {
    renderLogin();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('the notice disappears when the user submits the form', async () => {
    rememberSessionNotice(DEACTIVATED_NOTICE);
    api.post.mockRejectedValue({ response: { status: 401, data: { message: 'Invalid email or password.' } } });
    renderLogin();
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText('Invalid email or password.')).toBeInTheDocument();
    expect(screen.queryByText(/deactivated/i)).toBeNull();
  });

  it('works when sessionStorage throws (private mode): no crash, no notice', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => renderLogin()).not.toThrow();
    expect(screen.queryByRole('status')).toBeNull();
    spy.mockRestore();
  });
});

describe('F-05: AppShell', () => {
  const renderShell = (route = '/a') => renderApp(
    <Routes>
      <Route element={<AppShell navItems={[]} />}>
        <Route path="/a" element={<><PageHeader title="Page A" /><Link to="/b">go b</Link></>} />
        <Route path="/b" element={<PageHeader title="Page B" />} />
      </Route>
    </Routes>,
    { route, auth: signedIn({ role: 'CUSTOMER' }) },
  );

  it('has a "Skip to main content" link that moves focus to <main>', () => {
    renderShell();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(skip).toHaveClass('sr-only'); // visible only on focus
    fireEvent.click(skip);
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(main).toHaveFocus();
  });

  it('after a client-side navigation the new page\'s h1 gets focus', async () => {
    renderShell();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Page A' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('link', { name: 'go b' }));
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Page B' });
    await waitFor(() => expect(h1).toHaveFocus());
    expect(h1).toHaveAttribute('tabindex', '-1');
  });
});

describe('F-05: routeFocus request', () => {
  it('is consumed once and expires', () => {
    vi.useFakeTimers();
    expect(consumeRouteFocus()).toBe(false);
    requestRouteFocus();
    expect(consumeRouteFocus()).toBe(true);
    expect(consumeRouteFocus()).toBe(false);
    requestRouteFocus();
    vi.advanceTimersByTime(6000);
    expect(consumeRouteFocus()).toBe(false);
  });

  it('a PageHeader mounted without a navigation request does not steal focus', () => {
    render(<PageHeader title="Quiet" />);
    expect(screen.getByRole('heading', { name: 'Quiet' })).not.toHaveFocus();
  });
});

describe('F-05: Modal / Spinner / TableSkeleton', () => {
  it('the dialog is named by its visible heading (aria-labelledby), not a duplicate aria-label', () => {
    render(<Modal open title="Resolve case" onClose={() => {}}><p>body</p></Modal>);
    const dialog = screen.getByRole('dialog', { name: 'Resolve case' });
    expect(dialog).not.toHaveAttribute('aria-label');
    const id = dialog.getAttribute('aria-labelledby');
    expect(document.getElementById(id)).toHaveTextContent('Resolve case');
    expect(document.getElementById(id).tagName).toBe('H2');
  });

  it('two open dialogs never share a label id', () => {
    render(<><Modal open title="One" onClose={() => {}}>x</Modal><Modal open title="Two" onClose={() => {}}>y</Modal></>);
    const ids = screen.getAllByRole('dialog').map((d) => d.getAttribute('aria-labelledby'));
    expect(new Set(ids).size).toBe(2);
  });

  it('spinners stop animating for users who prefer reduced motion', () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector('.animate-spin')).toHaveClass('motion-reduce:animate-none');
    expect(common.WAKE_GATE.spinner).toContain('motion-reduce:animate-none');
  });

  it('TableSkeleton: one polite status, decorative rows, pulse respects reduced motion', () => {
    const { container } = render(<TableSkeleton rows={3} cols={4} label="Loading users…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading users…');
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(12);
    expect(container.querySelector('.animate-pulse')).toHaveClass('motion-reduce:animate-none');
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('E-19: heading levels and table headers', () => {
  it('chart cards use <h2> directly under the page <h1>', () => {
    render(<>
      <BarCard title="Risk distribution" data={[{ level: 'LOW', count: 2 }]} xKey="level" />
      <TrendChart data={[{ date: '2026-10-01', count: 1, totalAmount: 5, avgFraudScore: 60, movingAvg: 1 }]} />
    </>);
    expect(screen.getByRole('heading', { level: 2, name: 'Risk distribution' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'High-risk transactions per day' })).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });
});

describe('H-10: StatusPage (NotFound / Unauthorized)', () => {
  it('404 for a signed-out visitor offers Sign in', () => {
    renderApp(<NotFound />, { auth: { ...signedIn(), isAuthenticated: false } });
    expect(screen.getByText('404')).toHaveClass('text-primary-600');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('403 names the role and links to its dashboard', () => {
    renderApp(<Unauthorized />, { auth: signedIn({ role: 'ANALYST' }) });
    expect(screen.getByText('403')).toHaveClass('text-red-600');
    expect(screen.getByText('ANALYST')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'My dashboard' })).toHaveAttribute('href', '/analyst');
  });

  it('403 without a role asks the visitor to sign in; nothing is drawn while the session check runs', () => {
    const { container, unmount } = renderApp(<Unauthorized />, { auth: { ...signedIn(), isAuthenticated: false, user: { role: null } } });
    expect(screen.getByText('You need to sign in to open this page.')).toBeInTheDocument();
    unmount();
    renderApp(<NotFound />, { auth: { ...signedIn(), loading: true } });
    expect(screen.queryByText('404')).toBeNull();
    expect(container).toBeDefined();
  });
});

describe('H-02: dead code is gone', () => {
  it('removed exports are no longer exported', () => {
    expect(common.truncate).toBeUndefined();
    expect(common.BADGE).toBeUndefined();
    expect(constants.TX_STATUSES).toBeUndefined();
    expect(constants.NOTIFICATION_TYPES).toBeUndefined();
    expect(forms.NAME_MIN).toBeUndefined();
    expect(forms.NAME_MAX).toBeUndefined();
    expect(forms.PASSWORD_MAX_BYTES).toBeUndefined();
  });

  it('the validators that used them still work', () => {
    expect(forms.validateName('A')).toBe('Name must be at least 2 characters');
    expect(forms.validateName('x'.repeat(101))).toBe('Name cannot exceed 100 characters');
    expect(forms.validatePasswordBytes('x'.repeat(73))).toBe('Password cannot exceed 72 characters');
    expect(forms.validatePasswordBytes('é'.repeat(40))).toMatch(/Password is too long/);
    expect(common.badgeClass({ bg: 'b', text: 't', border: 'o' })).toMatch(/rounded-full.*b t o/);
  });
});
