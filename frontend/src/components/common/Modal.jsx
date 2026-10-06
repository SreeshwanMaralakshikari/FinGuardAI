/**
 * @file src/components/common/Modal.jsx
 * @description Accessible dialog: role="dialog" + aria-modal, focus moves in once when it opens,
 *   Tab is trapped, Escape / backdrop / close button dismiss, focus returns to the opener on close
 *   and the page behind does not scroll (hooks/useDialog.js — N-01, N-07).
 *   `dismissible={false}` blocks every way of closing it (use while a request is in flight,
 *   so the outcome cannot be missed).
 */
import { useRef } from 'react';
import { useDialog } from '../../hooks/useDialog.js';
import Icon from './Icon.jsx';

export default function Modal({ open, title, onClose, children, footer = null, wide = false, dismissible = true }) {
  const panelRef = useRef(null);
  useDialog({ open, panelRef, onClose, dismissible });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/50" onClick={dismissible ? onClose : undefined} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative max-h-[90vh] w-full overflow-y-auto rounded-xl bg-white shadow-xl focus:outline-none ${wide ? 'max-w-3xl' : 'max-w-lg'}`}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={!dismissible}
            className="rounded-lg p-1 text-gray-500 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Close dialog"
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}
