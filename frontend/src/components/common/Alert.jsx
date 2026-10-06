/**
 * @file src/components/common/Alert.jsx
 * @description Inline message box. Static class strings per tone (looked up, not built).
 */
const TONES = {
  error:   'rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700',
  success: 'rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700',
  info:    'rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700',
  warning: 'rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800',
};

export default function Alert({ tone = 'error', children }) {
  if (!children) return null;
  return <div className={TONES[tone] ?? TONES.error} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}
