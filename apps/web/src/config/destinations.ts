/**
 * The destination model — canonical keys, route ownership, and active state.
 *
 * Issue #55, epic #51. This file is the SINGLE source of truth for the app's
 * navigation targets. Before it existed the same four menu paths were spelled
 * out in four places (`App.tsx`, `Sidebar.tsx`, `UserMenu.tsx`,
 * `home/QuickActions.tsx`, deleted by #32), each with its own idea of who was allowed to see
 * them — which is how a Contributor holding `system_settings:read` ended up
 * with a working System Settings page, a menu entry pointing at it, and no
 * sidebar row: three gates, three answers.
 *
 * Two rules make the ownership table trustworthy:
 *
 *  1. **A route is owned by at most one destination.** A test asserts this
 *     against the live route list in `App.tsx`, which is what keeps the table
 *     honest as routes are added — it fails loudly the day someone adds a
 *     route and forgets this file.
 *  2. **Matching respects segment boundaries.** A bare `startsWith` — what
 *     `Sidebar` used to do — would make `/settings` own `/settingsfoo` and
 *     `/admin/users` own `/admin/users-archive`.
 *
 * `Icon` is declared as a COMPONENT, never as a rendered element. The rail
 * draws it at `small` when collapsed and `medium` when expanded, and the
 * bottom bar draws it at its own size — so the size cannot be baked in here.
 *
 * ONE ADMIN DESTINATION, NOT TWO (issue #92, epic #90)
 * ----------------------------------------------------
 * `users` (`/admin/users`) and `system` (`/admin/settings`) used to be two
 * separate rows for what is, to the user, one surface. Issue #92 splits the
 * admin tab strips into one route per settings page under `/admin/settings/*`,
 * and #94 gives the rail a Console mode that swaps its contents to those pages
 * on any `/admin/*` path. Console mode is only coherent if the admin surface is
 * ONE destination: two rows both matching `/admin/*` means two `aria-current`
 * candidates and an ambiguous active state on every admin route. So the two are
 * replaced by a single `console` destination that owns the whole `/admin`
 * subtree.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import HomeIcon from '@mui/icons-material/Home';
import LibraryBooksIcon from '@mui/icons-material/LibraryBooks';
import SettingsIcon from '@mui/icons-material/Settings';
import AdminIcon from '@mui/icons-material/AdminPanelSettings';

export type DestinationKey = 'home' | 'library' | 'settings' | 'console';

/**
 * Does `prefix` own `path`? True when the path equals the prefix or continues
 * with a `/`. `'/'` matches only itself — every path starts with it, so the
 * root has to be exact or Home would own the entire app.
 */
export function owns(prefix: string, path: string): boolean {
  if (prefix === '/') return path === '/';
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Route prefixes each destination owns. Child routes are covered by their
 * parent prefix (`/admin/settings/users`, `/settings/profile`, …) and do not
 * need their own entries.
 *
 * `console` owns the bare `/admin` rather than `/admin/settings`, even though
 * `/admin/settings` is where it NAVIGATES. The two are different questions:
 * `path` is where the row sends you, `DESTINATION_ROUTES` is what makes the row
 * light up. `/admin/users` still exists as a redirect route (#92) and a
 * bookmark still lands on it for one render — with only `/admin/settings` in
 * this list that render would highlight nothing, and the route-ownership test
 * would fail it as "neither owned nor deliberately unowned".
 */
export const DESTINATION_ROUTES: Record<DestinationKey, readonly string[]> = {
  home: ['/'],
  // TWO PREFIXES, ONE DESTINATION (#57, epic #45). `/transcripts` owns its
  // whole subtree (the library, `/transcripts/new`, `/transcripts/:id` and
  // `/transcripts/:id/history` — #30, #31, epic #19) and `/notes` owns its own
  // (`/notes`, `/notes/new`, `/notes/:id`, `/notes/:id/history`).
  //
  // ⚠ THE SECOND PREFIX IS WHY THE DESTINATION WAS RENAMED RATHER THAN A FIFTH
  // ONE ADDED. Four is the bottom bar's ceiling — see `DESTINATIONS` below and
  // `BottomNav`'s header — so `notes` could not become a fifth tab without
  // redesigning that bar. It should not have been one anyway: a transcript and
  // the note derived from it are two answers to one question ("what do I
  // have"), which is the same parallel-content judgement
  // `LibraryPage`'s own Transcripts | Notes tabs make one level down, and the
  // same one its Mine | Shared tabs make one level below that.
  //
  // One entry per prefix and not one merged regex, because both are the same
  // destination as far as "which tab is lit" is concerned: a reader drilled
  // into one transcript, or watching one note being written, has not left the
  // library.
  library: ['/transcripts', '/notes'],
  settings: ['/settings'],
  console: ['/admin'],
};

/**
 * Routes deliberately owned by NO destination.
 *
 * These are reached from outside the authenticated shell entirely — the login
 * flow, the OAuth round trip, the device-activation screen — and most do not
 * even mount `Layout`. **On these routes no destination renders as active, and
 * that is correct rather than a bug.** Exported so a test can assert it
 * explicitly, which is what stops a future contributor from "fixing" it into
 * highlighting something arbitrary.
 */
export const UNOWNED_ROUTES: readonly string[] = [
  '/login',
  '/auth/callback',
  '/activate',
  '/testing/login',
];

/**
 * A navigation destination, fully described for every surface that draws it.
 *
 * `permission` is the API permission that makes the destination REACHABLE, and
 * it is deliberately the same string the corresponding controller enforces —
 * see the comments on each entry. A destination with no `permission` and no
 * `anyPermission` is available to every authenticated user.
 */
export interface Destination {
  key: DestinationKey;
  /** Full label — the expanded rail, the bottom bar, the user menu. */
  label: string;
  /** Shown in the 56px collapsed rail, which will not hold "System Settings". */
  compactLabel: string;
  Icon: SvgIconComponent;
  path: string;
  /** API permission required to reach it; absent means "any authenticated user". */
  permission?: string;
  /**
   * Reachable when the user holds ANY ONE of these permissions.
   *
   * Added by #92 for `console`, which fronts pages from two different
   * controllers: someone with `users:read` alone must reach the Users &
   * Allowlist page, and someone with `system_settings:read` alone must reach
   * the settings pages. Neither may be dropped, and the single-string
   * `permission` field cannot express "or".
   *
   * `library` is the second such destination since #57 (epic #45), for the
   * identical reason: it fronts `transcripts.controller.ts` and
   * `notes.controller.ts`, and a user entitled to only one of the two must
   * still reach the surface that holds both.
   *
   * Widening `permission` to `string | string[]` was the alternative and was
   * rejected: an array there reads as ALL by every convention in this codebase
   * (`hasAllPermissions`), so the same field would have meant "and" at one call
   * site and "or" at another. A separate field names the semantics.
   *
   * The two fields AND together when both are set — `permission` must be held
   * AND at least one of `anyPermission`. No destination sets both today; the
   * rule is stated so the day one does, `isDestinationVisible` is the only
   * place that has to know.
   */
  anyPermission?: readonly string[];
  /**
   * Render this destination pinned at the FOOT of the navigation rail, below a
   * divider, rather than inline in the destination list (#105).
   *
   * `console` is the only one today, and the flag exists so the rail never has
   * to spell `key === 'console'` in its render. A magic key there would be a
   * second, invisible answer to "what is the admin surface" — the exact
   * split-brain this file's header describes — and it would silently stop
   * being true the day the admin destination is renamed or a second mode is
   * added. Declaring it here keeps ONE place that knows Console is a MODE and
   * not a peer of the library destinations, which is what its position at the
   * foot communicates.
   *
   * RAIL-ONLY, deliberately. The bottom bar has no foot to pin to (it IS the
   * foot) and the user menu is a flat list, so both keep reading `DESTINATIONS`
   * in declaration order and ignore this flag. Ordering here therefore still
   * has to be the correct order for those surfaces.
   */
  pinned?: boolean;
}

/**
 * Is `destination` visible to a user with this `hasPermission` predicate?
 *
 * EVERY surface calls this rather than testing `destination.permission`
 * inline. Four surfaces (rail, bottom bar, user menu, quick actions) each ran
 * their own `!destination.permission || hasPermission(...)` expression, and
 * every one of them silently ignored `anyPermission` the moment it was added —
 * the `console` row would have appeared for everyone. One function is the same
 * fix this file's header describes for the paths themselves.
 */
export function isDestinationVisible(
  destination: Destination,
  hasPermission: (permission: string) => boolean,
): boolean {
  if (destination.permission && !hasPermission(destination.permission)) return false;
  if (destination.anyPermission && !destination.anyPermission.some(hasPermission)) return false;
  return true;
}

/**
 * The four destinations, in navigation order: Home, Library, Settings,
 * Console. That is the bottom bar's ceiling exactly — see `BottomNav`'s header
 * — so a fifth destination is not an addition, it is a redesign.
 *
 * ISSUE #57 (epic #45) TESTED THAT CEILING AND RENAMED RATHER THAN ADDED.
 * Notes needed a home, and `notes` as a fifth tab would have been a redesign of
 * the bottom bar to buy a WORSE information architecture — "what do I have"
 * split across two destinations, with the transcript → note relationship the
 * epic exists to create invisible in navigation. So `transcripts` became
 * `library`, owning both `/transcripts` and `/notes`, and the bar stayed at
 * four.
 *
 * Declaration order IS navigation order on every surface. The rail is the one
 * exception, and only for the tail of the list: it lifts `pinned` destinations
 * out to its foot (#105) while leaving the rest in this order.
 *
 * GATING IS BY PERMISSION, NOT BY ROLE, and the permission is the one the API
 * actually enforces — verified against the controllers rather than assumed:
 *
 *   - `users.controller.ts`           → `users:read`
 *   - `system-settings.controller.ts` → `system_settings:read`
 *   - `transcripts.controller.ts`     → `transcripts:read`
 *   - `notes.controller.ts`           → `notes:read`
 *
 * `console` AND `library` are each reachable on EITHER of their two permissions
 * (see `anyPermission`), because each fronts pages from two controllers and a
 * user entitled to only one half must still reach the surface. The per-page gates inside
 * `/admin/settings/*` are what decide which cards and routes that user actually
 * gets — `config/adminSections.tsx` declares them, and `App.tsx` wraps each
 * route in the matching `RequirePermission`.
 *
 * That is the same REACHABILITY-vs-CONTENT split this file has always drawn:
 * the Users & Allowlist page gates on `users:read` to be reached, while its
 * Allowlist half gates itself on `allowlist:read` inside the page, because its
 * data comes from `allowlist.controller.ts`.
 *
 * `isAdmin` is no longer a navigation gate anywhere. It still exists (and
 * `AdminOnly` with it) for non-navigation uses, but a role check here is what
 * produced the split-brain described in the file header.
 */
export const DESTINATIONS: readonly Destination[] = [
  {
    key: 'home',
    label: 'Home',
    compactLabel: 'Home',
    Icon: HomeIcon,
    path: '/',
  },
  {
    // Issues #30 (epic #19) and #57 (epic #45). ONE destination over two
    // route subtrees — see `DESTINATION_ROUTES.library` for why Notes is a
    // prefix here rather than a fifth row.
    //
    // ⚠ GATED ON EITHER PERMISSION, NOT ON `transcripts:read` ALONE, and the
    // pair is verified against the controllers rather than assumed:
    // `transcripts.controller.ts` carries
    // `@Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })` on its reads and
    // `notes.controller.ts` carries `PERMISSIONS.NOTES_READ` on its own. A
    // single `permission: 'transcripts:read'` here would have been the #92 bug
    // in a new place: a deployment that revoked transcripts but kept notes
    // would lose the row that is the only way to reach either.
    //
    // Both are seeded to ALL THREE roles (both controllers' headers say so:
    // recording a conversation and turning it into a note are the actions the
    // two epics exist to enable, and a new account's default role is Viewer),
    // so in practice this row is visible to everybody — but the GATE is still
    // the permissions, because a deployment that revokes both must lose the row.
    //
    // The per-TAB gate inside the page is separate and is about CONTENT rather
    // than reachability: `LibraryPage` hides the Transcripts tab from a user
    // without `transcripts:read` and the Notes tab from one without
    // `notes:read`. Exactly the split `/admin/settings` already draws between
    // its own `anyPermission` and its per-card permissions.
    key: 'library',
    label: 'Library',
    // Both fields say "Library" since #57, and the redundancy is the honest
    // state rather than an oversight: `label` is the accessible name and the
    // expanded rail's caption, `compactLabel` is what the 56px rail and a 4-up
    // bottom bar at 360px can physically draw, and "Library" fits both. The
    // fields stay distinct because `settings` still needs them to be ("User
    // Settings" / "Settings"), and because the day this label grows is the day
    // the split is load-bearing again.
    compactLabel: 'Library',
    // NOT the audio waveform this row carried while it was "Transcripts": half
    // of what it now fronts is prose the user never recorded.
    Icon: LibraryBooksIcon,
    // `/transcripts` rather than `/notes`, so the row lands on the tab the
    // destination has had since #30. A user holding `notes:read` and NOT
    // `transcripts:read` is redirected on to `/notes` by the route's own
    // fallback in `App.tsx` — the reachability the `anyPermission` above
    // promises is kept by the router, not by a second opinion here.
    path: '/transcripts',
    anyPermission: ['transcripts:read', 'notes:read'],
  },
  {
    key: 'settings',
    label: 'User Settings',
    compactLabel: 'Settings',
    Icon: SettingsIcon,
    path: '/settings',
  },
  {
    key: 'console',
    label: 'Console',
    compactLabel: 'Console',
    Icon: AdminIcon,
    path: '/admin/settings',
    anyPermission: ['system_settings:read', 'users:read'],
    // Pinned at the rail's foot (#105) — a mode, not a third library
    // destination. The permission gate above still runs first: a user who
    // cannot reach Console gets no pinned row AND no stray divider.
    pinned: true,
  },
];

/**
 * Which destination, if any, owns `pathname`.
 *
 * Longest prefix wins where prefixes overlap. `/admin` is a single prefix
 * today, so nothing under it competes — but the rule is what keeps `/` from
 * winning everything (it is handled by `owns`' exact-match case) and what will
 * keep a future sibling prefix correct without touching this function.
 */
export function resolveActiveDestination(pathname: string): DestinationKey | null {
  let best: { key: DestinationKey; length: number } | null = null;

  for (const [key, prefixes] of Object.entries(DESTINATION_ROUTES) as [
    DestinationKey,
    readonly string[],
  ][]) {
    for (const prefix of prefixes) {
      if (!owns(prefix, pathname)) continue;
      if (!best || prefix.length > best.length) {
        best = { key, length: prefix.length };
      }
    }
  }

  return best?.key ?? null;
}
