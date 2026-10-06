/**
 * @file src/components/shared/Sidebar.jsx
 * @description Role-aware sidebar. `navItems` = [{ to, label, icon, end? }].
 *   NavLink active/inactive strings are static inline strings (D-P7-03, C-P7-05).
 *   Desktop: fixed panel. Mobile: slide-over drawer — a real modal dialog (role="dialog",
 *   aria-modal, focus moves in, Tab trapped, Escape closes, focus returns to the menu button — N-15).
 */
import { useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { useDialog } from '../../hooks/useDialog.js';
import Icon from '../common/Icon.jsx';

const LINK_ACTIVE   = 'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium bg-primary-600 text-white';
const LINK_INACTIVE = 'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-white';

function Brand() {
  return (
    <div className="flex h-16 items-center gap-2 px-5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600 text-white">
        <Icon name="shield" className="h-5 w-5" />
      </span>
      <span className="text-lg font-bold text-white">FinGuard<span className="text-primary-400">AI</span></span>
    </div>
  );
}

function Links({ navItems, onNavigate }) {
  return (
    <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4" aria-label="Main">
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) => (isActive ? LINK_ACTIVE : LINK_INACTIVE)}
        >
          <Icon name={item.icon} className="h-5 w-5 shrink-0" />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/** Mounted only while open, so the dialog behaviour (focus, trap, Escape) follows its lifetime. */
function MobileDrawer({ navItems, onClose }) {
  const panelRef = useRef(null);
  useDialog({ open: true, panelRef, onClose });

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 bg-gray-900/60" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex w-64 flex-col bg-gray-900 shadow-xl focus:outline-none"
      >
        <div className="flex items-center justify-between pr-3">
          <Brand />
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-300 hover:bg-gray-800" aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>
        <Links navItems={navItems} onNavigate={onClose} />
      </aside>
    </div>
  );
}

export default function Sidebar({ navItems, open, onClose }) {
  // The drawer is lg:hidden: when the window grows past that breakpoint close it,
  // otherwise its scroll lock and key capture would stay active behind the fixed sidebar.
  useEffect(() => {
    if (!open || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(min-width: 1024px)');
    const onChange = (e) => { if (e.matches) onClose?.(); };
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, [open, onClose]);

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col bg-gray-900 lg:flex">
        <Brand />
        <Links navItems={navItems} />
      </aside>

      {open && <MobileDrawer navItems={navItems} onClose={onClose} />}
    </>
  );
}
