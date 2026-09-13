/**
 * The admin (Console) settings information architecture — ONE declaration,
 * three consumers.
 *
 * Issue #91, epic #90. The admin surface used to be two tab-strip pages
 * (`SystemSettingsPage` with three tabs, `UserManagementPage` with two) plus a
 * separate list of rail destinations in `config/destinations.ts`. That is the
 * same shape of mistake issue #55 already fixed once for library navigation:
 * when the page, the menu, and the rail each keep their own list of what
 * exists and who may see it, three gates give three answers, and a user ends
 * up with a reachable page, a menu entry pointing at it, and no rail row.
 *
 * So the IA is declared here exactly once and read by:
 *
 *   1. `SettingsHubPage`            — the card grid, and the phone drill-down
 *   2. `NavigationRail` Console mode — the rail's contents on any `/admin/*`
 *   3. `AppBar`                      — resolving an admin route to its title
 *
 * "Console mode invents no new admin IA" is enforced structurally rather than
 * by convention: there is one array, so a card added here appears in all three
 * surfaces, and none of them can drift from the others.
 *
 * `Icon` is declared as a COMPONENT, never as a rendered element — exactly as
 * `config/destinations.ts` does, and for the same reason. The hub draws it at
 * 40px and the rail at ~20px, so the size cannot be baked in at declaration
 * time. Storing `<AdminIcon />` here would freeze it at the default size and
 * make every consumer clone the element to resize it.
 *
 * Why `.tsx` when the file holds no JSX: the icon values are React component
 * types, and keeping the extension consistent with the rest of the config
 * surface means adding a rendered fallback later is not a file rename.
 */

import type { SvgIconComponent } from '@mui/icons-material';
import EmailOutlinedIcon from '@mui/icons-material/EmailOutlined';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import BuildCircleOutlinedIcon from '@mui/icons-material/BuildCircleOutlined';
import VpnKeyOutlinedIcon from '@mui/icons-material/VpnKeyOutlined';
import PeopleIcon from '@mui/icons-material/People';
// Operations (#266, epic #254). One icon per card, including the two cards
// whose pages land in later issues — the card is declared now, so its icon is
// declared now; see the `Operations` section's own header.
import WorkHistoryOutlinedIcon from '@mui/icons-material/WorkHistoryOutlined';
import QueryStatsIcon from '@mui/icons-material/QueryStats';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import BackupOutlinedIcon from '@mui/icons-material/BackupOutlined';
// Broadcasts (#325, epic #319) — the one Operations card that is not a view
// onto machinery, but an action taken through it.
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';

/**
 * One settings page, fully described for every surface that draws it.
 *
 * `permission` is the API permission string the corresponding controller
 * ALREADY enforces — this registry never invents a permission, it mirrors one.
 * A card with no `permission` is visible to every authenticated user, which is
 * the normal case for the per-user registry in `userSettingsSections.tsx`.
 */
export interface SettingsCardDef {
  title: string;
  description: string;
  /**
   * The icon COMPONENT. Consumers render it themselves so each can pick its
   * own size — see the file header.
   */
  Icon: SvgIconComponent;
  /** Route the card navigates to. Absent means "declared but not yet routed". */
  path?: string;
  /** Rendered, but inert — for a page that exists in the IA but is not usable yet. */
  disabled?: boolean;
  /** API permission required to see the card at all; absent means "any authenticated user". */
  permission?: string;
  /**
   * Escape hatch: show the card even when `permission` is not held. Reserved
   * for pages that gate their own CONTENT internally and are still worth
   * reaching — the same distinction `destinations.ts` draws between a
   * REACHABILITY gate and a content gate.
   */
  alwaysShow?: boolean;
}

/** A titled group of cards — an `overline` header on the hub, a `ListSubheader` in the rail. */
export interface SettingsSectionDef {
  label: string;
  cards: SettingsCardDef[];
}

/**
 * The admin sections, in hub order.
 *
 * GATING IS BY PERMISSION, NOT BY ROLE — a role check here is what produced
 * the split-brain described in `destinations.ts`'s header. The strings are the
 * ones the API enforces:
 *
 *   - `system_settings:read`  → `system-settings.controller.ts` (GET)
 *   - `system_settings:write` → `system-settings.controller.ts` (PUT/PATCH)
 *   - `users:read`            → `users.controller.ts`
 *   - `jobs:read`             → `jobs/job-admin.controller.ts`
 *   - `nodes:read`            → the worker-node controller (#267)
 *   - `db_backup:read`        → the database-backup controller (#268)
 *   - `push:read`             → the push-config controller (#355)
 *
 * `Users & Allowlist` gates on `users:read` alone even though it hosts data
 * from two controllers (Users → `users:read`, Allowlist → `allowlist:read`).
 * That mirrors the existing destination gate: the CARD gate is about
 * reachability, and the page is worth reaching for its Users half alone; the
 * Allowlist half gates itself on `allowlist:read` inside the page.
 */
export const ADMIN_SECTIONS: SettingsSectionDef[] = [
  {
    label: 'General',
    cards: [
      {
        // Issue #124, epic #109. `system_settings:read` is the string
        // `email-settings.controller.ts` enforces on its GET, exactly as the
        // `Notifications` card below mirrors `system-settings.controller.ts` —
        // the registry never invents a permission. Saving and test-sending need
        // `system_settings:write`, which the PAGE gates internally: the card
        // gate is about REACHABILITY, and a read-only admin diagnosing "why is
        // mail broken" is worth letting in to look.
        title: 'Email',
        description:
          'Choose how the application sends email, and send a test message to prove it works.',
        Icon: EmailOutlinedIcon,
        path: '/admin/settings/email',
        permission: 'system_settings:read',
      },
      {
        // Issue #225, epic #215. `system_settings:read` is the string
        // `system-settings.controller.ts` enforces on its GET, because this
        // setting lives in the system settings document. Saving needs
        // `system_settings:write`, which the PAGE gates internally: the card gate is about REACHABILITY, and "are
        // browser notifications on for this deployment, and which events are
        // suppressed" is worth reading for anyone answering "why did nobody get
        // notified".
        title: 'Notifications',
        description:
          'Turn browser notifications on or off for everyone, and suppress individual events.',
        Icon: NotificationsActiveOutlinedIcon,
        path: '/admin/settings/notifications',
        permission: 'system_settings:read',
      },
      {
        // Issue #355. `push:read` / `push:write` is a permission pair OF ITS
        // OWN, not a reuse of `system_settings:*`: generating/rotating key
        // material has a real, described blast radius (every existing
        // subscriber goes dark until it re-subscribes) that should not ride
        // along with routine settings edits, mirroring why `broadcasts:*` and
        // `nodes:*` were split out rather than folded into
        // `system_settings:*`/`jobs:*`. `push:read` is the string
        // `push-config.controller.ts` enforces on its GET — the registry
        // never invents a permission, it mirrors one. Generating, rotating,
        // enabling/disabling and removing all need `push:write`, which the
        // PAGE gates internally: the card gate is about REACHABILITY, and "is
        // web push configured, and by whom" is worth reading for anyone
        // diagnosing why push notifications are not arriving.
        title: 'Web Push',
        description:
          'Generate a VAPID key pair, enable or rotate it, and control whether this deployment can send browser push notifications.',
        Icon: VpnKeyOutlinedIcon,
        path: '/admin/settings/push',
        permission: 'push:read',
      },
      {
        // Issue #258, epic #254. `system_settings:read` is the string
        // `common/maintenance/maintenance.controller.ts` enforces on its GET —
        // the registry never invents a permission, it mirrors one. That
        // controller deliberately adds NO permission of its own: a maintenance
        // window IS a system setting, stored in the `maintenance` namespace of
        // that row and nowhere else, so `system_settings:read` / `:write`
        // already mean exactly what this page needs them to mean.
        //
        // Opening and closing a window needs `system_settings:write`, which the
        // PAGE gates internally by disabling its controls: the card gate is
        // about REACHABILITY, and "is this deployment deliberately out of
        // service, and which layer is deciding that" is worth reading for
        // anyone answering "why is nothing working".
        title: 'Maintenance',
        description:
          'Take the application out of service for planned work, with a message for anyone who tries to use it.',
        Icon: BuildCircleOutlinedIcon,
        path: '/admin/settings/maintenance',
        permission: 'system_settings:read',
      },
    ],
  },
  {
    label: 'Access',
    cards: [
      {
        title: 'Users & Allowlist',
        description: 'Manage user accounts and roles, and control who may sign in at all.',
        Icon: PeopleIcon,
        path: '/admin/settings/users',
        permission: 'users:read',
      },
    ],
  },
  /**
   * Operations — the deployment's moving parts (issue #266, epic #254).
   *
   * A THIRD GROUP rather than more cards under `General`, because the question
   * it answers is a different one. `General` is configuration: values an
   * administrator SETS, which then sit there. These four are the running
   * system: work in flight, machines executing it, and the copy of the data
   * taken while it ran. An operator opens `General` to change something and
   * opens this group to find out what is happening — and putting the two under
   * one heading would make the twelve-card grid a single undifferentiated wall
   * exactly when someone is scanning it during an incident.
   *
   * ===========================================================================
   * ALL FOUR CARDS WERE DECLARED AT ONCE, BEFORE THEIR PAGES EXISTED
   * ===========================================================================
   *
   * `Worker Nodes` and `Database Backup` landed in later issues (#271 routed
   * the first; #287, the epic's last issue, routed the second). Both were
   * declared back in #266 anyway, `disabled: true` and with NO `path`, and the
   * reason is concrete rather than aesthetic:
   *
   * The settings hub is under visual-regression testing at
   * `maxDiffPixels: 4`. Any change to the card grid — a card added to a
   * section, a new section, a title long enough to wrap — reflows the layout
   * and requires the baselines to be regenerated inside a pinned Playwright
   * container. Adding these four cards one issue at a time means doing that
   * four times, with four chances to land a stale or mis-generated baseline,
   * and three of those regenerations would be for a grid nobody has shipped a
   * page behind yet. Declaring the whole group at once makes it ONE reflow and
   * ONE baseline regeneration for the epic.
   *
   * That reasoning is about ADDING a card, and it does not argue against
   * flipping one when its page ships: routing `Worker Nodes` (#271), and then
   * `Database Backup` (#287), changes what a card in the existing grid renders
   * — a "Coming soon" chip becomes a `CardActionArea`, and the rail gains the
   * row it was skipping — so the baselines move once more each time, for a card
   * somebody can now actually open. As of #287 no card in this group is inert,
   * which is the state the group was declared in advance to reach.
   *
   * `disabled: true` AND no `path` together, not either alone, for a card that
   * is still unbuilt. They are belt-and-braces on purpose, because the two
   * consumers treat them differently and both treatments must be right: `SettingsHub` renders an
   * inert card with a "Coming soon" chip and — importantly — no
   * `CardActionArea` at all, so the card is not a tab stop and does not ripple;
   * `NavigationRail` skips the row entirely rather than drawing a link to
   * nowhere. A card carrying a `path` to an unrouted page would instead send a
   * click to `App.tsx`'s `*` catch-all and land the operator on the home page
   * with no explanation.
   *
   * ===========================================================================
   * THE PERMISSIONS ARE THE CONTROLLERS' OWN STRINGS
   * ===========================================================================
   *
   * Per `CLAUDE.md` Settings UI Pattern rule 3, verified against the API rather
   * than assumed:
   *
   *   - `jobs:read`      → `jobs/job-admin.controller.ts` (`PERMISSIONS.JOBS_READ`),
   *                        which both Jobs cards mirror: the list, the stats
   *                        and the insights read all sit behind it. The five
   *                        writes need `jobs:write`, which each PAGE gates
   *                        internally by disabling its controls — the card gate
   *                        is about REACHABILITY, and "what is the queue doing"
   *                        is worth reading for anyone answering "why has
   *                        nothing happened".
   *   - `nodes:read`     → `nodes/nodes-admin.controller.ts`
   *                        (`PERMISSIONS.NODES_READ`), the string it enforces
   *                        on the fleet list, the node detail and the
   *                        credential list; also `node-credential.controller.ts`.
   *                        DELIBERATELY NOT `jobs:read`: `roles.constants.ts`
   *                        splits the two, so a Workers card gated on
   *                        `jobs:read` would advertise a permission that
   *                        controller never checks, and the hub would decide
   *                        reachability on evidence unrelated to whether the
   *                        request behind it will be authorized.
   *   - `db_backup:read` → the backup controller (#268). NOT
   *                        `system_settings:read`: `roles.constants.ts`
   *                        reserves a dedicated `db_backup:read/write/restore`
   *                        triple for this surface precisely so backup access
   *                        can be granted without handing over the settings
   *                        document, and mirroring the settings permission here
   *                        would quietly undo that.
   *
   * All five strings are seeded to ADMIN ONLY (`prisma/seed-data.ts`), so in
   * practice this whole group is invisible to Contributor and Viewer today. The
   * cards still gate per permission and not on the admin ROLE, because a later
   * issue widening one read to an operations role must not have to touch this
   * file — and because a role check here is the split-brain `destinations.ts`'s
   * header exists to describe.
   *
   * The `/admin/settings` route gate is deliberately NOT widened to include
   * `jobs:read`. It mirrors `console`'s `anyPermission` in
   * `config/destinations.ts` byte for byte (asserted in
   * `destinations.test.ts`), and every holder of these permissions is an admin
   * who also holds `system_settings:read`, so nothing is unreachable. Widening
   * one side without the other is exactly the disagreement that test exists to
   * catch.
   */
  {
    label: 'Operations',
    cards: [
      {
        title: 'Jobs',
        description:
          'Inspect the background queue, retry or remove individual jobs, and recover work that stalled.',
        Icon: WorkHistoryOutlinedIcon,
        path: '/admin/settings/jobs',
        permission: 'jobs:read',
      },
      {
        // Nested UNDER the Jobs route, which `settingsPageTitle`'s
        // longest-prefix rule resolves correctly: a bare `startsWith` would let
        // `Jobs` claim this path and title the page "Jobs" in the compact
        // AppBar. That is the case the rule was written for, and it is asserted
        // in `settingsRegistry.test.ts` rather than left to the comment.
        title: 'Job Insights',
        description:
          'See how long the queue takes, how fast it is moving, and when the outstanding work will be done.',
        Icon: QueryStatsIcon,
        path: '/admin/settings/jobs/insights',
        permission: 'jobs:read',
      },
      {
        // Declared inert by #266 alongside the whole group; ROUTED by #271,
        // which ships the page. Flipping a card is exactly the two-field edit
        // the section header describes — a `path` appears and `disabled`
        // disappears — and both consumers pick it up from that alone: the hub
        // swaps its "Coming soon" chip for a real `CardActionArea`, and the
        // Console rail, which skipped the row entirely, starts drawing it.
        //
        // `permission` is UNCHANGED and was already right: `nodes:read` is the
        // literal string `nodes-admin.controller.ts` enforces on its fleet
        // list, its detail read and its credential list
        // (`PERMISSIONS.NODES_READ`). Creating and revoking credentials, and
        // deleting a node, need `nodes:write`, which the PAGE gates internally
        // by omitting the row actions and the create button — the card gate is
        // about REACHABILITY, and "which machines are attached and are they
        // alive" is worth reading for anyone answering "why is nothing being
        // processed".
        title: 'Worker Nodes',
        description:
          'See which machines are attached to this deployment, what they are running, and whether they are healthy.',
        Icon: DnsOutlinedIcon,
        path: '/admin/settings/workers',
        permission: 'nodes:read',
      },
      {
        // Declared inert by #266 alongside the whole group; ROUTED by #287,
        // the last issue of the epic, which ships the page. Flipping a card is
        // the two-field edit the section header describes — a `path` appears
        // and `disabled` disappears — and both consumers pick it up from that
        // alone: the hub swaps its "Coming soon" chip for a real
        // `CardActionArea`, and the Console rail, which skipped the row
        // entirely, starts drawing it. Both of those move pixels, so the
        // visual baselines were regenerated with this change.
        //
        // `permission` is UNCHANGED and was already right: `db_backup:read` is
        // the literal string `db-backup/db-backup.controller.ts` enforces on
        // its config read, its run list and its run detail
        // (`PERMISSIONS.DB_BACKUP_READ`). NOT `system_settings:read`:
        // `roles.constants.ts` reserves a dedicated
        // `db_backup:read/write/restore` triple for this surface precisely so
        // backup access can be granted without handing over the settings
        // document, and mirroring the settings permission here would quietly
        // undo that.
        //
        // Scheduling, cancelling and deleting need `db_backup:write`, and
        // restoring or rolling back need `db_backup:restore` — a THIRD
        // permission, kept separate by the API so it can be withheld from
        // someone who may schedule backups but must not be able to replace the
        // database. The PAGE gates both internally by disabling its controls;
        // the card gate is about REACHABILITY, and "is this deployment being
        // backed up, and what have we got" is worth reading for anyone
        // answering "can we recover from this".
        title: 'Database Backup',
        description:
          'Schedule backups, review what has been taken, and restore the database from one.',
        Icon: BackupOutlinedIcon,
        path: '/admin/settings/db-backup',
        permission: 'db_backup:read',
      },
      {
        // Issue #325, epic #319. `broadcasts:read` is the literal string
        // `notifications/broadcasts/broadcasts.controller.ts` enforces on its
        // audience count, its list and its detail read
        // (`PERMISSIONS.BROADCASTS_READ`) — the registry never invents a
        // permission, it mirrors one. Composing, scheduling, cancelling,
        // deleting and test-sending need `broadcasts:write`, which the PAGE
        // gates internally by disabling its controls: the card gate is about
        // REACHABILITY, and "what has been announced, and is anything queued to
        // go out" is worth reading for anyone answering "did everyone get told".
        //
        // OPERATIONS, NOT GENERAL, per this section's own header. General holds
        // values an administrator SETS, which then sit there; a broadcast is
        // work you dispatch and then watch — it has a status, a progress
        // counter and a cancel — and it belongs one card away from Jobs, where
        // its fan-out becomes visible.
        //
        // ⚠ NOT THE SAME PAGE AS General → Notifications, and the descriptions
        // are written to keep them apart. That card is the deployment-wide KILL
        // SWITCH: it decides whether browser notifications may be raised at all
        // and which events are suppressed. This one composes and sends a single
        // announcement to every user. Confusing the two during an incident is
        // the difference between silencing every notification in the product
        // and telling everybody what is happening.
        title: 'Broadcasts',
        description:
          'Write an announcement and send it to every active user now or at a scheduled time, then watch it go out.',
        Icon: CampaignOutlinedIcon,
        path: '/admin/settings/broadcasts',
        permission: 'broadcasts:read',
      },
    ],
  },
];

/**
 * The Console hub itself — the one admin route that owns no card, and so the
 * title `settingsPageTitle` falls back to.
 */
export const ADMIN_HUB_PATH = '/admin/settings';
export const ADMIN_HUB_TITLE = 'Settings';

/**
 * Filter `sections` to what `hasPermission` allows, optionally also applying
 * the client-side "Search settings" filter, and drop any section left empty.
 *
 * Every consumer runs THIS function rather than its own loop, which is what
 * makes success criterion 6 of epic #90 testable with a single assertion: a
 * card whose permission the user lacks can appear in the hub, the rail, and
 * the title resolver only if it appears in all three, and it appears in none.
 *
 * An empty section is dropped rather than rendered as a bare header, because a
 * group header above nothing reads as a loading failure, not as "you may see
 * none of these".
 *
 * `sections` is a PARAMETER rather than a closure over `ADMIN_SECTIONS`
 * deliberately: issue #96 reuses this function verbatim for the user-settings
 * registry, and a second near-identical copy of the gate is exactly the drift
 * this file exists to prevent.
 *
 * `query` matches the card TITLE only, case-insensitively, and never the
 * description. Matching descriptions too would mean a two-letter query
 * surfacing eight cards because their prose happens to share a word — a worse
 * result set than a strict title match, and one the user cannot predict.
 */
export function visibleSettingsSections(
  sections: SettingsSectionDef[],
  hasPermission: (permission: string) => boolean,
  query = '',
): SettingsSectionDef[] {
  const needle = query.trim().toLowerCase();
  return sections
    .map((section) => ({
      label: section.label,
      cards: section.cards.filter((card) => {
        if (needle && !card.title.toLowerCase().includes(needle)) return false;
        if (card.alwaysShow) return true;
        if (!card.permission) return true;
        return hasPermission(card.permission);
      }),
    }))
    .filter((section) => section.cards.length > 0);
}

/**
 * Resolve a pathname to the human title of the page it renders, for the
 * compact drill-down AppBar (#95).
 *
 * LONGEST PREFIX WINS, the same rule `resolveActiveDestination` uses in
 * `destinations.ts`, and it earns its keep the moment a card's route nests:
 * `/admin/settings/users/:id` must resolve to "Users & Allowlist" rather than
 * falling back to the hub title, and a future `/admin/settings/storage/insights`
 * must beat a `/admin/settings/storage` sibling instead of losing to whichever
 * happened to be declared first.
 *
 * Matching respects segment boundaries — `path === pathname` or
 * `pathname` continuing with a `/` — so `/admin/settings/users` does not claim
 * `/admin/settings/users-archive`. A bare `startsWith` is the bug
 * `destinations.ts`'s `owns()` was written to kill.
 *
 * Returns `null` when the path is not under `hubPath` at all. That is the
 * signal the AppBar uses to keep its normal toolbar: a `null` means "this is
 * not a settings surface", which is a different answer from "this is the
 * surface's own hub" (`hubTitle`), and collapsing the two would put a back
 * arrow on every page in the app.
 *
 * `sections`, `hubPath` and `hubTitle` are parameters for the same reason
 * `visibleSettingsSections` takes `sections`: #96 calls this with the user
 * registry and `/settings`.
 */
export function settingsPageTitle(
  sections: SettingsSectionDef[],
  hubPath: string,
  hubTitle: string,
  pathname: string,
): string | null {
  if (pathname !== hubPath && !pathname.startsWith(`${hubPath}/`)) return null;

  let best: { title: string; length: number } | null = null;
  for (const section of sections) {
    for (const card of section.cards) {
      if (!card.path) continue;
      const matches = pathname === card.path || pathname.startsWith(`${card.path}/`);
      if (matches && (!best || card.path.length > best.length)) {
        best = { title: card.title, length: card.path.length };
      }
    }
  }

  return best?.title ?? hubTitle;
}
