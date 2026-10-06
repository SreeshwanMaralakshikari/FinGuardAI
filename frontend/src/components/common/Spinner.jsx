/**
 * @file src/components/common/Spinner.jsx
 */
export default function Spinner({ label = 'Loading…', className = 'py-16' }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 ${className}`} role="status" aria-live="polite">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary-600 border-t-transparent" aria-hidden="true" />
      <p className="text-sm text-gray-500">{label}</p>
    </div>
  );
}
