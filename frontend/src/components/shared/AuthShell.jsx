/**
 * @file src/components/shared/AuthShell.jsx
 * @description Two-column wrapper for the public Login / Register pages.
 *   Round 4: Guardian look — the left panel is "chrome" (dark navy in both themes) with the shield emblem;
 *   the brand links back to the landing page; the theme toggle sits top-right.
 */
import { Link } from 'react-router-dom';
import Icon from '../common/Icon.jsx';
import ThemeToggle from '../common/ThemeToggle.jsx';
import ShieldMark from '../common/ShieldMark.jsx';

function Brand({ tone }) {
  return (
    <Link to="/" className="flex w-fit items-center gap-2 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-600 text-on-accent"><Icon name="shield" /></span>
      <span className={`font-display text-2xl font-bold ${tone === 'chrome' ? 'text-chrome-ink' : 'text-gray-900'}`}>
        FinGuard<span className="text-primary-500">AI</span>
      </span>
    </Link>
  );
}

export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <div className="relative hidden w-5/12 flex-col justify-between overflow-hidden bg-chrome bg-watch-grid p-10 lg:flex">
        <Brand tone="chrome" />
        <div className="relative">
          <ShieldMark className="mb-8 h-28 w-28" />
          <h2 className="max-w-md text-4xl font-bold leading-tight text-chrome-ink">Every payment, checked before the money moves.</h2>
          <p className="mt-4 max-w-md text-chrome-muted">
            A machine-learning model and a rule engine score each payment in real time, so a suspicious one is
            flagged, held or blocked before it completes, and an analyst can see exactly why.
          </p>
        </div>
        <p className="text-xs text-chrome-muted">Student project: FinGuardAI Intelligent Fraud Detection System</p>
      </div>

      <div className="relative flex flex-1 items-center justify-center px-4 py-10">
        <ThemeToggle className="absolute right-4 top-4" />
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden"><Brand tone="surface" /></div>
          <h1 className="text-3xl font-bold text-gray-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
          <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">{children}</div>
          {footer && <p className="mt-4 text-center text-sm text-gray-600">{footer}</p>}
        </div>
      </div>
    </div>
  );
}
