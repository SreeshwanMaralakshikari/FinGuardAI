/**
 * @file src/components/common/ScrollRegion.jsx
 * @description Horizontal scroll box for a wide table. When the table is wider than the box (narrow columns,
 *   phones) the box becomes keyboard-focusable and is announced as a labelled region, so keyboard users can
 *   scroll it with the arrow keys (WCAG 2.1.1, axe "scrollable-region-focusable"). When everything fits, it is
 *   a plain box with no extra tab stop. Tables whose rows contain links or buttons are reachable anyway; this is
 *   for read-only tables.
 */
import { useEffect, useRef, useState } from 'react';
import { TABLE } from '../../utils/common.js';

export default function ScrollRegion({ label, children, className = TABLE.wrapper }) {
  const ref = useRef(null);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    // ResizeObserver reports once when observing starts and again on every size change (window, sidebar, data).
    const observer = new ResizeObserver(() => setScrollable(el.scrollWidth > el.clientWidth + 1));
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);

  const focusProps = scrollable
    ? { tabIndex: 0, role: 'region', 'aria-label': label }
    : {};
  return (
    <div
      ref={ref}
      className={`${className} focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500`}
      {...focusProps}
    >
      {children}
    </div>
  );
}
