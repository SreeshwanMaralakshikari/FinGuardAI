// Charts on recharts 3: per-bar colours drawn through `shape` (Cell is deprecated) and a fixed legend order.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import BarCard from '../components/charts/BarCard.jsx';
import TrendChart, { FORECAST_NAME } from '../components/charts/TrendChart.jsx';

const RISK = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };
// the colours useChartColors falls back to when CSS variables cannot be read (jsdom)
const HEX = { LOW: '#059669', MEDIUM: '#ca8a04', HIGH: '#ea580c', CRITICAL: '#dc2626', brand: '#0d7a6f' };

// Recharts animates bars in with requestAnimationFrame unless the user prefers reduced motion (its default
// isAnimationActive: 'auto'). jsdom has no matchMedia, so the animation ran and the bars only appeared after its
// frames: on a busy laptop that took over the 5 s wait and the BarCard tests failed now and then (23 Nov). Reporting
// "reduce" draws the final bars at once, which is exactly what a reduced-motion user sees in a real browser.
beforeEach(() => {
  vi.stubGlobal('matchMedia', (query) => ({
    matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const barFills = (container) => [...container.querySelectorAll('.recharts-bar-rectangle path')].map((p) => p.getAttribute('fill'));

describe('BarCard', () => {
  it('colours each bar by its category (risk levels)', async () => {
    const data = [{ level: 'LOW', count: 9 }, { level: 'MEDIUM', count: 4 }, { level: 'HIGH', count: 2 }, { level: 'CRITICAL', count: 1 }];
    const { container } = render(<BarCard title="Risk distribution" data={data} xKey="level" colors={RISK} yLabel="Transactions" />);
    await waitFor(() => expect(barFills(container)).toHaveLength(4));
    expect(barFills(container)).toEqual([HEX.LOW, HEX.MEDIUM, HEX.HIGH, HEX.CRITICAL]);
  });

  it('uses the brand colour when no category colours are given', async () => {
    const data = [{ hour: '09', count: 3 }, { hour: '10', count: 5 }];
    const { container } = render(<BarCard title="By hour" data={data} xKey="hour" yLabel="Transactions" />);
    await waitFor(() => expect(barFills(container)).toHaveLength(2));
    expect(new Set(barFills(container))).toEqual(new Set([HEX.brand]));
  });

  it('a raw colour value in `colors` is used as is', async () => {
    const data = [{ k: 'a', count: 1 }];
    const { container } = render(<BarCard title="Raw" data={data} xKey="k" colors={{ a: '#123456' }} />);
    await waitFor(() => expect(barFills(container)).toEqual(['#123456']));
  });
});

describe('TrendChart legend', () => {
  it('keeps the reading order Transactions → 7-day average → forecast (not alphabetical)', async () => {
    const data = Array.from({ length: 10 }, (_, i) => ({ date: `2026-10-${String(i + 10).padStart(2, '0')}`, count: i % 3, movingAvg: 1, totalAmount: 0, avgFraudScore: 0 }));
    const forecast = { available: true, days: [{ date: '2026-10-20', count: 2 }, { date: '2026-10-21', count: 2 }] };
    const { container } = render(<TrendChart data={data} forecast={forecast} />);
    await waitFor(() => expect(container.querySelectorAll('.recharts-legend-item-text')).toHaveLength(3));
    const labels = [...container.querySelectorAll('.recharts-legend-item-text')].map((n) => n.textContent);
    expect(labels).toEqual(['Transactions', '7-day average', FORECAST_NAME]);
  });
});
