/**
 * @file src/utils/theme.js
 * @description Round 4 (R4-01): light / dark theme. The active theme is the `data-theme` attribute on <html>,
 *   set before first paint by public/theme-init.js. Choosing a theme here saves it (localStorage
 *   "finguard:theme"); without a saved choice the app follows the OS setting, live.
 */
export const THEME_KEY = 'finguard:theme';
export const THEME_EVENT = 'finguard:themechange';
const THEMES = ['light', 'dark'];

const osTheme = () => (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** The saved choice, or null (storage may be blocked or empty). */
export function savedTheme() {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return THEMES.includes(value) ? value : null;
  } catch {
    return null;
  }
}

/** The theme on the page now. */
export function currentTheme() {
  const attr = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null;
  return THEMES.includes(attr) ? attr : 'light';
}

function apply(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** Switch theme and remember the choice. */
export function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  try { window.localStorage.setItem(THEME_KEY, theme); } catch { /* not saved: still applied */ }
  apply(theme);
}

/** Subscribe to theme changes (toggle, other tabs, OS changes while nothing is saved). Returns unsubscribe. */
export function subscribeTheme(callback) {
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const onOs = () => { if (!savedTheme()) apply(osTheme()); };
  const onStorage = (e) => { if (e.key === THEME_KEY) apply(savedTheme() ?? osTheme()); };
  window.addEventListener(THEME_EVENT, callback);
  window.addEventListener('storage', onStorage);
  media?.addEventListener?.('change', onOs);
  return () => {
    window.removeEventListener(THEME_EVENT, callback);
    window.removeEventListener('storage', onStorage);
    media?.removeEventListener?.('change', onOs);
  };
}
