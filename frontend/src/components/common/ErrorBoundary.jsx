/**
 * @file src/components/common/ErrorBoundary.jsx
 * @description Catches render errors so one bad value blanks a panel, not the whole app.
 */
import { Component } from 'react';
import { BTN } from '../../utils/common.js';

export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (import.meta.env.DEV) console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto mt-16 max-w-md rounded-xl border border-red-200 bg-white p-8 text-center shadow-sm" role="alert">
        <h1 className="text-lg font-semibold text-gray-900">Something went wrong</h1>
        <p className="mt-2 text-sm text-gray-600">
          This screen hit an unexpected error. Your data is safe — try reloading the page.
        </p>
        <button
          type="button"
          className={`${BTN.base} ${BTN.primary} ${BTN.md} mt-6`}
          onClick={() => window.location.reload()}
        >
          Reload page
        </button>
      </div>
    );
  }
}
