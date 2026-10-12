/**
 * @file src/utils/routeFocus.js
 * @description F-05: after a client-side navigation keyboard and screen-reader users should land on
 *   the new page's <h1>, not stay on the link they activated. AppShell calls requestRouteFocus() when
 *   the pathname changes; the next PageHeader to mount consumes the request and focuses its h1.
 *   (Pages are lazy-loaded, so the h1 does not exist yet when the route changes.) The request
 *   expires, so a page without a PageHeader cannot steal focus later.
 */
const EXPIRES_AFTER_MS = 5_000;
let requestedAt = 0;

export function requestRouteFocus() {
  requestedAt = Date.now();
}

/** @returns {boolean} true once per navigation, while the request is still fresh */
export function consumeRouteFocus() {
  const fresh = requestedAt > 0 && Date.now() - requestedAt < EXPIRES_AFTER_MS;
  requestedAt = 0;
  return fresh;
}
