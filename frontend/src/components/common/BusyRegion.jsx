/**
 * @file src/components/common/BusyRegion.jsx
 * @description Wraps a list that is being refetched while rows are already on screen (filter or
 *   page change): the rows dim and an "Updating…" pill appears, so stale rows are never
 *   presented as the answer to the new filters (N-03 / N-08).
 */
export default function BusyRegion({ busy, children }) {
  return (
    <div className="relative" aria-busy={busy ? 'true' : 'false'}>
      <div className={busy ? 'pointer-events-none opacity-50 transition-opacity' : 'transition-opacity'}>{children}</div>
      {busy && (
        <div className="absolute inset-x-0 top-3 flex justify-center" role="status">
          <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 shadow-sm">Updating…</span>
        </div>
      )}
    </div>
  );
}
