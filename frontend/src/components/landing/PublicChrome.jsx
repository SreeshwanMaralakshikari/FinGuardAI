/**
 * @file src/components/landing/PublicChrome.jsx
 * @description Header and footer shared by the public pages (landing page "/", model card "/model").
 */
import { Link } from 'react-router-dom';
import { BTN } from '../../utils/common.js';
import Icon from '../common/Icon.jsx';
import ThemeToggle from '../common/ThemeToggle.jsx';

export function PublicHeader() {
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
      <Link to="/" className="flex items-center gap-2 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-600 text-on-accent"><Icon name="shield" /></span>
        <span className="font-display text-2xl font-bold">FinGuard<span className="text-primary-600">AI</span></span>
      </Link>
      <nav className="flex items-center gap-1 sm:gap-2" aria-label="Account">
        <ThemeToggle />
        <Link to="/login" className={`${BTN.base} ${BTN.ghost} ${BTN.md} whitespace-nowrap`}>Sign in</Link>
        <span className="hidden sm:inline">
          <Link to="/register" className={`${BTN.base} ${BTN.primary} ${BTN.md}`}>Create account</Link>
        </span>
      </nav>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-gray-200">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-gray-500 sm:px-6">
        <p>FinGuardAI is a student project on digital payment fraud in India.</p>
        <nav aria-label="About" className="flex flex-wrap gap-x-6 gap-y-2">
          <Link to="/" className="hover:text-gray-900 hover:underline">Home</Link>
          <Link to="/model" className="hover:text-gray-900 hover:underline">Model card</Link>
        </nav>
        <p>React, Node.js, Express, MongoDB, Python, XGBoost and SHAP.</p>
      </div>
    </footer>
  );
}
