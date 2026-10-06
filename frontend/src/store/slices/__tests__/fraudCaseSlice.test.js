// src/store/slices/__tests__/fraudCaseSlice.test.js — partial mutation responses (D-P6-24, C-P6-31)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import fraudCaseReducer, { fetchCasesThunk, updateCaseStatusThunk, assignCaseThunk, addCaseNoteThunk } from '../fraudCaseSlice.js';

vi.mock('../../../api/axios.js', () => ({ default: { get: vi.fn(), patch: vi.fn(), post: vi.fn() } }));
import api from '../../../api/axios.js';

const CASE = { _id: 'c1', publicId: 'CASE-2026-00001', status: 'OPEN', assignedAnalystId: null, notes: [] };
const makeStore = (cases = [], selectedCase = null) => configureStore({
  reducer: { fraudCases: fraudCaseReducer },
  preloadedState: {
    fraudCases: {
      ...fraudCaseReducer(undefined, { type: '@@init' }), // every field the slice tracks (loading flags, error, request ids)
      cases, selectedCase, pagination: { page: 1, total: cases.length, limit: 20 },
    },
  },
});
beforeEach(() => vi.clearAllMocks());

it('fetchCasesThunk stores list + pagination', async () => {
  api.get.mockResolvedValueOnce({ data: { success: true, data: [CASE], pagination: { total: 1, page: 1, limit: 20 } } });
  const store = makeStore();
  await store.dispatch(fetchCasesThunk({ status: 'OPEN' }));
  expect(store.getState().fraudCases.cases).toHaveLength(1);
});

describe('updateCaseStatusThunk', () => {
  it('matches the partial response by publicId (no _id in response)', async () => {
    api.patch.mockResolvedValueOnce({ data: { success: true, data: { publicId: CASE.publicId, status: 'UNDER_REVIEW', resolvedAt: null } } });
    const store = makeStore([CASE], CASE);
    await store.dispatch(updateCaseStatusThunk({ id: 'c1', status: 'UNDER_REVIEW' }));
    expect(api.patch).toHaveBeenCalledWith('/analyst-api/cases/c1/status', { status: 'UNDER_REVIEW' });
    expect(store.getState().fraudCases.cases[0].status).toBe('UNDER_REVIEW');
    expect(store.getState().fraudCases.selectedCase.status).toBe('UNDER_REVIEW');
  });
  it('AUD-07: sends resolutionSummary when resolving', async () => {
    api.patch.mockResolvedValueOnce({ data: { success: true, data: { publicId: CASE.publicId, status: 'RESOLVED', resolvedAt: '2026-09-23T00:00:00Z' } } });
    const store = makeStore([CASE]);
    await store.dispatch(updateCaseStatusThunk({ id: 'c1', status: 'RESOLVED', resolutionSummary: 'Confirmed fraud' }));
    expect(api.patch).toHaveBeenCalledWith('/analyst-api/cases/c1/status', { status: 'RESOLVED', resolutionSummary: 'Confirmed fraud' });
    expect(store.getState().fraudCases.cases[0]).toMatchObject({ status: 'RESOLVED', resolvedAt: '2026-09-23T00:00:00Z' });
  });
  it('surfaces the validator message on 422', async () => {
    api.patch.mockRejectedValueOnce({ response: { status: 422, data: { success: false, errors: [{ msg: 'Resolution summary is required when resolving or dismissing a case' }] } } });
    const store = makeStore([CASE]);
    const action = await store.dispatch(updateCaseStatusThunk({ id: 'c1', status: 'RESOLVED' }));
    expect(action.payload).toMatch(/Resolution summary is required/);
  });
});

it('assignCaseThunk updates status + assignee by publicId', async () => {
  api.patch.mockResolvedValueOnce({ data: { success: true, data: { publicId: CASE.publicId, status: 'ASSIGNED', assignedAnalystId: 'an1' } } });
  const store = makeStore([CASE]);
  await store.dispatch(assignCaseThunk({ id: 'c1' }));
  expect(store.getState().fraudCases.cases[0]).toMatchObject({ status: 'ASSIGNED', assignedAnalystId: 'an1' });
});

it('addCaseNoteThunk sends { text } (C-P6-30) and appends the flat note', async () => {
  api.post.mockResolvedValueOnce({ data: { success: true, data: { analystId: 'an1', text: 'Verified', createdAt: '2026-09-23T00:00:00Z' } } });
  const store = makeStore([CASE], { ...CASE, notes: [] });
  await store.dispatch(addCaseNoteThunk({ id: 'c1', note: 'Verified' }));
  expect(api.post).toHaveBeenCalledWith('/analyst-api/cases/c1/notes', { text: 'Verified' });
  expect(store.getState().fraudCases.selectedCase.notes[0].text).toBe('Verified');
});
