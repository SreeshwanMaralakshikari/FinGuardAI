/**
 * @file src/components/common/LoadError.jsx
 * @description A failed load shown as an error with a Retry button (N-02). Pages render this
 *   INSTEAD of the empty state / zero KPIs, so "the request failed" can never look like
 *   "there is nothing here".
 */
import { BTN } from '../../utils/common.js';
import Alert from './Alert.jsx';

export default function LoadError({ message, onRetry }) {
  if (!message) return null;
  return (
    <Alert tone="error">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{message}</span>
        {onRetry && (
          <button type="button" className={`${BTN.base} ${BTN.secondary} ${BTN.sm}`} onClick={onRetry}>Retry</button>
        )}
      </div>
    </Alert>
  );
}
