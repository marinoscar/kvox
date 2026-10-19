/**
 * The destination model — canonical keys and route ownership.
 *
 * Issue #484, epic #478: the shell that draws these is the platform's
 * (`@marinoscar/platform-web/shell`). This file stays the app's SINGLE source of
 * truth for WHAT the navigation is; `config/shell.ts` binds it, with the admin and
 * user settings registries, into the `ShellNavigation` the shell takes. Route
 * matching (`owns`, `resolveActiveDestination`) and visibility
 * (`isDestinationVisible`) are the package's, so every surface asks one function.
 * The packaged bottom bar draws pinned destinations too (at the end, and it
 * overflows into "More"), so this app keeps its rule that the phone bar never
 * carries a mode by giving the bar the non-pinned destinations
 * (`BOTTOM_BAR_DESTINATIONS`, which `KvoxAppShell` derives with `withoutPinned`).
 * The navigation itself is composed by `createKvoxNavigation`
 * (`@marinoscar/kvox-web/shell`, issue #629): this file adds Home, Settings and
 * Console to the rows the slices declare.
 *
 * Issue #55, epic #51.
 * Issue #55, epic #51. This file is the SINGLE source of truth for the app's
 * navigation targets. Before it existed the same four menu paths were spelled
 * out in four places (`App.tsx`, `Sidebar.tsx`, the user menu,
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
 * foot (#105) at `sm` and up, and listed in the avatar menu at every width.
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
 *
 * KNOWLEDGE IS A DESTINATION; SETTINGS IS A MODE (issue #438)
 * -----------------------------------------------------------
 * `/graph` and `/ask` used to be OWNED BY `home` (#373, #380; ontology spec
 * §13): the bar was at its four-tab ceiling, so the knowledge graph was reached
 * from Home's "Knowledge" section, a named speaker's chip and library search
 * hits — never from a tab. That made the product's third primary noun one tap
 * below a row named after something else, which is exactly the debt #106 paid
 * back for Notes. #438 reverses §13's decision: `knowledge` is its own
 * destination, owning `/graph` (index, entity pages, explorer, overview,
 * imports) and `/ask`.
 *
 * The ceiling did not move, so the slot came from `settings`, on the precedent
 * #106 set for Console: a user's own settings are a place you SWITCH INTO to
 * change how the app behaves, not a body of content you page between, and they
 * already had better homes than a bar tab — the rail's foot at `sm` and up and
 * the avatar menu at every width. Marking `settings` `pinned` keeps exactly
 * four NON-PINNED destinations — Home · Transcripts · Notes · Knowledge.
 *
 * Knowledge is also the first destination gated on a RUNTIME FEATURE as well as
 * a permission (`feature: 'graph'`): a deployment with connected knowledge
 * switched off (`ai.graphEnabled`, read from `GET /api/ai-tasks/config`) has no tab
 * for it, and the bar falls back to three. The routes stay reachable and stay
 * owned by `knowledge` either way — ownership answers "what lights up", not
 * "what is drawn".
 */

import type { ShellDestination } from '@marinoscar/platform-web/shell/headless';
import HomeIcon from '@mui/icons-material/Home';
import { createKvoxNavigation } from '@marinoscar/kvox-web/shell';
import SettingsIcon from '@mui/icons-material/Settings';
import AdminIcon from '@mui/icons-material/AdminPanelSettings';

export type DestinationKey =
  | 'home'
  | 'transcripts'
  | 'notes'
  | 'knowledge'
  | 'settings'
  | 'console';

/**
 * One navigation destination of this app: the packaged shell's `ShellDestination`
 * over this app's keys (issue #484, epic #478). `label`, `compactLabel`, `Icon`,
 * `path`, `permission`, `anyPermission`, `pinned` and `feature` are the shell's
 * fields; `feature: 'graph'` is the `graph` settings feature
 * (`config/settingsFeatures.ts`), so the shell hides the row until connected
 * knowledge is known to be on.
 */
export type Destination = ShellDestination<DestinationKey>;

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
 * This app's own destinations: the ones the packaged slices do not declare. Unpinned
 * ones lead the navigation (Home), pinned ones close it (Settings, then Console).
 */
const APP_DESTINATIONS: readonly ShellDestination<'home' | 'settings' | 'console'>[] = [
  {
    key: 'home',
    label: 'Home',
    compactLabel: 'Home',
    Icon: HomeIcon,
    path: '/',
  },
  {
    key: 'settings',
    label: 'User Settings',
    compactLabel: 'Settings',
    Icon: SettingsIcon,
    path: '/settings',
    // A MODE since #438, on #106's Console precedent — see the file header.
    // Declared BEFORE `console`, so the rail's foot reads Settings then Console:
    // every user's own settings first, the operator surface only some users
    // have last, and a non-admin's foot is just Settings under its divider.
    pinned: true,
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
 * The navigation of this app (`@marinoscar/kvox-web/shell`, issue #629): Home,
 * then the slices' own rows (Transcripts, Notes, Knowledge), then the pinned
 * Settings and Console. The slice rows, their gates (`transcripts:read`,
 * `notes:read`, `graph:read` plus `feature: 'graph'`) and their route prefixes are
 * the slices' data; this file contributes Home, Settings and Console and the
 * prefix the Console owns.
 */
const KVOX = createKvoxNavigation<'home' | 'settings' | 'console'>({
  extra: APP_DESTINATIONS,
  // Console navigates to `/admin/settings` and owns the whole `/admin` subtree.
  extraRoutes: { home: ['/'], settings: ['/settings'], console: ['/admin'] },
});

/**
 * The six destinations, in navigation order: Home, Transcripts, Notes,
 * Knowledge, Settings, Console (composed by `createKvoxNavigation` above).
 *
 * FOUR NON-PINNED DESTINATIONS IS THE BOTTOM BAR'S CEILING, and since #106 the
 * app sits exactly at it BY DESIGN rather than by coincidence. Five labelled
 * tabs do not fit at 360px; four do. Settings and Console are the last two
 * entries here, and both are `pinned` — modes (#106 for Console, #438 for
 * Settings) — so neither enters `BOTTOM_BAR_DESTINATIONS` at all. A fifth NON-PINNED destination is therefore
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
 *   - `graph-read.controller.ts`      → `graph:read`
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
export const DESTINATIONS: readonly Destination[] = KVOX.navigation.destinations as readonly Destination[];

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
export const DESTINATION_ROUTES: Readonly<Record<DestinationKey, readonly string[]>> =
  KVOX.navigation.destinationRoutes as Readonly<Record<DestinationKey, readonly string[]>>;

/**
 * The destinations the phone bottom bar draws — every NON-PINNED one.
 *
 * A DERIVED LIST, never a second hand-written array. The bar's ceiling is four
 * actions; the model's promise since #106 is that exactly four destinations are
 * non-pinned, and deriving the bar's list from the flag is what makes the two
 * statements the same statement. A hand-maintained copy would let a fifth tab
 * appear silently the day someone adds a destination and forgets this file.
 *
 * The packaged bottom bar still filters this by permission and by the `graph`
 * feature on top — a user sees at most four tabs and possibly fewer (three with
 * connected knowledge off), and never a "More" tab, because the list never
 * exceeds the bar's default of four.
 */
export const BOTTOM_BAR_DESTINATIONS: readonly Destination[] =
  KVOX.bottomBarNavigation.destinations as readonly Destination[];
