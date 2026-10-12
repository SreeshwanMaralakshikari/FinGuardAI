/**
 * @file src/components/common/TableSkeleton.jsx
 * @description Placeholder rows shown while a table's first page loads (F-05) — the page keeps its
 *   shape instead of showing a lone spinner. A single polite status announces the loading state;
 *   the grey bars pulse unless the user prefers reduced motion.
 */
import { TABLE } from '../../utils/common.js';

export default function TableSkeleton({ rows = 6, cols = 6, label = 'Loading…' }) {
  return (
    <div className={TABLE.wrapper} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="divide-y divide-gray-100 bg-white" aria-hidden="true">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex gap-4 px-3 py-4">
            {Array.from({ length: cols }, (_, c) => (
              <div key={c} className="h-4 flex-1 animate-pulse rounded bg-gray-100 motion-reduce:animate-none" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
