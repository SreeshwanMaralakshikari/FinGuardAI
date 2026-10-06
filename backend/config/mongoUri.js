/**
 * @file config/mongoUri.js
 * @description Small helpers for MongoDB connection strings, shared by
 *   validateEnv, seed/seedAdmin.js and tests/setup.js (D-04, D-09).
 *   Never logs or returns credentials.
 */

/**
 * Database name in a mongodb:// or mongodb+srv:// URI ('' when the URI has none —
 * the driver then silently uses "test").
 * @param {string|undefined} uri
 * @returns {string}
 */
export const getMongoDbName = (uri) => {
  if (typeof uri !== 'string') return '';
  const withoutScheme = uri.trim().replace(/^mongodb(\+srv)?:\/\//i, '');
  const beforeQuery = withoutScheme.split('?')[0];
  // Credentials may contain "/" only when percent-encoded, but be tolerant:
  // the host list starts after the LAST "@" of the authority.
  const hostAndPath = beforeQuery.slice(beforeQuery.lastIndexOf('@') + 1);
  const slash = hostAndPath.indexOf('/');
  if (slash === -1) return '';
  const raw = hostAndPath.slice(slash + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * True when every host in the URI is localhost / 127.0.0.1 / ::1.
 * @param {string|undefined} uri
 * @returns {boolean}
 */
export const isLocalMongoUri = (uri) => {
  if (typeof uri !== 'string') return false;
  const withoutScheme = uri.trim().replace(/^mongodb(\+srv)?:\/\//i, '').split('?')[0];
  const hostAndPath = withoutScheme.slice(withoutScheme.lastIndexOf('@') + 1);
  const hosts = hostAndPath.split('/')[0].split(',');
  return hosts.length > 0 && hosts.every((host) => {
    const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return name === 'localhost' || name === '127.0.0.1' || name === '::1';
  });
};
