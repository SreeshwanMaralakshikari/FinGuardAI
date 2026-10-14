// Round 4 UI: theme (R4-01), landing page outside the wake gate (R4-02), scoring replay.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, render, act } from '@testing-library/react';
import { renderApp } from '../tests/utils.jsx';

vi.mock('../api/serverHealth.js', async (orig) => ({ ...(await orig()), waitForServer: vi.fn(), pingServer: vi.fn() }));
vi.mock('../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import { waitForServer, pingServer } from '../api/serverHealth.js';
import Root from '../Root.jsx';
import Landing from '../pages/public/Landing.jsx';
import ScoringReplay from '../components/landing/ScoringReplay.jsx';
import { SAMPLES } from '../components/landing/samples.js';
import ThemeToggle from '../components/common/ThemeToggle.jsx';
import { THEME_KEY, savedTheme, setTheme, currentTheme } from '../utils/theme.js';
import { useChartColors } from '../hooks/useChartColors.js';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.documentElement.setAttribute('data-theme', 'light');
});

describe('theme (R4-01)', () => {
  it('the toggle switches the theme, saves the choice and names the theme it switches to', () => {
    render(<ThemeToggle />);
    const button = screen.getByRole('button', { name: 'Switch to dark theme' });
    fireEvent.click(button);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(currentTheme()).toBe('light');
  });

  it('ignores unknown values', () => {
    localStorage.setItem(THEME_KEY, 'neon');
    expect(savedTheme()).toBeNull();
    setTheme('neon');
    expect(currentTheme()).toBe('light');
  });

  it('chart colours fall back to the light palette where CSS variables are unavailable (jsdom)', () => {
    let colors;
    function Probe() { colors = useChartColors(); return null; }
    render(<Probe />);
    expect(colors).toMatchObject({ brand: '#0d7a6f', CRITICAL: '#dc2626', surface: '#ffffff' });
  });
});

describe('landing page (R4-02)', () => {
  it('"/" shows the landing page WITHOUT the server wake gate, and wakes the server in the background', async () => {
    waitForServer.mockResolvedValue(true);
    renderApp(<Root />, { route: '/' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Every payment, checked before the money moves.' })).toBeInTheDocument();
    expect(pingServer).not.toHaveBeenCalled();          // the gate's probe never ran
    expect(waitForServer).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Servers online. Ready to sign in.')).toBeInTheDocument();
  });

  it('links to sign in and to registration', async () => {
    waitForServer.mockResolvedValue(true);
    renderApp(<Landing />);
    expect(screen.getAllByRole('link', { name: 'Sign in' })[0]).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Create a customer account' })).toHaveAttribute('href', '/register');
    await screen.findByText('Servers online. Ready to sign in.');
  });

  it('says so when the servers do not answer', async () => {
    waitForServer.mockResolvedValue(false);
    renderApp(<Landing />);
    expect(await screen.findByText('The servers did not answer. Try again in a minute.')).toBeInTheDocument();
  });

  it('shows the honest results with the synthetic-data caveat', async () => {
    waitForServer.mockResolvedValue(true);
    renderApp(<Landing />);
    expect(screen.getByText('68%')).toBeInTheDocument();
    expect(screen.getByText('241')).toBeInTheDocument();
    expect(screen.getByText(/not a\s+measurement on real bank traffic/)).toBeInTheDocument();
    await screen.findByText('Servers online. Ready to sign in.');
  });
});

describe('ScoringReplay', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('opens on the account takeover; a tab shows another sample and stops the auto-advance', () => {
    vi.useFakeTimers();
    render(<ScoringReplay />);
    expect(screen.getByRole('tab', { name: 'Account takeover' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('CRITICAL · 81/100')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Policy check' }));
    expect(screen.getByText('MEDIUM · 49/100')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(screen.getByRole('tab', { name: 'Policy check' })).toHaveAttribute('aria-selected', 'true');
  });

  it('advances by itself every 7 s until picked', () => {
    vi.useFakeTimers();
    render(<ScoringReplay />);
    act(() => { vi.advanceTimersByTime(7_000); });
    expect(screen.getByRole('tab', { name: 'Policy check' })).toHaveAttribute('aria-selected', 'true');
  });

  it('the samples match the live results recorded end to end', () => {
    expect(SAMPLES.map((s) => [s.rules, s.ml, s.final, s.level])).toEqual([
      [0, 0, 0, 'LOW'], [65, 81, 81, 'CRITICAL'], [50, 1, 49, 'MEDIUM'],
    ]);
  });
});

// ── R4-03 scenario presets, R4-04 scoring pipeline ─────────────────────────────────────────────────
import ScoringPipeline from '../components/common/ScoringPipeline.jsx';
import SubmitTransaction from '../pages/customer/SubmitTransaction.jsx';
import { signedIn } from '../tests/utils.jsx';
import api from '../api/axios.js';

describe('scenario presets (R4-03)', () => {
  it('fill the form without submitting; the takeover uses a new device and a new city', () => {
    renderApp(<SubmitTransaction />, { auth: signedIn() });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Pune' } });
    fireEvent.click(screen.getByRole('button', { name: 'High-risk merchant' }));
    expect(screen.getByLabelText(/Merchant name/)).toHaveValue('Lucky Spin');
    expect(screen.getByLabelText(/Merchant category/)).toHaveValue('CASINO');
    expect(screen.getByLabelText('City')).toHaveValue('Pune');               // the customer's city is kept
    expect(screen.getByText(/the policy check raises an alert/)).toBeInTheDocument();
    const usualDevice = screen.getByLabelText(/Device/).value;

    fireEvent.click(screen.getByRole('button', { name: 'Account takeover' }));
    expect(screen.getByLabelText(/Amount/)).toHaveValue(25000);
    expect(screen.getByLabelText('City')).toHaveValue('Guwahati');
    expect(screen.getByLabelText(/Device/).value).toMatch(/^new-phone-/);
    expect(screen.getByLabelText(/Device/).value).not.toBe(usualDevice);
    expect(screen.getByRole('button', { name: 'Account takeover' })).toHaveAttribute('aria-pressed', 'true');
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('scoring pipeline (R4-04)', () => {
  const base = { fraudScore: 81, riskLevel: 'CRITICAL', recommendedAction: 'BLOCK' };

  it('ML decided: both scores, model version and time', () => {
    render(<ScoringPipeline result={{ ...base, scoring: { engine: 'ML', ruleScore: 65, mlScore: 81, modelVersion: 'fg-xgb-1.1.0', mlLatencyMs: 34 } }} />);
    const view = screen.getByTestId('scoring-pipeline');
    expect(view).toHaveTextContent('65/100');
    expect(view).toHaveTextContent('81/100');
    expect(view).toHaveTextContent('fg-xgb-1.1.0, 34 ms');
    expect(view).toHaveTextContent('CRITICAL · 81');
    expect(view).toHaveTextContent('Blocked. Decided by: Model.');
  });

  it('floor applied, ML not used, ML off', () => {
    const { unmount } = render(<ScoringPipeline result={{ fraudScore: 49, riskLevel: 'MEDIUM', recommendedAction: 'OTP', scoring: { engine: 'ML', ruleScore: 50, mlScore: 1, ruleFloor: true } }} />);
    expect(screen.getByTestId('scoring-pipeline')).toHaveTextContent('Approved, customer alerted. Decided by: Model, raised by the policy floor.');
    unmount();
    const second = render(<ScoringPipeline result={{ ...base, fraudScore: 65, riskLevel: 'HIGH', recommendedAction: 'HOLD', scoring: { engine: 'RULES', ruleScore: 65, fallbackReason: 'TIMEOUT' } }} />);
    expect(screen.getByTestId('scoring-pipeline')).toHaveTextContent('Not used');
    expect(screen.getByTestId('scoring-pipeline')).toHaveTextContent('The ML model did not answer in time.');
    expect(screen.getByTestId('scoring-pipeline')).toHaveTextContent('Decided by: Rule engine.');
    second.unmount();
    render(<ScoringPipeline result={{ ...base, scoring: null }} />);
    expect(screen.getByTestId('scoring-pipeline')).toHaveTextContent('Off');
  });
});

// ── "Was this you?" ──────────────────────────────────────────────────────────────────────────────
import WasThisYou from '../components/common/WasThisYou.jsx';
import CustomerResponseNote from '../components/common/CustomerResponseNote.jsx';
import { ok, fail } from '../tests/utils.jsx';
import { waitFor } from '@testing-library/react';

describe('Was this you? (customer)', () => {
  it('asks only on held or blocked payments', () => {
    const { container } = render(<WasThisYou transaction={{ id: 't1', status: 'APPROVED' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('sends the dispute with the note and then shows the answer', async () => {
    api.post.mockResolvedValueOnce(ok({ customerResponse: { answer: 'DISPUTED', note: 'Not me', respondedAt: '2026-10-14T10:00:00Z' } }));
    render(<WasThisYou transaction={{ id: 't1', status: 'HELD' }} />);
    expect(screen.getByRole('heading', { name: 'Was this you?' })).toBeInTheDocument();
    expect(screen.getByText(/does not release or block the payment by itself/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Note for the fraud team/), { target: { value: '  Not me ' } });
    fireEvent.click(screen.getByRole('button', { name: 'No, I did not make it' }));
    expect(await screen.findByText('You told the fraud team that you did not make this payment.')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/customer-api/transactions/t1/response', { answer: 'DISPUTED', note: 'Not me' });
    expect(screen.getByText('Your note: Not me')).toBeInTheDocument();
  });

  it('shows the server message when the answer is refused, and keeps the buttons', async () => {
    api.post.mockRejectedValueOnce(fail(409, 'This payment has already been reviewed by the fraud team.'));
    render(<WasThisYou transaction={{ _id: 't2', status: 'BLOCKED' }} />);
    expect(screen.getByText(/This payment was blocked as possible fraud/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, I made this payment' }));
    expect(await screen.findByText('This payment has already been reviewed by the fraud team.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Yes, I made this payment' })).toBeEnabled());
    expect(api.post).toHaveBeenCalledWith('/customer-api/transactions/t2/response', { answer: 'CONFIRMED' });
  });

  it('an answered payment just shows the answer', () => {
    render(<WasThisYou transaction={{ id: 't3', status: 'HELD', customerResponse: { answer: 'CONFIRMED', note: '' } }} />);
    expect(screen.getByText('You told the fraud team that you made this payment.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('CustomerResponseNote (analyst)', () => {
  it('shows the answer and note; nothing without an answer', () => {
    const { container, rerender } = render(<CustomerResponseNote response={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CustomerResponseNote response={{ answer: 'DISPUTED', note: 'I was asleep', respondedAt: '2026-10-14T10:00:00Z' }} />);
    expect(screen.getByTestId('customer-response')).toHaveTextContent('Customer says: "No, I did not make it"');
    expect(screen.getByTestId('customer-response')).toHaveTextContent('Note: I was asleep');
  });
});

// ── R4-05 demo logins ────────────────────────────────────────────────────────────────────────────
describe('demo logins (R4-05)', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('are hidden unless VITE_DEMO_LOGINS=true', async () => {
    vi.stubEnv('VITE_DEMO_LOGINS', '');
    vi.resetModules();
    const { DEMO_LOGINS_ENABLED } = await import('../utils/demoLogins.js');
    expect(DEMO_LOGINS_ENABLED).toBe(false);
  });

  it('offer a customer and an analyst (never an admin), with the seed script\'s default password', async () => {
    vi.stubEnv('VITE_DEMO_LOGINS', 'true');
    vi.resetModules();
    const { DEMO_LOGINS_ENABLED, DEMO_ACCOUNTS } = await import('../utils/demoLogins.js');
    expect(DEMO_LOGINS_ENABLED).toBe(true);
    expect(DEMO_ACCOUNTS.map((d) => d.email)).toEqual(['demo.aarav@example.com', 'demo.priya@example.com']);
    expect(DEMO_ACCOUNTS.every((d) => d.password === 'Demo@12345')).toBe(true);
  });

  it('the login page shows the buttons and signs in with the demo account', async () => {
    vi.stubEnv('VITE_DEMO_LOGINS', 'true');
    vi.resetModules();
    const { default: LoginPage } = await import('../pages/auth/LoginPage.jsx');
    const { default: apiMod } = await import('../api/axios.js');
    const utils = await import('../tests/utils.jsx');
    apiMod.post.mockResolvedValueOnce(utils.ok({ id: 'u9', name: 'Aarav', email: 'demo.aarav@example.com', role: 'CUSTOMER' }));
    utils.renderApp(<LoginPage />, { route: '/login' });
    fireEvent.click(screen.getByRole('button', { name: 'Try as a customer' }));
    await waitFor(() => expect(apiMod.post).toHaveBeenCalled());
    expect(apiMod.post.mock.calls[0][1]).toEqual({ email: 'demo.aarav@example.com', password: 'Demo@12345' });
    expect(screen.queryByRole('button', { name: /admin/i })).toBeNull();
  });
});
