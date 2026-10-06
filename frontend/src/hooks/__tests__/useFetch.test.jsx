// useFetch: latest request wins, reload, errors, cancellation, unmount
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import axios from 'axios';
import { useFetch } from '../useFetch.js';

/** A promise the test settles by hand. */
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useFetch', () => {
  it('starts loading and then exposes the data', async () => {
    const { result } = renderHook(() => useFetch(async () => 'rows', []));
    expect(result.current).toMatchObject({ loading: true, data: null, error: '' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ data: 'rows', error: '' });
  });

  it('race: an older, slower response never overwrites the newer inputs', async () => {
    const calls = { a: deferred(), b: deferred() };
    const { result, rerender } = renderHook(({ q }) => useFetch(() => calls[q].promise, [q]), { initialProps: { q: 'a' } });
    rerender({ q: 'b' });
    await act(async () => { calls.b.resolve('B'); });
    await waitFor(() => expect(result.current.data).toBe('B'));
    await act(async () => { calls.a.resolve('A'); }); // stale answer arrives last
    expect(result.current).toMatchObject({ data: 'B', loading: false });
  });

  it('flags loading and clears the old error in the same render the inputs change', async () => {
    const { result, rerender } = renderHook(
      ({ q }) => useFetch(() => (q === 'bad' ? Promise.reject({ response: { data: { message: 'boom' } } }) : new Promise(() => {})), [q]),
      { initialProps: { q: 'bad' } },
    );
    await waitFor(() => expect(result.current.error).toBe('boom'));
    rerender({ q: 'next' });
    expect(result.current).toMatchObject({ loading: true, error: '' }); // no stale error for the new inputs
  });

  it('reload() fetches again and clears a previous error (Retry)', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce({ response: { data: { message: 'down' } } })
      .mockResolvedValueOnce('ok');
    const { result } = renderHook(() => useFetch(fetcher, []));
    await waitFor(() => expect(result.current.error).toBe('down'));
    expect(result.current.data).toBeNull();

    act(() => result.current.reload());
    expect(result.current).toMatchObject({ loading: true, error: '' });
    await waitFor(() => expect(result.current.data).toBe('ok'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('turns a rejected request into an error string (422 errors[] first)', async () => {
    const { result } = renderHook(() => useFetch(() => Promise.reject({ response: { data: { errors: [{ msg: 'bad input' }], message: 'x' } } }), []));
    await waitFor(() => expect(result.current.error).toBe('bad input'));
  });

  it('ignores cancelled requests (logout aborts in-flight calls)', async () => {
    const d = deferred();
    const { result } = renderHook(() => useFetch(() => d.promise, []));
    await act(async () => { d.reject(new axios.CanceledError()); });
    expect(result.current.error).toBe('');
    expect(result.current.loading).toBe(true);
  });

  it('does not update state after unmount', async () => {
    const d = deferred();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => useFetch(() => d.promise, []));
    unmount();
    await act(async () => { d.resolve('late'); });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
