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
 *
 * TWO LIBRARY DESTINATIONS, NOT ONE (issue #106)
 * ----------------------------------------------
 * `library` — one row owning both `/transcripts` and `/notes`, fronting a page
 * whose Transcripts | Notes tab strip was the real navigation — is gone. It
 * existed for exactly one reason: #57 needed somewhere to put Notes, the bottom
 * bar held four actions, and `console` was occupying the fourth. Renaming
 * `transcripts` to `library` bought a fourth slot at the price of burying the
 * app's two primary nouns one tap below a row named after neither of them.
 *
 * #106 pays back that debt by moving Console OFF the bottom bar rather than
 * merging two nouns onto one row. Console is a MODE — an operator surface a
 * user switches into — and it already had a better home: pinned at the rail's
 * foot (#105) at `sm` and up, and listed in the avatar UserMenu at every width.
 * Taking it out of the bar leaves exactly four NON-PINNED destinations —
 * Home · Transcripts · Notes · Settings — which is the bar's ceiling reached BY
 * DESIGN rather than by the coincidence of which permissions a given user
 * happens to hold.
 *
 * Two alternatives were considered and rejected:
 *
 *  - **A per-surface `surfaces: ['rail', 'bar', 'menu']` field.** It generalises
 *    `pinned` into three independent booleans that must be kept mutually
 *    consistent, for a distinction this app draws exactly once. Three fields
 *    admit eight states, six of which are nonsense ("in the bar but not the
 *    menu"), and nothing would reject them. `pinned` names the one real
 *    distinction — mode versus peer destination — and each surface decides what
 *    that means for itself: the rail relocates it, the menu lists it inline, the
 *    bar omits it.
 *  - **Keeping `library` and adding `notes` as a fifth row.** Notes would then
 *    be reachable from two places that disagree about what they are (a tab
 *    inside Library, and a destination beside it), and the bar would be at five
 *    labelled actions — which does not fit at 360px, the constraint that started
 *    all of this.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import HomeIcon from '@mui/icons-material/Home';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import DescriptionIcon from '@mui/icons-material/Description';
import SettingsIcon from '@mui/icons-material/Settings';
import AdminIcon from '@mui/icons-material/AdminPanelSettings';

export type DestinationKey = 'home' | 'transcripts' | 'notes' | 'settings' | 'console';

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
  // ONE PREFIX EACH SINCE #106. Each owns its whole subtree — `/transcripts`
  // covers the library, `/transcripts/new`, `/transcripts/:id` and
  // `/transcripts/:id/history` (#30, #31, epic #19); `/notes` covers `/notes`,
  // `/notes/new`, `/notes/:id` and `/notes/:id/history` (#57, epic #45) —
  // because a reader drilled into one transcript, or watching one note being
  // written, has not left the surface they started on.
  //
  // These were a single `library: ['/transcripts', '/notes']` entry between
  // #57 and #106. Splitting them is what makes the two rows light up
  // independently; a merged entry would leave the bar highlighting the same tab
  // for both halves of the app.
  transcripts: ['/transcripts'],
  notes: ['/notes'],
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
  /** Shown in the 72px collapsed rail, which will not hold "System Settings". */
  compactLabel: string;
  Icon: SvgIconComponent;
  path: string;
  /** API permission required to reach it; absent means "any authenticated user". */
  permission?: string;
  /**
   * Reachable when the user holds ANY ONE of these permissions.
   *
   * Added by #92 for `console`, which is its ONE user today: it fronts pages
   * from two different controllers, so someone with `users:read` alone must
   * reach the Users & Allowlist page, and someone with `system_settings:read`
   * alone must reach the settings pages. Neither may be dropped, and the
   * single-string `permission` field cannot express "or".
   *
   * `library` was the second user between #57 and #106, for the same reason —
   * one row fronting `transcripts.controller.ts` and `notes.controller.ts`.
   * Splitting that row into two destinations dissolved the "or": each now names
   * the single permission its own controller enforces. The field stays, because
   * `console` still needs it and because the next surface that fronts two
   * controllers will too.
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
   * This destination is a MODE, not a peer destination — and each surface draws
   * a mode differently (#105, redefined by #106):
   *
   *   - **The navigation rail** renders it pinned at its FOOT, below a divider,
   *     rather than inline in the destination list.
   *   - **The user menu** lists it inline with the rest, because a flat menu has
   *     no foot to pin to and no room to invent a second group for one row.
   *   - **The bottom bar OMITS it entirely** (`BOTTOM_BAR_DESTINATIONS`). A bar
   *     has no foot either — it IS the foot — so there is nowhere to put a
   *     pinned row that would not read as a fifth peer destination. Console
   *     stays reachable below `sm` through the avatar menu, which is where a
   *     phone user reaches every other non-destination control.
   *
   * `console` is the only one today, and the flag exists so no surface has to
   * spell `key === 'console'` in its render. A magic key there would be a
   * second, invisible answer to "what is the admin surface" — the exact
   * split-brain this file's header describes — and it would silently stop
   * being true the day the admin destination is renamed or a second mode is
   * added.
   *
   * Ordering in `DESTINATIONS` is still the correct order for the menu, which
   * reads the array as declared. The rail lifts pinned rows to its foot and the
   * bar filters them out; neither reorders what is left.
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
 * The five destinations, in navigation order: Home, Transcripts, Notes,
 * Settings, Console.
 *
 * FOUR NON-PINNED DESTINATIONS IS THE BOTTOM BAR'S CEILING, and since #106 the
 * app sits exactly at it BY DESIGN rather than by coincidence. Five labelled
 * tabs do not fit at 360px; four do. Console is the fifth entry here and the
 * fifth row in the user menu, but it is `pinned` — a mode — so it never enters
 * `BOTTOM_BAR_DESTINATIONS` at all. A fifth NON-PINNED destination is therefore
 * not an addition but a redesign of the bar (an overflow tab, or labels off);
 * a second pinned one costs nothing here.
 *
 * WHAT #106 UNDID. Issue #57 (epic #45) needed a home for Notes, found the bar
 * already at four, and renamed `transcripts` to `library` so one row could own
 * both subtrees — with a Transcripts | Notes tab strip inside the page doing
 * the real navigating. That kept the count at four by spending the app's two
 * primary nouns on a row named after neither. #106 spends Console's bar slot
 * instead, which is the cheaper thing to give up: Console is chrome for
 * operators, reachable at the rail's foot and in the avatar menu at every
 * width, while Transcripts and Notes are what the product is for.
 *
 * Declaration order IS navigation order on every surface that draws several.
 * The rail is the one exception, and only for the tail of the list: it lifts
 * `pinned` destinations out to its foot (#105) while leaving the rest in this
 * order.
 *
 * GATING IS BY PERMISSION, NOT BY ROLE, and the permission is the one the API
 * actually enforces — verified against the controllers rather than assumed:
 *
 *   - `users.controller.ts`           → `users:read`
 *   - `system-settings.controller.ts` → `system_settings:read`
 *   - `transcripts.controller.ts`     → `transcripts:read`
 *   - `notes.controller.ts`           → `notes:read`
 *
 * `console` is the only destination reachable on EITHER of two permissions (see
 * `anyPermission`), because it is the only one that fronts pages from two
 * controllers. The per-page gates inside `/admin/settings/*` are what decide
 * which cards and routes that user actually gets — `config/adminSections.tsx`
 * declares them, and `App.tsx` wraps each route in the matching
 * `RequirePermission`.
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
    // Issue #30 (epic #19), restored to a destination of its own by #106.
    //
    // ONE PERMISSION, NOT AN `anyPermission` PAIR. This row fronts exactly one
    // controller — `transcripts.controller.ts` carries
    // `@Auth({ permissions: [PERMISSIONS.TRANSCRIPTS_READ] })` on its reads —
    // so the "or" the `library` row needed has no meaning here. A deployment
    // that revokes transcripts and keeps notes now loses this row and keeps the
    // Notes one, which is exactly the outcome `library`'s `anyPermission`
    // existed to fake with a single row.
    //
    // Seeded to ALL THREE roles (the controller's header says why: recording a
    // conversation is the action epic #19 exists to enable, and a new account's
    // default role is Viewer), so in practice this row is visible to everybody
    // — but the GATE is still the permission, because a deployment that revokes
    // it must lose the row.
    key: 'transcripts',
    label: 'Transcripts',
    // Both fields say "Transcripts", and at 11 characters it is the longest
    // compact label this app ships — which is why `RAIL_WIDTH_COLLAPSED` went
    // from 56 to 72 in #106. See `NavigationRail`'s measurement comment: a
    // 48px caption box cannot hold it, and abbreviating it to "Audio" would
    // name something other than what the row fronts.
    compactLabel: 'Transcripts',
    // The audio waveform this row carried before #57 renamed it to Library.
    // It fronts recordings again, so it gets the recording icon back.
    Icon: GraphicEqIcon,
    path: '/transcripts',
    permission: 'transcripts:read',
  },
  {
    // Issue #57 (epic #45), promoted from a tab to a destination by #106.
    //
    // ONE PERMISSION, for the same reason as its sibling above:
    // `notes.controller.ts` carries `PERMISSIONS.NOTES_READ` on its reads and
    // nothing else gates this subtree. Seeded to all three roles, same as the
    // transcript pair.
    key: 'notes',
    label: 'Notes',
    compactLabel: 'Notes',
    // A page of prose, never a waveform: a note is generated text, and half of
    // what this app holds is not something the user recorded.
    Icon: DescriptionIcon,
    path: '/notes',
    permission: 'notes:read',
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
    // A MODE, not a fifth peer destination — see `pinned`. Pinned at the rail's
    // foot (#105), listed inline in the user menu, and omitted from the bottom
    // bar entirely (#106). The permission gate above still runs first: a user
    // who cannot reach Console gets no pinned row AND no stray divider.
    pinned: true,
  },
];

/**
 * The destinations the phone bottom bar draws — every NON-PINNED one.
 *
 * A DERIVED LIST, never a second hand-written array. The bar's ceiling is four
 * actions; the model's promise since #106 is that exactly four destinations are
 * non-pinned, and deriving the bar's list from the flag is what makes the two
 * statements the same statement. A hand-maintained copy would let a fifth tab
 * appear silently the day someone adds a destination and forgets this file.
 *
 * `BottomNav` still filters this by permission on top — a user sees at most
 * four tabs and possibly fewer.
 */
export const BOTTOM_BAR_DESTINATIONS: readonly Destination[] = DESTINATIONS.filter(
  (d) => !d.pinned,
);

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
