// CaseDetail: assign / status / notes / close dialog (N-06, N-01, N-07), load error + Retry (N-02)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import CaseDetail from '../analyst/CaseDetail.jsx';
import { renderApp, ok, fail, signedIn } from '../../tests/utils.jsx';

vi.mock('../../api/axios.js', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
import api from '../../api/axios.js';

const ME = { id: 'me', name: 'Ravi Analyst', email: 'ravi@example.com', role: 'ANALYST' };
const baseCase = (over = {}) => ({
  _id: 'c1', publicId: 'CASE-2026-00001', status: 'OPEN', assignedAnalystId: null, openedAt: '2026-10-05T05:00:00Z',
  notes: [], resolutionSummary: '', resolvedAt: null,
  fraudAlertId: { _id: 'fa1', alertType: 'HIGH_AMOUNT', reasons: ['Amount is unusually high'] },
  transactionId: { _id: 't1', publicId: 'TXN-2026-00001', amount: 90000, merchantName: 'Big Shop', riskLevel: 'HIGH', status: 'HELD', fraudScore: 62, deviceId: 'web-1', timestamp: '2026-10-05T05:00:00Z' },
  ...over,
});

let server;
function renderCase(initial = {}) {
  server = { case: baseCase(initial) };
  api.get.mockImplementation(async (url) => {
    if (url === '/analyst-api/cases/c1') return ok(structuredClone(server.case));
    throw fail(404, 'Case not found');
  });
  return renderApp(
    <Routes><Route path="/analyst/cases/:id" element={<CaseDetail />} /><Route path="/analyst/cases" element={<p>cases list</p>} /></Routes>,
    { route: '/analyst/cases/c1', auth: signedIn(ME) },
  );
}
const getCalls = () => api.get.mock.calls.filter(([u]) => u === '/analyst-api/cases/c1').length;

beforeEach(() => { vi.clearAllMocks(); });

describe('CaseDetail workflow', () => {
  it('OPEN case: assign to me, then the review actions appear', async () => {
    renderCase();
    expect(await screen.findByRole('heading', { name: 'Case CASE-2026-00001' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start review' })).toBeNull(); // OPEN has no direct transition

    api.patch.mockResolvedValueOnce(ok({ publicId: 'CASE-2026-00001', status: 'ASSIGNED', assignedAnalystId: 'me' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assign to me' }));
    expect(await screen.findByRole('button', { name: 'Start review' })).toBeEnabled();
    expect(api.patch).toHaveBeenCalledWith('/analyst-api/cases/c1/assign', { analystId: 'me' });
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    expect(screen.getByText('Ravi Analyst')).toBeInTheDocument(); // populated assignee rebuilt from the session
  });

  it('only the assigned analyst gets enabled status actions (server rule mirrored in the UI)', async () => {
    renderCase({ status: 'ASSIGNED', assignedAnalystId: { _id: 'someone-else', name: 'Other Analyst' } });
    const start = await screen.findByRole('button', { name: 'Start review' });
    expect(start).toBeDisabled();
    expect(screen.getByText('Only the assigned analyst can change the status.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Take over this case' })).toBeEnabled();
  });

  it('Start review sends the status and refetches the case', async () => {
    renderCase({ status: 'ASSIGNED', assignedAnalystId: { _id: 'me', name: 'Ravi Analyst' } });
    await screen.findByRole('button', { name: 'Start review' });
    const before = getCalls();
    api.patch.mockResolvedValueOnce(ok({ publicId: 'CASE-2026-00001', status: 'UNDER_REVIEW', resolvedAt: null }));
    server.case.status = 'UNDER_REVIEW';
    fireEvent.click(screen.getByRole('button', { name: 'Start review' }));
    expect(await screen.findByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    expect(api.patch).toHaveBeenCalledWith('/analyst-api/cases/c1/status', { status: 'UNDER_REVIEW' });
    await waitFor(() => expect(getCalls()).toBeGreaterThan(before));
  });

  it('an action failure appears as a page alert', async () => {
    renderCase({ status: 'ASSIGNED', assignedAnalystId: { _id: 'me', name: 'Ravi Analyst' } });
    api.patch.mockRejectedValueOnce(fail(400, 'Invalid status transition'));
    fireEvent.click(await screen.findByRole('button', { name: 'Start review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid status transition');
  });
});

describe('CaseDetail stale state after a rejected action (P-1)', () => {
  it('a 403 refetches the case, so the buttons follow the server (someone took the case over)', async () => {
    renderCase({ status: 'ASSIGNED', assignedAnalystId: { _id: 'me', name: 'Ravi Analyst' } });
    const start = await screen.findByRole('button', { name: 'Start review' });
    expect(start).toBeEnabled();
    const before = getCalls();
    server.case.assignedAnalystId = { _id: 'other', name: 'Other Analyst' }; // changed on the server meanwhile
    api.patch.mockRejectedValueOnce(fail(403, 'Only the assigned analyst can change the status.'));
    fireEvent.click(start);
    await waitFor(() => expect(getCalls()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start review' })).toBeDisabled());
    expect(screen.getByRole('alert')).toHaveTextContent('Only the assigned analyst');
  });
});

describe('CaseDetail close dialog (N-06)', () => {
  const underReview = { status: 'UNDER_REVIEW', assignedAnalystId: { _id: 'me', name: 'Ravi Analyst' } };

  it('requires a summary before sending', async () => {
    renderCase(underReview);
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve case' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resolve case' }));
    expect(await within(dialog).findByText('A resolution summary is required.')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('N-01: typing the summary keeps focus in the textarea', async () => {
    renderCase(underReview);
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    const ta = await screen.findByLabelText(/resolution summary/i);
    ta.focus();
    for (const v of ['C', 'Co', 'Con', 'Conf']) {
      fireEvent.change(ta, { target: { value: v } });
      expect(document.activeElement).toBe(ta);
    }
  });

  it('a failed close shows the error INSIDE the dialog and keeps it open', async () => {
    renderCase(underReview);
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/resolution summary/i), { target: { value: 'Customer confirmed fraud' } });
    api.patch.mockRejectedValueOnce(fail(400, 'This case is already closed.'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resolve case' }));
    expect(await within(dialog).findByText('This case is already closed.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/resolution summary/i)).toHaveValue('Customer confirmed fraud'); // text kept for a retry
    expect(api.patch).toHaveBeenCalledWith('/analyst-api/cases/c1/status', { status: 'RESOLVED', resolutionSummary: 'Customer confirmed fraud' });
  });

  it('N-07: the dialog cannot be dismissed while the request is running', async () => {
    renderCase(underReview);
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/resolution summary/i), { target: { value: 'done' } });
    let finish;
    api.patch.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resolve case' }));

    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(dialog).getByRole('button', { name: 'Close dialog' })).toBeDisabled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    server.case.status = 'RESOLVED';
    await act(async () => { finish(ok({ publicId: 'CASE-2026-00001', status: 'RESOLVED', resolvedAt: '2026-10-06T00:00:00Z' })); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('This case is closed and read-only.')).toBeInTheDocument();
  });

  it('Dismiss explains that it releases the transaction', async () => {
    renderCase(underReview);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss case' });
    expect(within(dialog).getByText(/false positive/i)).toBeInTheDocument();
  });
});

describe('CaseDetail notes', () => {
  it('appends the saved note (with its _id) and clears the box', async () => {
    renderCase({ status: 'ASSIGNED', assignedAnalystId: { _id: 'me', name: 'Ravi Analyst' } });
    const box = await screen.findByLabelText('Add a note');
    fireEvent.change(box, { target: { value: '  Called the customer  ' } });
    api.post.mockResolvedValueOnce(ok({ _id: 'n1', analystId: 'me', text: 'Called the customer', createdAt: '2026-10-06T05:00:00Z' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(await screen.findByText('Called the customer')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/analyst-api/cases/c1/notes', { text: 'Called the customer' });
    expect(screen.getByText(/Ravi Analyst ·/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Add a note')).toHaveValue(''));
  });

  it('shows a failure to add a note', async () => {
    renderCase({ status: 'ASSIGNED', assignedAnalystId: { _id: 'me', name: 'Ravi Analyst' } });
    fireEvent.change(await screen.findByLabelText('Add a note'), { target: { value: 'x' } });
    api.post.mockRejectedValueOnce(fail(400, 'This case is closed.'));
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This case is closed.');
  });

  it('closed cases have no note form', async () => {
    renderCase({ status: 'DISMISSED', assignedAnalystId: { _id: 'me', name: 'Ravi Analyst' }, resolutionSummary: 'False positive', resolvedAt: '2026-10-06T00:00:00Z' });
    expect(await screen.findByText('False positive')).toBeInTheDocument();
    expect(screen.queryByLabelText('Add a note')).toBeNull();
  });
});

describe('CaseDetail loading', () => {
  it('N-02: a failed load shows the error with Retry and a way back', async () => {
    api.get.mockRejectedValueOnce(fail(500, 'Could not reach the database'));
    renderApp(
      <Routes><Route path="/analyst/cases/:id" element={<CaseDetail />} /></Routes>,
      { route: '/analyst/cases/c2', auth: signedIn(ME) },
    );
    expect(await screen.findByText('Could not reach the database')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to cases' })).toBeInTheDocument();

    api.get.mockResolvedValueOnce(ok(baseCase({ _id: 'c2', publicId: 'CASE-2026-00002' })));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Case CASE-2026-00002' })).toBeInTheDocument();
  });
});

describe('CaseDetail late failure for a case the user already left (FE2-1)', () => {
  it('does not refetch the old case after navigating to another one', async () => {
    const cases = { c1: baseCase({ status: 'ASSIGNED', assignedAnalystId: { _id: 'me', name: 'Ravi Analyst' } }), c2: baseCase({ _id: 'c2', publicId: 'CASE-2026-00002' }) };
    api.get.mockImplementation(async (url) => {
      const m = /^\/analyst-api\/cases\/(c\d)$/.exec(url);
      if (m) return ok(structuredClone(cases[m[1]]));
      throw fail(404, 'Case not found');
    });
    let rejectPatch;
    api.patch.mockImplementationOnce(() => new Promise((_, reject) => { rejectPatch = () => reject(fail(403, 'Only the assigned analyst can change the status.')); }));
    const { Link } = await import('react-router-dom');
    renderApp(
      <>
        <Link to="/analyst/cases/c2">go c2</Link>
        <Routes><Route path="/analyst/cases/:id" element={<CaseDetail />} /></Routes>
      </>,
      { route: '/analyst/cases/c1', auth: signedIn(ME) },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Start review' }));
    fireEvent.click(screen.getByText('go c2'));
    expect(await screen.findByRole('heading', { name: 'Case CASE-2026-00002' })).toBeInTheDocument();
    const c1Fetches = () => api.get.mock.calls.filter(([u]) => u === '/analyst-api/cases/c1').length;
    const before = c1Fetches();
    await act(async () => { rejectPatch(); });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Case CASE-2026-00002' })).toBeInTheDocument());
    expect(c1Fetches()).toBe(before);
  });
});
