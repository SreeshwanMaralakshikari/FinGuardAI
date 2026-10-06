/**
 * @file src/store/hooks.js
 * @description Typed Redux hooks for use throughout the application.
 *   - useAppDispatch: typed dispatch (prevents plain `useDispatch` usage)
 *   - useAppSelector: typed selector with RootState
 * @phase Phase 6 — Frontend Foundation
 */

import { useDispatch, useSelector } from 'react-redux';

/**
 * Typed dispatch hook — use instead of plain useDispatch.
 * @returns {import('./index.js').AppDispatch}
 */
export const useAppDispatch = () => useDispatch();

/**
 * Typed selector hook — use instead of plain useSelector.
 * @template T
 * @param {function(import('./index.js').RootState): T} selector
 * @returns {T}
 */
export const useAppSelector = useSelector;
