/**
 * @file src/components/common/ThemeToggle.jsx
 * @description Round 4 (R4-01): switches between the light and the dark ("night watch") theme.
 *   The button names the theme it switches TO, so screen readers and the tooltip say what will happen.
 */
import { useTheme } from '../../hooks/useTheme.js';
import { setTheme } from '../../utils/theme.js';
import Icon from './Icon.jsx';

const BASE = 'inline-flex h-9 w-9 items-center justify-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500';
const TONES = {
  surface: 'text-gray-500 hover:bg-gray-100 hover:text-gray-900',
  chrome:  'text-chrome-muted hover:bg-chrome-hover hover:text-chrome-ink',
};

/** @param {{ tone?: 'surface'|'chrome', className?: string }} props */
export default function ThemeToggle({ tone = 'surface', className = '' }) {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? 'Switch to dark theme' : 'Switch to light theme';
  return (
    <button type="button" onClick={() => setTheme(next)} className={`${BASE} ${TONES[tone]} ${className}`} aria-label={label} title={label}>
      <Icon name={next === 'dark' ? 'moon' : 'sun'} className="h-5 w-5" />
    </button>
  );
}
