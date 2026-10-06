/**
 * @file src/components/shared/AuthShell.jsx
 * @description Two-column wrapper for the public Login / Register pages.
 */
import Icon from '../common/Icon.jsx';

export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <div className="hidden w-5/12 flex-col justify-between bg-gray-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-600"><Icon name="shield" /></span>
          <span className="text-xl font-bold">FinGuard<span className="text-primary-400">AI</span></span>
        </div>
        <div>
          <h2 className="text-3xl font-bold leading-tight">Intelligent fraud detection for digital payments.</h2>
          <p className="mt-4 max-w-md text-gray-300">
            Every transaction is scored in real time against velocity, amount, location, device and
            merchant signals — so suspicious payments are held or blocked before money moves.
          </p>
        </div>
        <p className="text-xs text-gray-500">Student project — FinGuardAI Intelligent Fraud Detection System</p>
      </div>

      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-600 text-white"><Icon name="shield" /></span>
            <span className="text-xl font-bold text-gray-900">FinGuardAI</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
          <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">{children}</div>
          {footer && <p className="mt-4 text-center text-sm text-gray-600">{footer}</p>}
        </div>
      </div>
    </div>
  );
}
