# Settings UI: The Registry-Driven Hub

> Epic #90, issues #91–#96. Implemented in
> `apps/web/src/config/adminSections.tsx` (`ADMIN_SECTIONS`),
> `apps/web/src/config/userSettingsSections.tsx` (`USER_SETTINGS_SECTIONS`),
> and `apps/web/src/components/settings/SettingsHub.tsx`, with two thin
> per-surface bindings, `apps/web/src/pages/Admin/SettingsHubPage.tsx` and
> `apps/web/src/pages/UserSettingsHubPage.tsx`. Console mode (the rail
> swapping its contents on `/admin/*`) lives in
> `apps/web/src/components/navigation/NavigationRail.tsx`; the compact
> drill-down title and back button live in
> `apps/web/src/components/navigation/AppBar.tsx`. The visible pattern this
> document explains the reasoning for — every new settings page is a card in
> one of the two registries above, not a route left to find its own way — is
> stated as a rule in `CLAUDE.md`'s "MANDATORY: Settings UI Pattern" section.
> This document is the *why*; it does not restate the rules there.
>
> Update, issue #366: the three cards §1 describes as epic #90's worked
> example — System, Feature Flags, Advanced (JSON) — and the `ui`/`features`
> system-settings namespaces behind them were removed outright as unused
> once split into cards. §1 and §3's table are kept as **history**: the
> tab-vs-card reasoning they explain is still the rule, even though none of
> those three specific cards exists any more.

The admin console and the per-user `/settings` surface both used to be
tab-strip pages — `SystemSettingsPage` with three tabs, `UserManagementPage`
with two — plus a separate hand-maintained list of sidebar destinations in
`config/destinations.ts`. Epic #90 replaces both with one searchable,
permission-gated **hub** per surface, built from a declarative registry that
every consumer reads instead of each keeping its own opinion.

## Why this shape, and not the obvious one

The failure this fixes already had a name and a fix one layer down. Issue #55
(epic #51) found that the app's *top-level* navigation — Home, Settings,
Console — used to be spelled out independently in `App.tsx`, `Sidebar.tsx`,
`UserMenu.tsx` and `home/QuickActions.tsx`, each with its own permission
check. `config/destinations.ts`'s own header records the concrete casualty:
"a Contributor holding `system_settings:read` ended up with a working System
Settings page, a menu entry pointing at it, and no sidebar row: three gates,
three answers." `destinations.ts` fixed that for the four top-level
destinations by making the sidebar, the bottom bar and the user menu all read
one `DESTINATIONS` array through one `isDestinationVisible` predicate.

Epic #90 is the same fix applied one level down, inside `/admin/settings` and
`/settings` themselves. Before it, a new settings page meant adding a route in
`App.tsx`, a tab in whichever tab-strip page it semantically belonged to
(often none, since the tab strips were arbitrary groupings to begin with),
and remembering to add it to the rail if the rail had any admin-specific
content — and nothing tied those together. `adminSections.tsx`'s header
states the failure this produces precisely: **a route added without a
registry entry is one the hub, the Console rail, and the AppBar title
resolver all disagree about, because none of the three has any way to know it
exists.** A page reachable by URL but invisible to the hub's search, missing
from the rail's Console mode, and defaulting to the bare hub title in the
compact AppBar is not a hypothetical — it is exactly what happens the moment
a contributor treats `App.tsx` as the whole surface.

So `ADMIN_SECTIONS` and `USER_SETTINGS_SECTIONS` are declared once each, and
three consumers read them rather than maintaining their own list:

1. **The hub** (`SettingsHub.tsx`, rendered by `SettingsHubPage.tsx` and
   `UserSettingsHubPage.tsx`) — the card grid at `sm` and up, the drill-down
   list below it.
2. **The Console rail** (`NavigationRail.tsx`) — on any `/admin/*` route, the
   expanded rail swaps its contents for the same admin sections, promoting
   the hub's cards into persistent navigation.
3. **The AppBar's title resolver** (`AppBar.tsx`'s `resolveDrillDown`, backed
   by `adminSections.tsx`'s `settingsPageTitle`) — resolving the current
   pathname to the compact header's title and its "up" destination.

`visibleSettingsSections` (permission and search filtering) and
`settingsPageTitle` (pathname → title) are exported from `adminSections.tsx`
and called by all three surfaces, and by the user-settings surface too —
`userSettingsSections.tsx` declares no functions of its own, only data, for
exactly the reason its own header gives: two copies of the permission gate is
the drift the registry exists to prevent, and copying it to serve a second
surface would reintroduce that drift on day one. A card added to
`ADMIN_SECTIONS` appears in the hub, the rail and the title resolver from one
edit; a card no consumer can see because it exists in none of them is
structurally impossible, not merely disciplined against.

## 1. Rejected: tabs for hierarchical content

`SystemSettingsPage`'s three former tabs — UI Settings, Feature Flags,
Advanced JSON — are epic #90's worked example of the mistake, and it is worth
being honest about why the tab strip looked reasonable before it looked
wrong. All three tabs lived under one "Settings" umbrella that an admin was
already inside; a tab strip meant one route, one page load, and instant
switching between them, which is a real and often-correct pattern — it is
exactly the pattern `UsersPage.tsx` still uses for Users/Allowlist today (see
§2). Nothing about a `<Tabs>` component is wrong in the abstract.

What made it the wrong tool here shows up the moment the three tabs are
compared to what they actually became as separate cards. Once split by epic
#90 (before all three were later removed as unused by issue #366),
**System** and **Feature Flags** both gated on
`system_settings:read`, but **Advanced (JSON)** gated on
`system_settings:write` — a stricter, different permission, because it is a
raw editor over the whole settings document and read-only access to it has no
meaning (a user who cannot save has nothing to do there the typed pages do
not do better). A shared
`<Tabs>` strip has no per-tab permission primitive: making that distinction
inside one tab-strip page would mean either showing a tab a read-only admin
cannot use, or hand-rolling a second, page-local gate that duplicates exactly
the reachability check the registry now gives every card for free. The three
tabs were never three views of one question the way Users/Allowlist are —
they were three unrelated settings surfaces (general config, feature toggles,
a raw document editor) that happened to be filed under one page because
nobody had anywhere else to put them. That is hierarchical content — three
separate destinations — wearing a tab strip built for parallel content, and
it also meant none of the three could be deep-linked, found by the hub's
search, or promoted into the Console rail on its own: the tab strip hid three
destinations behind one route the way an un-registered route hides a page
from the hub today.

## 2. The destination-gate vs. tab-gate distinction

Tabs did not go away — `UsersPage.tsx` (`/admin/settings/users`) still keeps
its two, Users and Allowlist, and epic #90 kept them on purpose. The
distinction that decides which pattern applies is stated precisely in
`UsersPage.tsx`'s own header and worth stating again here because it is the
rule, not an exception to it:

- A **destination** gate — which registry card exists, which route it
  points at — is about **reachability**: can this user get to this page at
  all.
- A **tab** gate — inside one already-reached page — is about **content**:
  given that the user is here, which parts of what they see can they use.

Users and Allowlist are genuinely parallel: both answer "who may use this
application," both are read from `UsersPage.tsx`, and they are backed by two
different controllers on purpose. The page-level (destination) gate is
`users:read` — the permission that makes the page worth reaching at all. The
Allowlist *tab* then gates itself separately, wrapping `<AllowlistTable />`
in `<RequirePermission permission="allowlist:read">`, because that data comes
from `allowlist.controller.ts` and not `users.controller.ts`. Collapsing the
two gates into one would do one of two wrong things: hide the whole page
(including the Users tab) from an admin who holds `users:read` but not
`allowlist:read`, or render an Allowlist tab that can only ever 403. Keeping
them separate means a `users:read`-only admin reaches the page and sees
Users; the Allowlist tab renders its own permission-denied message in place,
scoped to the one thing they cannot see.

The test this distinction has to survive is not "do these two things sound
related" but "are they the same controller's data, or genuinely orthogonal
views with independent permission stories that both belong once the user is
already on the page." System/Feature Flags/Advanced (JSON) failed that test
three ways (three controllers-worth of unrelated settings, three permission
stories, no shared subject); Users/Allowlist passes it (one subject — access
control — two controllers, two permissions, both worth showing on the same
screen).

## 3. Permissions are mirrored, never invented

Rule 3 in `CLAUDE.md` requires a card's `permission` field to be the literal
string its controller enforces. This is checked against the running
controllers below, not assumed:

| Registry permission | Controller / decorator |
|---|---|
| `system_settings:read` (GET) / `system_settings:write` (PUT/PATCH) | `system-settings.controller.ts` — `@Auth({ permissions: [PERMISSIONS.SYSTEM_SETTINGS_READ] })` / `SYSTEM_SETTINGS_WRITE` |
| `users:read` | `users.controller.ts` — `@Auth({ permissions: [PERMISSIONS.USERS_READ] })` |
| `allowlist:read` | `allowlist.controller.ts` — `@Auth({ permissions: [PERMISSIONS.ALLOWLIST_READ] })` (gates the Allowlist **tab**, not the `Users & Allowlist` route — see §2) |
| `jobs:read` | `jobs/job-admin.controller.ts` — `PERMISSIONS.JOBS_READ` |
| `nodes:read` | the worker-node admin controller — `PERMISSIONS.NODES_READ` |
| `db_backup:read` | the database-backup controller — `PERMISSIONS.DB_BACKUP_READ` |
| `broadcasts:read` | `notifications/broadcasts/broadcasts.controller.ts` — `PERMISSIONS.BROADCASTS_READ` |

The reason this has to be a mirror and never an invented string is what a
registry is *for*: the hub, the rail and the title resolver decide whether a
card is worth showing purely from `hasPermission(card.permission)`, with no
API round trip. If the string drifted from what the controller actually
enforces, the registry's answer to "can this user reach this page" would stop
meaning anything — either hiding a page from someone the API would happily
serve, or worse, showing a card whose click leads straight into a `403` the
UI never warned about. `roles.constants.ts` is deliberately the single
source both sides read from (the controllers via `PERMISSIONS.*`, and this
document's table via the same names), which is what makes "mirrored, never
invented" a checkable claim rather than a promise. Two consequences of taking
this literally, both already true of the live registry:

- **Read and write are gated separately**, and only the read permission ever
  appears as a card's own `permission`. (`Advanced (JSON)` was the one
  exception, gating on `system_settings:write` because a read-only visit had
  nothing to do there (§1) — moot since issue #366 removed the card.) Every
  write action a current card leads to (saving Notifications, retrying a
  job, revoking a node credential, restoring a backup) is gated **inside**
  the page by disabling controls, not by a second, stricter card permission —
  the card gate is about reachability, not about every action the page can
  perform once reached.
- **A permission split at the API is never re-merged in the registry.**
  `nodes:read` is deliberately not `jobs:read`, and `db_backup:read` is
  deliberately not `system_settings:read`, even though a shared permission
  would have been less registry ceremony — `roles.constants.ts` keeps them
  apart so a deployment can grant one without the other, and a card gated on
  the wrong one would silently offer (or silently withhold) access the API
  disagrees about.

## 4. Every new surface reuses `SettingsHub`, parameterised

`SettingsHub.tsx` takes `sections`, `hubKey`, `title` and `subtitle` as props
and names neither surface internally — its own header states the reason
directly: a second hub built by copying the first "is precisely the failure
epic #90 was filed to remove," the identical argument
`visibleSettingsSections` makes for taking `sections` as a parameter instead
of closing over `ADMIN_SECTIONS`. `UserSettingsHubPage.tsx` is the worked
example: a four-prop binding with no rendering logic of its own, contributing
only the registry, a scroll-restoration key namespaced so the two hubs never
clobber each other's scroll offset, and surface-specific prose. Its own
header is explicit that this must stay true: "a hub COPIED from the admin one
would duplicate two responsive treatments and an empty state: four places to
fix every future bug."

## 5. The five coupled breakpoint gates

Five places in the shell decide, independently, whether the viewport is
"compact" (below Material 3's `sm` / 600px compact–medium boundary). All five
must move together, and `Layout.tsx` carries the canonical list in its own
comment:

1. `Layout.tsx`'s `showRail = useMediaQuery(theme.breakpoints.up('sm'))` —
   mounts or unmounts `NavigationRail` entirely.
2. `BottomNav.tsx`'s own `useMediaQuery(theme.breakpoints.down('sm'))`
   self-gate — belt-and-braces alongside (1): `Layout` only mounts
   `BottomNav` when `!showRail`, and `BottomNav` returns `null` itself if
   somehow rendered outside that width, so its hooks still run at every width
   but its output never does at the wrong one.
3. `Layout.tsx`'s `<main>` padding, `pb: { xs: 10, sm: 3 }` — clears the
   fixed bottom bar, and only needs to below the same width the bar exists
   at.
4. `SettingsHub.tsx`'s `isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'))`
   — chooses the drill-down list over the card grid.
5. `AppBar.tsx`'s `isCompactWindow`, the same expression — chooses the
   back-arrow-plus-resolved-title header over the normal wordmark toolbar.

### Why `sm` (600px), never `md` (900px)

`Layout.tsx` states this directly and it is worth repeating precisely because
it is the boundary a contributor is likeliest to want to "fix" without
checking here first: 600px is Material 3's own compact/medium window-class
boundary (compact `< 600dp`, medium `600–840dp`), and M3 is explicit that a
permanent rail — not a bottom bar — is the correct chrome from medium
upward. Gating at MUI's `md` (900px) instead would hand the **phone**
treatment to every 600–899px device: an iPad in portrait (768px), an iPad
Pro 11" (834px), an unfolded foldable, and a phone in landscape all fall in
that band. None of those is a phone-sized surface, and a bottom bar plus a
drill-down settings list on any of them would be visibly wrong chrome for
the available width, not a subtle regression.

### Why there is deliberately no shared constant

The honest answer to this — the thing `CLAUDE.md` explicitly defers to this
document — turned out to be more specific than "these are different kinds of
decisions that happen to share a number," and it is worth being precise about
what the code actually shows rather than restating that generality. Reading
all five call sites side by side:

Four of the five — (1), (2), (4) and (5) — are **structurally identical**:
each is a call to `useMediaQuery(theme.breakpoints.up('sm'))` or
`.down('sm')` inside a component, and each is a hook whose *return value*
gates a rendering branch. A shared constant across those four would be
trivial to introduce and would cost nothing.

The fifth, `Layout.tsx`'s `pb: { xs: 10, sm: 3 }`, is not that shape at all.
It is not a `useMediaQuery` call — it is a literal object passed to MUI's
`sx` prop, where `xs` and `sm` are **object keys** that MUI's own responsive-
value system reads and turns into media queries internally. `Layout.tsx`'s
own comment states the consequence exactly: *"there is deliberately no shared
constant, because a constant would let (3) drift while still compiling."*
Read against the code, that sentence is about this exact asymmetry. A
constant extracted from the four `useMediaQuery` call sites can bind (1),
(2), (4) and (5) together — they all *call* something with the breakpoint
name as an argument, so a shared identifier there is a normal refactor. Member
(3) is a **key in an object literal**, not an argument to a call; folding it
into the same constant needs a computed property (`{ xs: 10, [BREAKPOINT]: 3 }`)
that nothing forces a future edit to use, and TypeScript raises no error
either way — a `pb: { xs: 10, sm: 3 }` that quietly stops matching a renamed
`BREAKPOINT` elsewhere in the file is exactly as valid, and exactly as
silent, as it is today. In other words: a shared constant would not bind all
five gates together at all — it would bind four of them, produce the
appearance that the fifth is covered too, and leave the one member most
different in kind (a spacing value, not a mount decision or a rendering
switch) exactly as free to drift as it is now, except now behind a false
sense of enforcement.

So the code supports a narrower and more useful claim than "no constant
because these are different concepts": it specifically identifies which
member a constant would fail to keep honest, and why — (3) is expressed in a
vocabulary (an `sx` breakpoint-object key) that a JS/TS constant cannot
reach as naturally as a function argument can. The comment's actual guard is
the enumerated checklist and the instruction to check all five by hand,
because the one member most likely to be forgotten is also the one a shared
symbol would not have protected regardless.

## 6. Accessibility requirements

Read directly out of `SettingsHub.tsx` and `NavigationRail.tsx`, rather than
asserted:

- **The search field's accessible name is explicit**, not left to the
  placeholder: `SettingsHub.tsx` sets `aria-label="Search settings"` on the
  input, because a placeholder disappears the moment the user types,
  taking the only announced name with it.
- **The clear-search button only renders when there is something to
  clear.** A permanently mounted clear button on an empty field is a dead
  tab stop that announces an affordance and does nothing.
- **The compact/expanded choice is made by mounting, never by rendering
  both and hiding one with CSS.** Both `SettingsHub.tsx` (list vs. grid) and
  `Layout.tsx` (rail vs. bottom bar) follow this rule: a hidden duplicate
  doubles the DOM, doubles the tab order with targets a keyboard user can
  reach but not see, and gives any `aria-current` two owners.
- **An inert ("Coming soon") card is not a tab stop.** `SettingsHub.tsx`
  renders it with no `CardActionArea` at all in the grid, and as a
  `disabled` `ListItemButton` in the drill-down — never a focusable control
  whose activation does nothing.
- **`NavigationRail.tsx`'s landmark names which mode it is in.** The
  `<nav>`'s `aria-label` is `"Console navigation"` in Console mode and
  `"Main navigation"` otherwise, because the rail's *contents* are entirely
  different between the two and a screen-reader user has no other way to
  tell which set of pages they are looking at.
- **`aria-current="page"` is a single source of truth**, computed from the
  destination/console-active-path model rather than a per-row guess, so
  exactly one row ever claims it.
- **A row's accessible name is stated explicitly**, not derived from its
  visible (possibly abbreviated) label — `RailRow`'s `accessibleName` prop
  carries the full name even when the visible caption is a truncated
  `compactLabel`, and the caption itself is `aria-hidden` so assistive
  technology reads the full name once, not the abbreviation plus the name.
- **A tooltip supplements, never substitutes.** `NavigationRail.tsx` wraps a
  collapsed row's abbreviated caption in a `Tooltip`, but only where the
  visible text is genuinely shortened, and never as the row's only carrier
  of its full name — a tooltip reaches neither a screen reader reliably nor
  a keyboard-only user at all.
- **Keyboard focus is visible on every navigation control**, stated
  explicitly as a `&.Mui-focusVisible` outline in `NavigationRail.tsx`
  rather than left to the theme's default, which a later theme change could
  quietly drop.
- **The collapse toggle is a real `<button>` with `aria-expanded`**, not an
  icon-shaped `div` or a link masquerading as a button.

## 7. The visual harness must learn every new card's permission

`apps/web/visual/main.tsx`'s `DEFAULT_PERMISSIONS` is a separate, manually
maintained list of permission strings — broad enough to see every card in
both registries — that seeds the fake authenticated user the Playwright
visual-regression suite renders against. It is not derived from
`ADMIN_SECTIONS` or `USER_SETTINGS_SECTIONS`; it is copied by hand. A card
whose `permission` is new and not yet in that list is invisible to the
harness: `visibleSettingsSections` filters it out for the fake user exactly
as it would for a real one lacking the permission, so the hub the harness
screenshots simply has one fewer card than the real one — and the pixel
baselines pass green over a layout the suite is no longer actually looking
at. This is not hypothetical: it is called out in `DEFAULT_PERMISSIONS`'s own
comment as the failure the Operations group's five permissions
(`jobs:read`/`write`, `nodes:read`/`write`, `db_backup:read`/`write`/
`restore`) were added to prevent — "a card the harness cannot see is a card
this suite silently stops asserting pixels for." Any change that adds a new
`permission` string to either registry must add it to
`DEFAULT_PERMISSIONS` in the same change, or the baselines are testing a
smaller grid than the one that ships.

## Rejected alternatives

- **A second, admin-specific hub component, hand-rolled for `/settings`
  later.** Rejected before it was ever built: `SettingsHub.tsx` is
  parameterised from its first commit specifically so the user-settings
  surface (#96) never has cause to fork it. Two near-identical hubs is not a
  hypothetical risk here — it is the literal shape of the pre-epic-#90
  navigation split-brain, one layer down.
- **Gating destinations and cards by role instead of by permission.**
  Rejected in both registries' headers for the same reason `destinations.ts`
  rejects it: a role check is exactly what produced the original
  three-gates-three-answers split-brain, because "is this user an Admin"
  and "does this user hold `system_settings:read`" can and do diverge the
  moment permissions are assigned outside the default role templates.
- **`md` (900px) as the compact/expanded boundary**, matching MUI's own
  default breakpoint name most contributors reach for first. Rejected
  because it is not what Material 3 actually specifies for this transition,
  and because it visibly misclassifies the 600–899px band (see §5).
- **A shared constant for the five breakpoint gates.** Rejected — see §5.
  Not because uniformity is undesirable, but because the one member most
  likely to be forgotten (`Layout.tsx`'s `pb` object key) is also the one a
  constant would not mechanically enforce, so a constant would trade a
  checklist a reviewer has to run through for a false sense that the
  compiler is already doing it.

## Verification

| Claim | Where it is asserted |
|---|---|
| `visibleSettingsSections` drops a card whose permission is not held, and drops an emptied section entirely rather than rendering a bare header | `apps/web/src/__tests__/config/settingsRegistry.test.ts` |
| Search matches a card's title only, never its description, and composes with the permission gate | `settingsRegistry.test.ts` |
| `settingsPageTitle` gives the longest matching card path the win, respects segment boundaries, and falls back to the hub title | `settingsRegistry.test.ts` |
| A newly-added card (Notifications #225, Broadcasts #325) is declared with the exact permission its controller enforces, is not an `alwaysShow` escape hatch, and appears/disappears across the hub, rail and title resolver together | `settingsRegistry.test.ts` |
| `/admin/settings`'s own route gate matches `console`'s `anyPermission` in `destinations.ts` byte for byte | `apps/web/src/__tests__/config/destinations.test.ts` |
| No route in `App.tsx` is claimed by two destinations, and every declared route is either owned or explicitly listed as unowned | `destinations.test.ts` |
| The hub renders the correct cards for a permission-limited user, navigates on click, and shows the grid vs. drill-down treatment at the right width | `apps/web/src/__tests__/components/settings/SettingsHub.test.tsx` |
| The admin hub and the user hub restore independent scroll offsets | `SettingsHub.test.tsx` |
