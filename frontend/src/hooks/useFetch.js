/**
 * @file src/hooks/useFetch.js
 * @description Local-state GET for pages that have no Redux slice (D-P7-06, C-P7-03/04).
 *   - ignores answers that arrive after unmount or after the inputs changed (latest request wins)
 *   - ignores cancellations (logout aborts in-flight requests — AUD-40)
 *   - flags `loading` (and drops the previous error) in the SAME render in which `deps` change or
 *     `reload()` is called, so a stale error / result is never shown for the new inputs
 *   - `reload()` re-runs the request (Retry buttons — N-02)
 *   `fetcher` must be stable for the same inputs: pass them through `deps`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { getErrorMessage } from '../api/errors.js';

const sameDeps = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/**
 * @template T
 * @param {() => Promise<T>} fetcher  returns the data to store (not the axios response)
 * @param {unknown[]} deps            re-run when these change
 * @returns {{ data: T|null, loading: boolean, error: string, reload: () => void }}
 */
export function useFetch(fetcher, deps) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const [tick, setTick] = useState(0);
  const [prevDeps, setPrevDeps] = useState(deps);
  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; });

  // New inputs → loading right away (adjusting state during render is the sanctioned pattern)
  if (!sameDeps(prevDeps, deps)) {
    setPrevDeps(deps);
    setState((s) => ({ ...s, loading: true, error: '' }));
  }

  useEffect(() => {
    let active = true;
    fetcherRef.current()
      .then((data) => { if (active) setState({ data, loading: false, error: '' }); })
      .catch((err) => {
        if (!active || axios.isCancel(err)) return;
        setState({ data: null, loading: false, error: getErrorMessage(err, 'Request failed') });
      });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: '' }));
    setTick((t) => t + 1);
  }, []);
  return { ...state, reload };
}
