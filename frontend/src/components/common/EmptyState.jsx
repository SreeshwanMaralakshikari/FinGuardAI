/**
 * @file src/components/common/EmptyState.jsx
 */
export default function EmptyState({ title, message, action = null }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white px-6 py-14 text-center">
      <p className="text-sm font-semibold text-gray-900">{title}</p>
      {message && <p className="mt-1 max-w-sm text-sm text-gray-500">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
