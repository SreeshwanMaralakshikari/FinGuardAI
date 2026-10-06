/**
 * @file src/components/common/StatCard.jsx
 * @description KPI tile. `loading` shows a placeholder instead of a misleading 0.
 */
import { CARD } from '../../utils/common.js';

export default function StatCard({ label, value, hint = null, loading = false }) {
  return (
    <div className={`${CARD.base} p-5`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-gray-900">
        {loading ? (
          <>
            <span className="inline-block h-7 w-20 animate-pulse rounded bg-gray-100" aria-hidden="true" />
            <span className="sr-only">Loading</span>
          </>
        ) : value}
      </p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}
