/**
 * @file src/hooks/useGoBack.js
 * @description "Go back" for the 403 / 404 pages (N-17). navigate(-1) leaves the app when the
 *   page was opened directly (new tab, pasted link), so history is used only when react-router
 *   recorded an earlier entry (`history.state.idx > 0`); otherwise go to `fallback`.
 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/** @param {string} fallback  where to go when there is nothing to go back to */
export function useGoBack(fallback) {
  const navigate = useNavigate();
  return useCallback(() => {
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, fallback]);
}
