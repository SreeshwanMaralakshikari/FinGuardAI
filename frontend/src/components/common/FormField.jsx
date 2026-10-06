/**
 * @file src/components/common/FormField.jsx
 * @description Label + control + error message wired for react-hook-form (D-P7-04).
 *   Children are rendered via `render(props)` so the caller picks input/select/textarea.
 *   Dotted names ("scoreThresholds.mediumMin") resolve nested errors (C-P7-06).
 */
import { INPUT } from '../../utils/common.js';
import { getNestedError } from '../../utils/forms.js';

export default function FormField({ name, label, errors, hint = null, render }) {
  const id = `field-${name.replaceAll('.', '-')}`;
  const error = getNestedError(errors ?? {}, name);
  const controlProps = {
    id,
    'aria-invalid': error ? 'true' : 'false',
    'aria-describedby': error ? `${id}-error` : hint ? `${id}-hint` : undefined,
    className: `${INPUT.base} ${error ? INPUT.error : ''}`,
  };

  return (
    <div>
      <label htmlFor={id} className={INPUT.label}>{label}</label>
      {render(controlProps)}
      {hint && !error && <p id={`${id}-hint`} className="mt-1 text-xs text-gray-500">{hint}</p>}
      {error && <p id={`${id}-error`} className={INPUT.errMsg} role="alert">{error.message}</p>}
    </div>
  );
}
