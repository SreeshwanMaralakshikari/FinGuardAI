/**
 * @file src/components/common/DetailRow.jsx
 * @description <dt>/<dd> pair for definition lists inside modals and cards.
 */
export default function DetailRow({ label, children }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-1 break-words text-sm text-gray-900">{children ?? '—'}</dd>
    </div>
  );
}
