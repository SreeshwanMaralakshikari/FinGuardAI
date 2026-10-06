/**
 * @file src/components/common/PageHeader.jsx
 * @description Page heading. Also keeps `document.title` in step with the page
 *   ("Transactions · FinGuardAI") so browser tabs, history and screen readers
 *   announce where the user is after a client-side navigation.
 */
import { useEffect } from 'react';

const APP_TITLE = 'FinGuardAI';

export default function PageHeader({ title, subtitle = null, actions = null }) {
  useEffect(() => {
    if (typeof title !== 'string' || !title) return undefined;
    const previous = document.title;
    document.title = `${title} · ${APP_TITLE}`;
    return () => { document.title = previous; };
  }, [title]);

  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-bold text-gray-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
