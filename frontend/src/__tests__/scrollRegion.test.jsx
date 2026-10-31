// ScrollRegion: a wide read-only table becomes keyboard-scrollable only when it actually overflows.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import ScrollRegion from '../components/common/ScrollRegion.jsx';

const original = globalThis.ResizeObserver;
afterEach(() => { globalThis.ResizeObserver = original; vi.restoreAllMocks(); });

// A ResizeObserver whose callback the test triggers by hand, after setting the box sizes.
const controllableObserver = () => {
  const callbacks = [];
  globalThis.ResizeObserver = class {
    constructor(cb) { callbacks.push(cb); }
    observe() {}
    disconnect() {}
  };
  return () => act(() => { callbacks.forEach((cb) => cb([])); });
};
const sizeBox = (el, scrollWidth, clientWidth) => {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
};

describe('ScrollRegion', () => {
  it('is a plain box (no tab stop) when the table fits', () => {
    const fire = controllableObserver();
    const { container } = render(<ScrollRegion label="Latest flagged"><table><tbody><tr><td>x</td></tr></tbody></table></ScrollRegion>);
    sizeBox(container.firstChild, 500, 500);
    fire();
    expect(container.firstChild).not.toHaveAttribute('tabindex');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('becomes a focusable, labelled region when the table is wider than the box, and back when it fits again', () => {
    const fire = controllableObserver();
    const { container } = render(<ScrollRegion label="Latest flagged"><table><tbody><tr><td>x</td></tr></tbody></table></ScrollRegion>);
    sizeBox(container.firstChild, 900, 400);
    fire();
    const region = screen.getByRole('region', { name: 'Latest flagged' });
    expect(region).toHaveAttribute('tabindex', '0');
    region.focus();
    expect(region).toHaveFocus();

    sizeBox(container.firstChild, 400, 400);
    fire();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('keeps the table wrapper styling (relative box that scrolls sideways)', () => {
    const { container } = render(<ScrollRegion label="x"><table /></ScrollRegion>);
    expect(container.firstChild.className).toMatch(/overflow-x-auto/);
    expect(container.firstChild.className).toMatch(/relative/);
  });
});
