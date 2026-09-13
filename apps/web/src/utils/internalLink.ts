/**
 * Is this string safe to hand to the router as an in-app destination?
 *
 * Issue #127, epic #109. Used everywhere a notification's `link` turns into
 * navigation: the row click in `components/navigation/NotificationBell.tsx`,
 * the native toast click in `contexts/NotificationContext.tsx`, and — since
 * issue #223 — the `notificationclick` handler in `sw.ts`, which re-validates
 * the SAME value the service worker will hand to `clients.openWindow()`.
 *
 * =============================================================================
 * THE SERVER ALREADY GUARANTEES THIS. CHECKING AGAIN IS THE POINT.
 * =============================================================================
 *
 * `AppNotification.link` is validated by the API's `sanitizeLink` BEFORE the row
 * is written, so by contract it is always a single leading `/` with no scheme
 * and no protocol-relative `//`. This function re-checks that contract at the
 * point of use, for two reasons:
 *
 *   1. The guarantee is kept on the WRITE side, which means it holds for rows
 *      written by today's code. It says nothing about a row written by an older
 *      build, seeded by hand, or restored from a backup taken before the
 *      sanitiser existed.
 *   2. The cost is one comparison and the failure it prevents is open redirect
 *      — `javascript:` reaching a navigation, or `//evil.example` being read by
 *      the browser as a protocol-relative URL to another origin and rendering a
 *      convincing login page. A defence-in-depth check whose entire cost is two
 *      `startsWith` calls does not need to justify itself further.
 *
 * WHAT IT ACCEPTS: exactly root-relative paths — `/settings`, `/admin/users?tab=1`.
 * WHAT IT REJECTS: everything else, including `//host` (protocol-relative),
 * `https://…`, `javascript:…`, and bare relative paths like `settings`, which
 * would resolve against whatever route the user happens to be on and so mean
 * something different depending on where they clicked from.
 */
export function isInternalLink(link: string | null | undefined): link is string {
  if (typeof link !== 'string' || link === '') return false;
  // `//` is checked SECOND but rejects first in effect: a protocol-relative URL
  // also starts with a single `/`, so testing only the leading slash would let
  // `//evil.example` through as "root-relative".
  return link.startsWith('/') && !link.startsWith('//');
}
