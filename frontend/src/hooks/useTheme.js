/** @file src/hooks/useTheme.js — Round 4: the current theme ('light' | 'dark'), re-rendering on change. */
import { useSyncExternalStore } from 'react';
import { currentTheme, subscribeTheme } from '../utils/theme.js';

export function useTheme() {
  return useSyncExternalStore(subscribeTheme, currentTheme, () => 'light');
}
