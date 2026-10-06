/**
 * @file src/hooks/useDialog.js
 * @description Shared behaviour of every modal surface (Modal, mobile sidebar drawer) — N-01, N-07, N-15:
 *   - on the open transition only: remember the previously focused element, lock page
 *     scroll and move focus into the panel (re-renders of the parent never steal focus again)
 *   - Escape closes (unless `dismissible` is false)
 *   - Tab / Shift+Tab are trapped inside the panel
 *   - on close the focus returns to the element that opened it
 *   `onClose` / `dismissible` are read through refs, so callers may pass fresh inline
 *   functions on every render without re-running the effect.
 */
import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

// Scroll lock is reference-counted so stacked dialogs (drawer + modal) restore the page correctly.
let lockCount = 0;
let savedOverflow = '';
function lockScroll() {
  if (lockCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;
}
function unlockScroll() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) document.body.style.overflow = savedOverflow;
}

/**
 * @param {{ open: boolean, panelRef: { current: HTMLElement | null }, onClose?: () => void, dismissible?: boolean }} opts
 */
export function useDialog({ open, panelRef, onClose, dismissible = true }) {
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    lockScroll();
    panelRef.current?.focus();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (dismissibleRef.current) onCloseRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.getAttribute('aria-hidden') !== 'true');
      if (items.length === 0) { e.preventDefault(); panel.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || active === panel || !panel.contains(active)) { e.preventDefault(); last.focus(); }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      unlockScroll();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open, panelRef]);
}
