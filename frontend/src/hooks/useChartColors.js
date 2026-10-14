/**
 * @file src/hooks/useChartColors.js
 * @description Round 4 (R4-01): chart colours taken from the active theme's CSS variables, so Recharts (which
 *   writes colours into SVG attributes) follows the light / dark theme. Re-reads on every theme change.
 *   Fallbacks are the light-theme values (used in tests, where jsdom computes no custom properties).
 */
import { useMemo } from 'react';
import { useTheme } from './useTheme.js';

const VARS = {
  surface:  ['--color-white', '#ffffff'],
  text:     ['--color-gray-900', '#111c2e'],
  grid:     ['--color-gray-200', '#dbe2ec'],
  axis:     ['--color-gray-300', '#c3cddb'],
  tick:     ['--color-gray-500', '#5f6e85'],
  brand:    ['--color-primary-600', '#0d7a6f'],
  average:  ['--color-amber-600', '#d97706'],
  forecast: ['--color-indigo-500', '#6366f1'],
  LOW:      ['--color-emerald-600', '#059669'],
  MEDIUM:   ['--color-yellow-600', '#ca8a04'],
  HIGH:     ['--color-orange-600', '#ea580c'],
  CRITICAL: ['--color-red-600', '#dc2626'],
};

export function useChartColors() {
  const theme = useTheme();
  return useMemo(() => {
    const style = typeof window !== 'undefined' ? window.getComputedStyle(document.documentElement) : null;
    return Object.fromEntries(Object.entries(VARS).map(([key, [cssVar, fallback]]) => {
      const value = style?.getPropertyValue(cssVar).trim();
      return [key, value || fallback];
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
}

/** Recharts <Tooltip> styles for the active theme. */
export const tooltipStyles = (c) => ({
  contentStyle: { background: c.surface, border: `1px solid ${c.grid}`, borderRadius: 8, color: c.text, fontSize: 12 },
  labelStyle: { color: c.text, fontWeight: 600 },
  itemStyle: { color: c.text },
});
