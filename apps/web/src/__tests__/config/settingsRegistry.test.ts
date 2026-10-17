import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import TuneIcon from '@mui/icons-material/Tune';
import {
  ADMIN_SECTIONS,
  ADMIN_HUB_PATH,
  ADMIN_HUB_TITLE,
  visibleSettingsSections,
  settingsPageTitle,
} from '../../config/adminSections';
import type { SettingsSectionDef } from '../../config/adminSections';
import { registeredSettingsFeatures } from '@marinoscar/platform-web/settings/headless';
import { kvoxTranscriptionAdminSections } from '@marinoscar/kvox-web/transcription/ui';
import '../../config/settingsFeatures';
import {
  USER_SETTINGS_SECTIONS,
  USER_HUB_PATH,
  USER_HUB_TITLE,
} from '../../config/userSettingsSections';

/**
 * Issue #91, epic #90 — `visibleSettingsSections` and `settingsPageTitle` are
 * the ONE gate every consumer (hub, rail, AppBar title) runs. A bug here is a
 * bug in three surfaces at once, and this suite is what makes that provable
 * with a single assertion per behavior instead of three near-identical
 * component tests.
 *
 * `visibleSettingsSections` is exercised two ways:
 *   - against a small local FIXTURE, for the cases that need independent
 *     control over `permission` / `alwaysShow` (ADMIN_SECTIONS today has no
 *     `alwaysShow` card, and no card with an undeniable permission either);
 *   - against the REAL `ADMIN_SECTIONS` / `USER_SETTINGS_SECTIONS`, for the
 *     cases that are really about the real data (title-vs-description search,
 *     and "it works for the user registry too").
 */

/** A real Icon component, reused across the fixture — only its identity is asserted anywhere, so one is enough. */
const Icon = TuneIcon;

function buildFixture(): SettingsSectionDef[] {
  return [
    {
      label: 'Alpha',
      cards: [
        { title: 'Open Card', description: 'visible to anyone, no gate', Icon, path: '/x/open' },
        {
          title: 'Gated Card',
          description: 'needs a permission the fixture can deny',
          Icon,
          path: '/x/gated',
          permission: 'alpha:read',
        },
        {
          title: 'Bypass Card',
          description: 'gated, but escapes the gate via alwaysShow',
          Icon,
          path: '/x/bypass',
          permission: 'alpha:write',
          alwaysShow: true,
        },
      ],
    },
    {
      label: 'Beta (fully gated)',
      cards: [
        {
          title: 'Beta Only',
          description: 'the only card in its section, and it is gated',
          Icon,
          path: '/x/beta',
          permission: 'beta:read',
        },
      ],
    },
  ];
}

function titlesOf(sections: SettingsSectionDef[]): string[] {
  return sections.flatMap((section) => section.cards.map((card) => card.title));
}

describe('visibleSettingsSections — permission gating', () => {
  it('drops a card whose permission is not held', () => {
    const result = visibleSettingsSections(buildFixture(), () => false);

    expect(titlesOf(result)).not.toContain('Gated Card');
  });

  it('removes a section entirely once every one of its cards is filtered out, rather than rendering it empty', () => {
    // 'Beta Only' is the section's sole card and is gated, so with every
    // permission denied the whole section must disappear — not survive as a
    // header over zero cards, which reads as a loading failure.
    const result = visibleSettingsSections(buildFixture(), () => false);

    expect(result.find((section) => section.label === 'Beta (fully gated)')).toBeUndefined();
  });

  it('lets alwaysShow bypass the permission gate', () => {
    const result = visibleSettingsSections(buildFixture(), () => false);

    expect(titlesOf(result)).toContain('Bypass Card');
  });

  it('shows a card with no permission declared regardless of what hasPermission answers', () => {
    const result = visibleSettingsSections(buildFixture(), () => false);

    expect(titlesOf(result)).toContain('Open Card');
  });
});

describe('visibleSettingsSections — search', () => {
  it('matches a card title case-insensitively', () => {
    // Grant everything so the search filter is the only thing under test.
    const result = visibleSettingsSections(ADMIN_SECTIONS, () => true, 'mAiL');

    expect(titlesOf(result)).toContain('Email');
  });

  it('does not match a term that appears only in the description, never the title', () => {
    // Email's description reads "...send a test message to prove it works" —
    // "message" is in no card TITLE in ADMIN_SECTIONS. Matching descriptions
    // too would mean a two-letter query surfacing cards on prose the user
    // never sees highlighted, which `visibleSettingsSections`'s own doc
    // comment calls out as the worse, unpredictable result set this design
    // avoids.
    const result = visibleSettingsSections(ADMIN_SECTIONS, () => true, 'message');

    expect(titlesOf(result)).toHaveLength(0);
  });

  it('composes with permission gating: a title match the user lacks permission for stays hidden', () => {
    // 'gated' matches only 'Gated Card' by title in the fixture. It is denied
    // and not alwaysShow, so the hit must not surface — search narrows what is
    // ELIGIBLE to show, it never re-opens a closed permission gate.
    const result = visibleSettingsSections(buildFixture(), () => false, 'gated');

    expect(result).toEqual([]);
  });

  it('treats an empty string query the same as no query argument at all', () => {
    const hasPermission = (permission: string) => permission === 'alpha:read';
    const fixture = buildFixture();

    expect(visibleSettingsSections(fixture, hasPermission, '')).toEqual(
      visibleSettingsSections(fixture, hasPermission),
    );
  });

  it('treats a whitespace-only query the same as no query argument at all', () => {
    const hasPermission = (permission: string) => permission === 'alpha:read';
    const fixture = buildFixture();

    expect(visibleSettingsSections(fixture, hasPermission, '   ')).toEqual(
      visibleSettingsSections(fixture, hasPermission),
    );
  });
});

describe('visibleSettingsSections — works identically against USER_SETTINGS_SECTIONS', () => {
  it('shows every ungated user-settings card, and hides Knowledge graph and AI Provider without their permissions (#369, #477)', () => {
    // The deployment feature map is passed explicitly: `AI Provider` carries
    // `feature: 'ai'`, and an omitted map fails closed.
    const result = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false, '', { ai: true });

    expect(titlesOf(result).sort()).toEqual(
      titlesOf(USER_SETTINGS_SECTIONS)
        .filter((title) => title !== 'Knowledge graph' && title !== 'AI Provider')
        .sort(),
    );
    // Its one-card `Knowledge` group collapses with it.
    expect(result.map((section) => section.label)).not.toContain('Knowledge');

    const withGates = visibleSettingsSections(
      USER_SETTINGS_SECTIONS,
      (permission) => permission === 'graph:write' || permission === 'ai:use',
      '',
      { ai: true },
    );
    expect(titlesOf(withGates).sort()).toEqual(titlesOf(USER_SETTINGS_SECTIONS).sort());
  });

  it('still matches by title only for the user registry', () => {
    // Profile's description reads "Your display name and profile image..." —
    // "display" is in no user-settings card title.
    const byDescriptionOnly = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false, 'display');
    expect(titlesOf(byDescriptionOnly)).toHaveLength(0);

    const byTitle = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false, 'profile');
    expect(titlesOf(byTitle)).toContain('Profile');
  });
});

/**
 * Issue #366. `System`, `Appearance`, `Feature Flags` and `Advanced (JSON)`
 * were removed outright — not disabled, not hidden behind a permission — so
 * this is a regression guard against any of the four quietly reappearing
 * (e.g. a bad merge resurrecting a card whose page no longer exists, which
 * would send a click straight to `App.tsx`'s `*` catch-all).
 */
describe('removed settings pages (#366) stay gone', () => {
  const allCards = ADMIN_SECTIONS.flatMap((section) => section.cards);

  it('declares no card for System, Appearance, Feature Flags or Advanced (JSON)', () => {
    const titles = allCards.map((card) => card.title);
    expect(titles).not.toContain('System');
    expect(titles).not.toContain('Appearance');
    expect(titles).not.toContain('Feature Flags');
    expect(titles).not.toContain('Advanced (JSON)');
  });

  it('routes none of the removed paths', () => {
    const paths = allCards.map((card) => card.path);
    expect(paths).not.toContain('/admin/settings/general');
    expect(paths).not.toContain('/admin/settings/appearance');
    expect(paths).not.toContain('/admin/settings/feature-flags');
    expect(paths).not.toContain('/admin/settings/advanced');
  });
});

/**
 * Issue #225, epic #215. The `Notifications` page is a registry CARD, never a
 * fourth tab on an existing settings page — `CLAUDE.md`'s mandatory settings-UI
 * rule 1, stated as an assertion: a route with no registry entry is one the hub,
 * the Console rail and the AppBar title resolver all disagree about, because
 * none of the three has any way to learn it exists.
 *
 * The route/permission agreement with `App.tsx` is asserted generically for
 * every card in `destinations.test.ts`; what is pinned here is this card's own
 * identity, and that the gate genuinely denies.
 */
describe('the Notifications card (#225)', () => {
  const card = ADMIN_SECTIONS.flatMap((section) => section.cards).find(
    (entry) => entry.title === 'Notifications',
  );

  it('is declared in ADMIN_SECTIONS', () => {
    expect(card).toBeDefined();
  });

  it('routes to /admin/settings/notifications', () => {
    expect(card?.path).toBe('/admin/settings/notifications');
  });

  it('declares the exact permission the API enforces on GET /api/system-settings', () => {
    // `system-settings.controller.ts` — the same document this page edits, and
    // the same string its three sibling cards mirror. The registry never
    // invents a permission.
    expect(card?.permission).toBe('system_settings:read');
  });

  it('is not an alwaysShow escape hatch — the gate must be able to deny it', () => {
    expect(card?.alwaysShow).toBeUndefined();
  });

  it('appears for an admin holding system_settings:read', () => {
    const result = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'system_settings:read',
    );

    expect(titlesOf(result)).toContain('Notifications');
  });

  it('appears in none of the three surfaces for a viewer', () => {
    // A viewer holds `user_settings:*` only. One assertion covers the hub, the
    // rail and the title resolver because all three run this same function.
    const viewerPermissions = ['user_settings:read', 'user_settings:write'];
    const result = visibleSettingsSections(ADMIN_SECTIONS, (permission) =>
      viewerPermissions.includes(permission),
    );

    expect(titlesOf(result)).not.toContain('Notifications');
  });

  it('resolves its route to its own title, not the hub title', () => {
    expect(
      settingsPageTitle(
        ADMIN_SECTIONS,
        ADMIN_HUB_PATH,
        ADMIN_HUB_TITLE,
        '/admin/settings/notifications',
      ),
    ).toBe('Notifications');
  });
});

/**
 * Issue #325, epic #319. The `Broadcasts` page is a registry CARD, never a
 * fourth tab on the admin Notifications settings page — `CLAUDE.md`'s mandatory
 * settings-UI rule 1 and rule 2, stated as assertions. The two pages answer
 * different questions: `/admin/settings/notifications` is the deployment-wide
 * kill switch (reachability of the notification MECHANISM), while this one
 * composes and dispatches one announcement to every user. A tab strip would
 * present the second as content of the first.
 *
 * The route/permission agreement with `App.tsx` is asserted generically for
 * every card in `destinations.test.ts`; what is pinned here is this card's own
 * identity, and that the gate genuinely denies.
 */
describe('the Broadcasts card (#325)', () => {
  const card = ADMIN_SECTIONS.flatMap((section) => section.cards).find(
    (entry) => entry.title === 'Broadcasts',
  );

  it('is declared in ADMIN_SECTIONS', () => {
    expect(card).toBeDefined();
  });

  it('routes to /admin/settings/broadcasts', () => {
    expect(card?.path).toBe('/admin/settings/broadcasts');
  });

  it('lives under Operations, not General', () => {
    // General holds values an administrator SETS, which then sit there; a
    // broadcast is work you dispatch and then watch. The distinction is this
    // section's own header, and it is what keeps the card one away from Jobs.
    const owner = ADMIN_SECTIONS.find((section) =>
      section.cards.some((entry) => entry.title === 'Broadcasts'),
    );
    expect(owner?.label).toBe('Operations');
  });

  it('declares the exact permission the API enforces on the broadcast routes', () => {
    // `notifications/broadcasts/broadcasts.controller.ts` — the registry never
    // invents a permission. NOT `system_settings:read`, which would let the
    // hub decide reachability on evidence unrelated to whether the request
    // behind the card will be authorized.
    expect(card?.permission).toBe('broadcasts:read');
    expect(card?.permission).not.toBe('system_settings:read');
  });

  it('is not an alwaysShow escape hatch — the gate must be able to deny it', () => {
    expect(card?.alwaysShow).toBeUndefined();
  });

  it('is routed, not inert', () => {
    expect(card?.disabled).toBeUndefined();
  });

  it('appears for an admin holding broadcasts:read', () => {
    const result = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'broadcasts:read',
    );

    expect(titlesOf(result)).toContain('Broadcasts');
  });

  it('appears in none of the three surfaces for a viewer', () => {
    // A viewer holds `user_settings:*` only. One assertion covers the hub, the
    // rail and the title resolver because all three run this same function.
    const viewerPermissions = ['user_settings:read', 'user_settings:write'];
    const result = visibleSettingsSections(ADMIN_SECTIONS, (permission) =>
      viewerPermissions.includes(permission),
    );

    expect(titlesOf(result)).not.toContain('Broadcasts');
  });

  it('resolves its route to its own title, not the hub title', () => {
    expect(
      settingsPageTitle(
        ADMIN_SECTIONS,
        ADMIN_HUB_PATH,
        ADMIN_HUB_TITLE,
        '/admin/settings/broadcasts',
      ),
    ).toBe('Broadcasts');
  });

  it('is not confusable with the General → Notifications card', () => {
    // Both exist, at different paths, behind different permissions. The
    // failure this guards against is a later edit collapsing one into the
    // other — a "Broadcasts" tab on the notifications route, or a card whose
    // path quietly points at the kill switch.
    const notifications = ADMIN_SECTIONS.flatMap((section) => section.cards).find(
      (entry) => entry.title === 'Notifications',
    );

    expect(notifications?.path).toBe('/admin/settings/notifications');
    expect(card?.path).not.toBe(notifications?.path);
    expect(card?.permission).not.toBe(notifications?.permission);
  });
});

describe('settingsPageTitle', () => {
  it('resolves an exact card path to its title', () => {
    expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/users')).toBe(
      'Users & Allowlist',
    );
  });

  it('gives the longest matching prefix the win on a nested child path', () => {
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/users/123'),
    ).toBe('Users & Allowlist');
  });

  it('respects segment boundaries: a path that only starts with a card path falls back to the hub title', () => {
    // Per the function's own doc comment, `/admin/settings/users-archive` must
    // NOT resolve to "Users & Allowlist" — but it IS still under the hub
    // (`/admin/settings/...`), so the correct answer is the hub title, not
    // null. A bare `startsWith` on the card path is the exact bug
    // `destinations.ts`'s `owns()` was written to kill, reintroduced here.
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/users-archive'),
    ).toBe(ADMIN_HUB_TITLE);
  });

  it('returns the hub title for the hub path itself', () => {
    expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, ADMIN_HUB_PATH)).toBe(
      ADMIN_HUB_TITLE,
    );
  });

  it('returns the hub title for a child path under the hub that no card owns', () => {
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/whatever-not-a-card-path'),
    ).toBe(ADMIN_HUB_TITLE);
  });

  describe('returns null for a path not under hubPath at all', () => {
    it('the app root', () => {
      expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/')).toBeNull();
    });

    it('a sibling under /admin that is not the settings hub', () => {
      expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin')).toBeNull();
    });

    it('cross-registry: the admin registry does not claim a user-settings path', () => {
      // /settings/profile belongs to the OTHER hub. Without the hubPath guard,
      // nothing here would stop a coincidental card-path collision from
      // resolving a title that belongs to the wrong surface.
      expect(settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/settings/profile')).toBeNull();
    });

    it('cross-registry: the user registry does not claim an admin-settings path', () => {
      expect(
        settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, '/admin/settings/users'),
      ).toBeNull();
    });
  });
});

/**
 * Issue #266, epic #254 — the `Operations` group.
 *
 * Three things are worth asserting here that nothing else can:
 *
 *  1. THE GROUP IS ADDITIVE. `General` and `Access` keep their cards, their
 *     order and their gates; a third section that quietly reordered or
 *     absorbed a sibling would look fine on the hub and be wrong in the rail.
 *  2. THE TWO UNBUILT CARDS ARE NON-NAVIGABLE, not 404-linking. Both consumers
 *     key on the same two fields (`SettingsHub` renders an inert "Coming soon"
 *     card with no action area; `NavigationRail` skips the row), so `path`
 *     being absent AND `disabled` being true is the contract, not a detail.
 *  3. THE PERMISSIONS ARE THE API'S OWN STRINGS — checked against the API's
 *     constants file on disk rather than against a copy, per CLAUDE.md's
 *     Settings UI Pattern rule 3. `Database Backup` in particular must NOT
 *     mirror `system_settings:read`: the API reserves a dedicated
 *     `db_backup:*` triple precisely so backup access can be granted without
 *     handing over the settings document.
 */
describe('the Operations group (#266)', () => {
  const operations = ADMIN_SECTIONS.find((section) => section.label === 'Operations');
  const cardsByTitle = new Map(
    ADMIN_SECTIONS.flatMap((section) => section.cards).map((card) => [card.title, card]),
  );

  it('is a third group, and the first two are untouched', () => {
    // #471, epic #467 — Observability (the telemetry cards) is APPENDED as a
    // fourth group after these three; it moves none of them.
    expect(ADMIN_SECTIONS.map((section) => section.label).slice(0, 3)).toEqual([
      'General',
      'Access',
      'Operations',
    ]);
  });

  it('registers all four of the epic’s cards at once, epic #319 appends a fifth and #464 the Doctor', () => {
    // Declared together on purpose: the hub is under visual-regression testing
    // at `maxDiffPixels: 4`, so every change to the card grid needs baselines
    // regenerated in a pinned container. Four cards across four issues would
    // be four regenerations and four chances to land a stale baseline.
    //
    // `Broadcasts` (#325, epic #319) is APPENDED rather than inserted, and the
    // order is asserted rather than left to chance: the hub, the rail and the
    // drill-down list all render this array in declaration order, so an
    // insertion would move four existing cards for a reader who has learnt
    // where they are — and would reflow the grid further than the one added
    // card requires.
    expect(operations?.cards.map((card) => card.title)).toEqual([
      'Jobs',
      'Job Insights',
      'Worker Nodes',
      'Database Backup',
      'Broadcasts',
      // #464, epic #462 — the platform's Doctor, APPENDED for the same reason
      // Broadcasts was: an insertion would move five cards a reader has learnt.
      'Doctor',
    ]);
  });

  it('routes every page that has shipped', () => {
    expect(cardsByTitle.get('Jobs')?.path).toBe('/admin/settings/jobs');
    expect(cardsByTitle.get('Job Insights')?.path).toBe('/admin/settings/jobs/insights');
    // #271 flipped this one from inert to routed. The path is the route
    // `App.tsx` declares, byte for byte — a card pointing anywhere else would
    // send the click to the `*` catch-all and land on the home page.
    expect(cardsByTitle.get('Worker Nodes')?.path).toBe('/admin/settings/workers');
    // #287 flipped the last one, for the same reason and with the same rule:
    // the path is the route `App.tsx` declares, byte for byte.
    expect(cardsByTitle.get('Database Backup')?.path).toBe('/admin/settings/db-backup');
  });

  it('has no inert card left — every page the group declared has shipped', () => {
    // #287 flipped the last one. The `disabled: true` + no-`path` contract
    // still matters and is asserted below for whatever is declared ahead of its
    // page NEXT; today the group is fully routed, which is the state it was
    // declared in advance to reach.
    for (const card of operations?.cards ?? []) {
      expect(card.disabled, `${card.title} must not be inert`).toBeUndefined();
      expect(card.path, `${card.title} must declare a route`).toBeTruthy();
    }
  });

  it('keeps the two fields coupled for any card declared ahead of its page', () => {
    // The rail skips on either field and the hub renders an inert card on
    // either, so a card that has one without the other is a card the two
    // consumers disagree about: `disabled` with a `path` is a rail row that
    // vanishes, and a `path` with no page sends a click to `App.tsx`'s `*`
    // catch-all and lands the operator on the home page with no explanation.
    for (const card of ADMIN_SECTIONS.flatMap((section) => section.cards)) {
      if (card.disabled) {
        expect(card.path, `${card.title} is inert and must declare no route`).toBeUndefined();
      }
    }
  });

  it('leaves the shipped cards navigable', () => {
    for (const title of ['Jobs', 'Job Insights', 'Worker Nodes', 'Database Backup']) {
      expect(cardsByTitle.get(title)?.disabled).toBeUndefined();
    }
  });

  it('gates every card on a permission, with no alwaysShow escape hatch', () => {
    for (const card of operations?.cards ?? []) {
      expect(card.permission, `${card.title} must declare a permission`).toBeTruthy();
      expect(card.alwaysShow, `${card.title} must be deniable`).toBeUndefined();
    }
  });

  describe('the permissions are literally the strings the API enforces', () => {
    // Read off the API workspace rather than restated, so a rename on either
    // side fails here instead of in production. This is the mechanical half of
    // CLAUDE.md Settings UI Pattern rule 3.
    const API_SRC = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../api/src',
    );
    // Issue #465: the permission ids are no longer literals in
  // `roles.constants.ts` (derived from the platform registries); the committed
  // catalog `apps/api/prisma/catalog/permissions.json` is the file that lists
  // every permission the API seeds and enforces, and CI keeps it in sync.
  const permissionCatalog = readFileSync(
      resolve(API_SRC, '../prisma/catalog/permissions.json'),
      'utf8',
    );
    // The jobs and nodes controllers are the platform's (#468), read from the installed package.
    const PLATFORM_API_DIST = resolve(
      API_SRC,
      '../../../node_modules/@marinoscar/platform-api/dist',
    );
    const jobsController = readFileSync(
      resolve(PLATFORM_API_DIST, 'jobs/job-admin.controller.js'),
      'utf8',
    );
    const nodesAdminController = readFileSync(
      resolve(PLATFORM_API_DIST, 'nodes/nodes-admin.controller.js'),
      'utf8',
    );
    // The broadcasts, push-config and email-settings controllers are the platform's (#470).
    const broadcastsController = readFileSync(
      resolve(PLATFORM_API_DIST, 'notifications/broadcasts/broadcasts.controller.js'),
      'utf8',
    );
    const pushConfigController = readFileSync(
      resolve(PLATFORM_API_DIST, 'notifications/push-config.controller.js'),
      'utf8',
    );
    const emailSettingsController = readFileSync(
      resolve(PLATFORM_API_DIST, 'email/email-settings.controller.js'),
      'utf8',
    );
    // The db-backup controller is the platform's (#471).
    const dbBackupController = readFileSync(
      resolve(PLATFORM_API_DIST, 'db-backup/db-backup.controller.js'),
      'utf8',
    );

    it('binds both Jobs cards to jobs:read, which job-admin.controller.ts enforces on its reads', () => {
      expect(cardsByTitle.get('Jobs')?.permission).toBe('jobs:read');
      expect(cardsByTitle.get('Job Insights')?.permission).toBe('jobs:read');
      expect(permissionCatalog).toContain('"jobs:read"');
      expect(jobsController).toContain('PERMISSIONS.JOBS_READ');
    });

    it('binds Worker Nodes to nodes:read, never to jobs:read', () => {
      // `roles.constants.ts` splits the two deliberately: a Workers card gated
      // on `jobs:read` would advertise a permission the nodes controller never
      // checks, so the hub would decide reachability on unrelated evidence.
      expect(cardsByTitle.get('Worker Nodes')?.permission).toBe('nodes:read');
      expect(cardsByTitle.get('Worker Nodes')?.permission).not.toBe('jobs:read');
      expect(permissionCatalog).toContain('"nodes:read"');
      // And the controller really does enforce it — the mechanical half of
      // CLAUDE.md Settings UI Pattern rule 3, now that the card is routed and
      // the string gates a page somebody can actually open (#271).
      expect(nodesAdminController).toContain('PERMISSIONS.NODES_READ');
    });

    it('binds Broadcasts to broadcasts:read, which broadcasts.controller.ts enforces on its reads', () => {
      // #325, epic #319. The dedicated pair exists so composing an
      // announcement to every user can be granted — or withheld — without
      // handing over the settings document, and mirroring
      // `system_settings:read` here would quietly undo that.
      expect(cardsByTitle.get('Broadcasts')?.permission).toBe('broadcasts:read');
      expect(cardsByTitle.get('Broadcasts')?.permission).not.toBe('system_settings:read');
      expect(permissionCatalog).toContain('"broadcasts:read"');
      expect(permissionCatalog).toContain('"broadcasts:write"');
      // And the controller really does enforce it — the mechanical half of
      // CLAUDE.md Settings UI Pattern rule 3.
      expect(broadcastsController).toContain('PERMISSIONS.BROADCASTS_READ');
      expect(broadcastsController).toContain('PERMISSIONS.BROADCASTS_WRITE');
    });

    it('binds Web Push to push:read, which the platform push-config controller enforces on its GET (#470)', () => {
      expect(cardsByTitle.get('Web Push')?.permission).toBe('push:read');
      expect(cardsByTitle.get('Web Push')?.permission).not.toBe('system_settings:read');
      expect(permissionCatalog).toContain('"push:read"');
      expect(permissionCatalog).toContain('"push:write"');
      expect(pushConfigController).toContain('PERMISSIONS.PUSH_READ');
      expect(pushConfigController).toContain('PERMISSIONS.PUSH_WRITE');
    });

    it('binds Email to system_settings:read, which the platform email-settings controller enforces on its GET (#470)', () => {
      expect(cardsByTitle.get('Email')?.permission).toBe('system_settings:read');
      expect(emailSettingsController).toContain('SYSTEM_SETTINGS_READ');
    });

    it('binds Database Backup to the dedicated db_backup:read, never to system_settings:read', () => {
      const card = cardsByTitle.get('Database Backup');
      expect(card?.permission).toBe('db_backup:read');
      expect(card?.permission).not.toBe('system_settings:read');
      expect(permissionCatalog).toContain('"db_backup:read"');
      // And the controller really does enforce it — the mechanical half of
      // CLAUDE.md Settings UI Pattern rule 3, now that the card is routed and
      // the string gates a page somebody can actually open (#287).
      expect(dbBackupController).toContain('PERMISSIONS.DB_BACKUP_READ');
      // The THIRD permission is what the split is for: restoring is deliberately
      // not `db_backup:write`, so it can be withheld from someone who may
      // schedule backups but must not be able to replace the database. The card
      // must NOT mirror it — a reachability gate on `restore` would hide the
      // history from the read-only admin the page is most useful to.
      expect(permissionCatalog).toContain('"db_backup:restore"');
      expect(dbBackupController).toContain('PERMISSIONS.DB_BACKUP_RESTORE');
      expect(card?.permission).not.toBe('db_backup:restore');
    });
  });

  describe('the shared gate, which the hub, the rail and the AppBar all run', () => {
    it('shows an operator holding only jobs:read exactly the two Jobs cards', () => {
      const result = visibleSettingsSections(
        ADMIN_SECTIONS,
        (permission) => permission === 'jobs:read',
      );

      expect(result.map((section) => section.label)).toEqual(['Operations']);
      expect(titlesOf(result)).toEqual(['Jobs', 'Job Insights']);
    });

    it('drops Operations entirely for a viewer, in all three surfaces at once', () => {
      const viewerPermissions = ['user_settings:read', 'user_settings:write'];
      const result = visibleSettingsSections(ADMIN_SECTIONS, (permission) =>
        viewerPermissions.includes(permission),
      );

      expect(result.find((section) => section.label === 'Operations')).toBeUndefined();
    });

    it('does not disturb what a system_settings/users admin already saw', () => {
      // The regression an added section invites: General and Access must still
      // resolve to exactly the cards they did before.
      const result = visibleSettingsSections(ADMIN_SECTIONS, (permission) =>
        ['system_settings:read', 'system_settings:write', 'users:read'].includes(permission),
      );

      // #464, epic #462: Operations is present too, but only for the Doctor card,
      // which carries `system_settings:read`; every other Operations card is
      // gated on a permission this admin does not hold.
      expect(result.map((section) => section.label)).toEqual(['General', 'Access', 'Operations']);
      expect(result.find((section) => section.label === 'Operations')?.cards.map((c) => c.title)).toEqual(['Doctor']);
      expect(titlesOf(result.filter((section) => section.label !== 'Operations'))).toEqual([
        // #278, epic #271 — FIRST in General on purpose: on a fresh deployment
        // this is the card that says which two settings the product cannot run
        // without, and a hub is the wrong shape for someone on minute one. It
        // is gated on the same `system_settings:read` its controller enforces.
        'Setup guide',
        'Email',
        'Notifications',
        // #23, epic #19 — a General card gated on the same
        // `system_settings:read` its controller enforces, so it appears for
        // exactly the admin this assertion describes.
        'Transcription',
        // #477 — the `AI` card is NOT here any more: the AI policy has its own
        // permission pair (`ai_config:read`), which this admin does not hold.
        'Maintenance',
        // #126, epic #118 — likewise, and for the same reason: the About
        // controller enforces `system_settings:read` and nothing of its own,
        // so it appears for exactly the admin this assertion describes.
        'About',
        'Users & Allowlist',
      ]);
    });

    it('shows every Operations card to whoever holds its permission', () => {
      const result = visibleSettingsSections(ADMIN_SECTIONS, () => true);

      expect(titlesOf(result)).toContain('Worker Nodes');
      expect(titlesOf(result)).toContain('Database Backup');
    });

    it('shows Database Backup to a db_backup:read holder and to nobody else', () => {
      // The whole reason the API reserves a dedicated triple: backup access is
      // grantable without the settings document, so the card must not appear
      // for a `system_settings:read` admin who was never given it.
      const withBackup = visibleSettingsSections(
        ADMIN_SECTIONS,
        (permission) => permission === 'db_backup:read',
      );
      expect(titlesOf(withBackup)).toEqual(['Database Backup']);

      const settingsOnly = visibleSettingsSections(
        ADMIN_SECTIONS,
        (permission) => permission === 'system_settings:read',
      );
      expect(titlesOf(settingsOnly)).not.toContain('Database Backup');
    });

    it('matches Operations cards by title in the hub search', () => {
      const result = visibleSettingsSections(ADMIN_SECTIONS, () => true, 'insights');

      expect(titlesOf(result)).toEqual(['Job Insights']);
    });
  });

  describe('the AppBar title resolver, on a NESTED card route', () => {
    const titleFor = (pathname: string) =>
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, pathname);

    it('resolves the parent route to Jobs', () => {
      expect(titleFor('/admin/settings/jobs')).toBe('Jobs');
    });

    it('gives the LONGEST prefix the win, so the nested route is not titled "Jobs"', () => {
      // The exact case the longest-prefix rule exists for: `/admin/settings/jobs`
      // is a genuine prefix of the insights path, so a first-match resolver
      // would title this page after its sibling.
      expect(titleFor('/admin/settings/jobs/insights')).toBe('Job Insights');
    });

    it('keeps the win on a child of the nested route', () => {
      expect(titleFor('/admin/settings/jobs/insights/anything')).toBe('Job Insights');
    });

    it('respects segment boundaries around the jobs path', () => {
      expect(titleFor('/admin/settings/jobs-archive')).toBe(ADMIN_HUB_TITLE);
    });

    it('resolves the backup route to Database Backup (#287)', () => {
      expect(titleFor('/admin/settings/db-backup')).toBe('Database Backup');
    });

    it('falls back to the hub title for paths no card claims', () => {
      // Neither of these is any card's `path` — the two pages live at
      // `/admin/settings/workers` and `/admin/settings/db-backup` — so nothing
      // claims them, which is the same answer the hub gives and not a title for
      // a page that does not exist.
      expect(titleFor('/admin/settings/nodes')).toBe(ADMIN_HUB_TITLE);
      expect(titleFor('/admin/settings/backup')).toBe(ADMIN_HUB_TITLE);
      // And the segment-boundary rule holds around the new path too.
      expect(titleFor('/admin/settings/db-backup-archive')).toBe(ADMIN_HUB_TITLE);
    });
  });
});

/**
 * Issue #23, epic #19. The `Transcription` page is a registry CARD, never a
 * fourth tab on the admin Email or Notifications page — `CLAUDE.md`'s mandatory
 * settings-UI rule 1, stated as an assertion.
 *
 * The route/permission agreement with `App.tsx` is asserted generically for
 * every card in `destinations.test.ts`; what is pinned here is this card's own
 * identity, that it sits in General rather than Operations, and that the gate
 * genuinely denies.
 */
describe('the Transcription card (#23)', () => {
  const card = ADMIN_SECTIONS.flatMap((section) => section.cards).find(
    (entry) => entry.title === 'Transcription',
  );

  it('is declared in ADMIN_SECTIONS', () => {
    expect(card).toBeDefined();
  });

  it('routes to /admin/settings/transcription', () => {
    expect(card?.path).toBe('/admin/settings/transcription');
  });

  it('declares the exact permission the API enforces on GET /api/transcription-settings', () => {
    // `transcription-settings.controller.ts`. Not a pair of its own, and
    // deliberately: this page edits the `transcription` NAMESPACE of the
    // `global` system_settings row, which `system-settings.controller.ts`
    // already gates on exactly these strings.
    expect(card?.permission).toBe('system_settings:read');
  });

  it('lives under General, not Operations', () => {
    // General is configuration an administrator SETS, which then sits there.
    // Transcription is a provider choice, a credential and a policy — not a
    // view onto the running system.
    const owner = ADMIN_SECTIONS.find((section) =>
      section.cards.some((entry) => entry.title === 'Transcription'),
    );

    expect(owner?.label).toBe('General');
  });

  it('is routed, not inert', () => {
    expect(card?.disabled).toBeFalsy();
    expect(card?.path).toBeTruthy();
  });

  it('is not an alwaysShow escape hatch — the gate must be able to deny it', () => {
    expect(card?.alwaysShow).toBeUndefined();
  });

  it('is the transcription slice\'s own data, spread in at its old position (#499)', () => {
    // The card is exported as DATA by `@marinoscar/kvox-web/transcription/ui` and
    // spread into General where the literal entry used to be: after Web Push,
    // before AI. The hub, the Console rail and the AppBar title resolver read
    // this one array, so the order here is the order every surface shows.
    expect(card).toBe(kvoxTranscriptionAdminSections.general[0]);
    const general = ADMIN_SECTIONS.find((section) => section.label === 'General');
    const titles = general?.cards.map((entry) => entry.title) ?? [];
    const at = titles.indexOf('Transcription');
    expect(at).toBeGreaterThan(-1);
    expect(titles[at - 1]).toBe('Web Push');
    expect(titles[at + 1]).toBe('AI');
    expect(card?.permission).toBe('system_settings:read');
  });

  it('appears for an admin holding system_settings:read', () => {
    const result = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'system_settings:read',
    );

    expect(titlesOf(result)).toContain('Transcription');
  });

  it('appears in none of the three surfaces for a viewer', () => {
    // One assertion covers the hub, the Console rail and the AppBar title
    // resolver, because all three run this same function.
    const viewerPermissions = ['user_settings:read', 'user_settings:write'];
    const result = visibleSettingsSections(ADMIN_SECTIONS, (permission) =>
      viewerPermissions.includes(permission),
    );

    expect(titlesOf(result)).not.toContain('Transcription');
  });

  it('resolves its route to its own title, not the hub title', () => {
    expect(
      settingsPageTitle(
        ADMIN_SECTIONS,
        ADMIN_HUB_PATH,
        ADMIN_HUB_TITLE,
        '/admin/settings/transcription',
      ),
    ).toBe('Transcription');
  });

  it('is findable by hub search on its title', () => {
    const result = visibleSettingsSections(ADMIN_SECTIONS, () => true, 'transcri');

    expect(titlesOf(result)).toContain('Transcription');
  });
});

/**
 * The four AI cards (#55, epic #45; the platform's since #477, epic #472).
 *
 * The pages are the platform AI slice's (`@marinoscar/platform-web/ai/ui`), so
 * the strings the cards gate on are read off the installed
 * `@marinoscar/platform-api` package (the controllers and the slice's
 * permission declarations) rather than off any app controller (Settings UI
 * Pattern rule 3):
 *
 *   `/settings/ai`              AI Provider: `ai:use` + `feature: 'ai'`
 *   `/admin/settings/ai`        AI: `ai_config:read`, NO feature (it is the switch)
 *   `/admin/settings/ai/models` AI models: `ai_config:read` + `feature: 'ai'`
 *   `/admin/settings/ai/usage`  AI usage: `ai_config:read` + `feature: 'ai'`
 *
 * Getting a gate wrong has a concrete, opposite failure: `ai:use` on an admin
 * card would show the deployment's policy to every user, `ai_config:read` on
 * the user card would hide key management from the Viewer it is for, a
 * `feature` on the admin AI card would make AI impossible to switch back on, and
 * a missing one on the other three would show pages of refused requests while
 * AI is off.
 */
describe('the AI cards (#477)', () => {
  const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src');
  const PLATFORM_AI_DIST = resolve(API_SRC, '../../../node_modules/@marinoscar/platform-api/dist/ai');
  const read = (relative: string) => readFileSync(resolve(PLATFORM_AI_DIST, relative), 'utf8');

  const aiAdminController = read('config/ai-admin.controller.js');
  const aiUsageController = read('usage/ai-usage-admin.controller.js');
  const userKeysController = read('keys/user-ai-keys.controller.js');
  const aiPermissions = read('ai.permissions.js');

  const adminCards = ADMIN_SECTIONS.flatMap((section) => section.cards);
  const userCard = USER_SETTINGS_SECTIONS.flatMap((section) => section.cards).find(
    (entry) => entry.path === '/settings/ai',
  );
  const adminCard = adminCards.find((entry) => entry.path === '/admin/settings/ai');
  const modelsCard = adminCards.find((entry) => entry.path === '/admin/settings/ai/models');
  const usageCard = adminCards.find((entry) => entry.path === '/admin/settings/ai/usage');

  /** Every admin card on the AI surface, discovered the way the packaged suite does. */
  const aiAdminCards = adminCards.filter(
    (card) => card.feature === 'ai' || /(^|\/)ai(\/|$)/.test(card.path ?? ''),
  );

  describe('/settings/ai — the user’s own key', () => {
    it('is declared in USER_SETTINGS_SECTIONS as "AI Provider", under Account', () => {
      expect(userCard?.title).toBe('AI Provider');
      const owner = USER_SETTINGS_SECTIONS.find((section) =>
        section.cards.some((entry) => entry.path === '/settings/ai'),
      );
      expect(owner?.label).toBe('Account');
    });

    it('declares ai:use, the string the platform per-user key routes enforce', () => {
      expect(userCard?.permission).toBe('ai:use');
      expect(aiPermissions).toContain("id: 'ai:use'");
      expect(userKeysController).toContain('PERMISSIONS.AI_USE');
    });

    it('is never confused with a deployment-wide permission', () => {
      expect(String(userCard?.permission)).not.toMatch(/ai_config|system_settings/);
    });

    it('declares feature "ai" and is not an alwaysShow escape hatch', () => {
      expect(userCard?.feature).toBe('ai');
      expect(userCard?.alwaysShow).toBeUndefined();
    });

    it('is routed, not inert', () => {
      expect(userCard?.disabled).toBeFalsy();
    });

    it('shows to a holder of ai:use while AI is on, and to nobody else', () => {
      const holder = visibleSettingsSections(
        USER_SETTINGS_SECTIONS,
        (permission) => permission === 'ai:use',
        '',
        { ai: true },
      );
      expect(titlesOf(holder)).toContain('AI Provider');

      const without = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false, '', {
        ai: true,
      });
      expect(titlesOf(without)).not.toContain('AI Provider');
    });

    it('is hidden while AI is off, for a holder of ai:use, and when the feature map is omitted', () => {
      const off = visibleSettingsSections(
        USER_SETTINGS_SECTIONS,
        (permission) => permission === 'ai:use',
        '',
        { ai: false },
      );
      expect(titlesOf(off)).not.toContain('AI Provider');

      const omitted = visibleSettingsSections(
        USER_SETTINGS_SECTIONS,
        (permission) => permission === 'ai:use',
      );
      expect(titlesOf(omitted)).not.toContain('AI Provider');
    });

    it('resolves its route to its own title, not the hub title, and is findable by title', () => {
      expect(
        settingsPageTitle(
          USER_SETTINGS_SECTIONS,
          USER_HUB_PATH,
          USER_HUB_TITLE,
          '/settings/ai',
          { ai: true },
        ),
      ).toBe('AI Provider');

      const found = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => true, 'ai prov', {
        ai: true,
      });
      expect(titlesOf(found)).toContain('AI Provider');
    });
  });

  describe('/admin/settings/ai — the switch', () => {
    it('is declared in ADMIN_SECTIONS as "AI", under General', () => {
      expect(adminCard?.title).toBe('AI');
      const owner = ADMIN_SECTIONS.find((section) =>
        section.cards.some((entry) => entry.path === '/admin/settings/ai'),
      );
      expect(owner?.label).toBe('General');
    });

    it('declares ai_config:read, which the platform admin controller enforces — never system_settings:read', () => {
      expect(adminCard?.permission).toBe('ai_config:read');
      expect(adminCard?.permission).not.toBe('system_settings:read');
      expect(aiPermissions).toContain("id: 'ai_config:read'");
      expect(aiPermissions).toContain("id: 'ai_config:write'");
      expect(aiAdminController).toContain('PERMISSIONS.AI_CONFIG_READ');
      expect(aiAdminController).toContain('PERMISSIONS.AI_CONFIG_WRITE');
    });

    it('carries NO feature: it is where AI is switched on, so it stays reachable while AI is off (AI rule 5)', () => {
      expect(adminCard?.feature).toBeUndefined();
      expect('feature' in (adminCard as object)).toBe(false);

      const holder = (permission: string) => permission === 'ai_config:read';
      expect(titlesOf(visibleSettingsSections(ADMIN_SECTIONS, holder, '', { ai: false }))).toContain(
        'AI',
      );
      expect(titlesOf(visibleSettingsSections(ADMIN_SECTIONS, holder))).toContain('AI');
    });

    it('is not an alwaysShow escape hatch — the gate must be able to deny it', () => {
      expect(adminCard?.alwaysShow).toBeUndefined();
    });

    it('is hidden from a system_settings admin who lacks ai_config:read, and from a viewer', () => {
      const settingsAdmin = visibleSettingsSections(
        ADMIN_SECTIONS,
        (permission) => permission.startsWith('system_settings:'),
        '',
        { ai: true },
      );
      expect(titlesOf(settingsAdmin)).not.toContain('AI');

      const viewer = visibleSettingsSections(
        ADMIN_SECTIONS,
        (permission) => ['user_settings:read', 'user_settings:write'].includes(permission),
        '',
        { ai: true },
      );
      expect(titlesOf(viewer)).not.toContain('AI');
    });

    it('resolves its route to its own title, not the hub title', () => {
      expect(
        settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/ai'),
      ).toBe('AI');
    });
  });

  describe('/admin/settings/ai/models and /usage — the platform pages', () => {
    it('are appended last in General, as AI models then AI usage', () => {
      const general = ADMIN_SECTIONS.find((section) => section.label === 'General');
      expect(general?.cards.slice(-2).map((card) => card.title)).toEqual(['AI models', 'AI usage']);
    });

    it.each([
      ['AI models', modelsCard, '/admin/settings/ai/models'],
      ['AI usage', usageCard, '/admin/settings/ai/usage'],
    ] as const)('%s is routed at its path, gated on ai_config:read and feature "ai"', (_title, card, path) => {
      expect(card?.path).toBe(path);
      expect(card?.permission).toBe('ai_config:read');
      expect(card?.feature).toBe('ai');
      expect(card?.alwaysShow).toBeUndefined();
      expect(card?.disabled).toBeUndefined();
    });

    it('read ai_config:read off the controllers they front', () => {
      // Models and the catalogue are the admin controller's; usage is its own.
      expect(aiAdminController).toContain('/api/admin/ai/models');
      expect(aiUsageController).toContain('/api/admin/ai/usage');
      expect(aiUsageController).toContain('PERMISSIONS.AI_CONFIG_READ');
    });

    it('show to an ai_config:read holder while AI is on, and hide while it is off or unknown', () => {
      const holder = (permission: string) => permission === 'ai_config:read';

      const on = titlesOf(visibleSettingsSections(ADMIN_SECTIONS, holder, '', { ai: true }));
      expect(on).toEqual(expect.arrayContaining(['AI', 'AI models', 'AI usage']));

      const off = titlesOf(visibleSettingsSections(ADMIN_SECTIONS, holder, '', { ai: false }));
      expect(off).toContain('AI');
      expect(off).not.toContain('AI models');
      expect(off).not.toContain('AI usage');

      const unknown = titlesOf(visibleSettingsSections(ADMIN_SECTIONS, holder));
      expect(unknown).not.toContain('AI models');
      expect(unknown).not.toContain('AI usage');
    });

    it('title their nested routes by longest prefix, not as "AI"', () => {
      const titleOf = (path: string) =>
        settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, path, { ai: true });
      expect(titleOf('/admin/settings/ai/models')).toBe('AI models');
      expect(titleOf('/admin/settings/ai/usage')).toBe('AI usage');
    });
  });

  describe('across the whole AI surface (the packaged settings-ai-cards rules)', () => {
    it('discovers the three admin cards and the one user card', () => {
      expect(aiAdminCards.map((card) => card.title)).toEqual(['AI', 'AI models', 'AI usage']);
      expect(userCard).toBeDefined();
    });

    it('every admin AI card declares exactly one ai_config:* permission, never ai:use', () => {
      for (const card of aiAdminCards) {
        expect(['ai_config:read', 'ai_config:write'], card.title).toContain(card.permission);
      }
    });

    it('every AI card declares feature "ai" except the admin AI card itself', () => {
      const missing = [...aiAdminCards, userCard]
        .filter((card) => card?.path !== '/admin/settings/ai')
        .filter((card) => card?.feature !== 'ai');
      expect(missing).toEqual([]);
    });

    it('an admin holding every OTHER permission still sees no AI card, with the feature on', () => {
      const result = visibleSettingsSections(
        ADMIN_SECTIONS,
        (permission) => !['ai:use', 'ai_config:read', 'ai_config:write'].includes(permission),
        '',
        { ai: true },
      );
      const shown = titlesOf(result);
      expect(aiAdminCards.filter((card) => shown.includes(card.title))).toEqual([]);
    });

    it('registers the "ai" feature key the three gated cards resolve through', () => {
      expect(registeredSettingsFeatures()).toContain('ai');
    });
  });

  it('keeps the two destinations distinct — neither shadows the other’s title', () => {
    expect(
      settingsPageTitle(USER_SETTINGS_SECTIONS, USER_HUB_PATH, USER_HUB_TITLE, '/settings/ai', {
        ai: true,
      }),
    ).toBe('AI Provider');
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/ai'),
    ).toBe('AI');
    // The admin registry knows nothing about the user route, and vice versa.
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/settings/ai'),
    ).toBeNull();
  });
});

/**
 * Issue #126, epic #118 (decision 8) — the `About` card.
 *
 * Two things worth asserting that nothing else does:
 *
 *  1. IT IS A GENERAL CARD, AFTER MAINTENANCE, and it is the only card that
 *     is strictly neither "configuration an administrator sets" nor "the
 *     running system". It lives in General because its permission IS the
 *     General permission; an Operations card would have to carry one of the
 *     strings the Operations controllers enforce, none of which the About
 *     controller checks.
 *  2. THE PERMISSION IS LITERALLY THE STRING `about.controller.ts` ENFORCES —
 *     `system_settings:read`, read off the API workspace rather than restated,
 *     per CLAUDE.md Settings UI Pattern rule 3. There is deliberately no
 *     `about:read`: a permission no role is seeded with would be a card nobody
 *     can open.
 */
describe('the About card (#126)', () => {
  const general = ADMIN_SECTIONS.find((section) => section.label === 'General');
  const about = general?.cards.find((card) => card.title === 'About');

  const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src');
  // Issue #465: the permission ids are no longer literals in
  // `roles.constants.ts` (derived from the platform registries); the committed
  // catalog `apps/api/prisma/catalog/permissions.json` is the file that lists
  // every permission the API seeds and enforces, and CI keeps it in sync.
  const permissionCatalog = readFileSync(
    resolve(API_SRC, '../prisma/catalog/permissions.json'),
    'utf8',
  );
  // Issue #464: the About controller is the platform's
  // (`@marinoscar/platform-api/host`), so the string it enforces is read off the
  // installed package rather than off `apps/api/src/about/` (deleted).
  const aboutController = readFileSync(
    resolve(API_SRC, '../../../node_modules/@marinoscar/platform-api/dist/host/about/about.controller.js'),
    'utf8',
  );

  it('sits directly after Maintenance (#469 appends Storage after it)', () => {
    // Appended, not inserted: the hub, the rail and the drill-down list all
    // render this array in declaration order, and an insertion would move
    // cards a reader has learnt the position of. Storage (#469) is appended
    // after About for the same reason, and AI models / AI usage (#477) after
    // Storage.
    const titles = general?.cards.map((card) => card.title) ?? [];
    expect(titles.indexOf('About')).toBe(titles.indexOf('Maintenance') + 1);
    expect(titles.at(-3)).toBe('Storage');
  });

  it('is routed to /admin/settings/about, and is not inert', () => {
    expect(about?.path).toBe('/admin/settings/about');
    expect(about?.disabled).toBeUndefined();
    expect(about?.alwaysShow).toBeUndefined();
  });

  it('carries the description the page mirrors word for word', () => {
    expect(about?.description).toBe(
      'What is running here: version, revision, when it was installed and last updated, and the server it runs on.',
    );
  });

  it('binds to system_settings:read, which about.controller.ts enforces — and to no about:read', () => {
    expect(about?.permission).toBe('system_settings:read');
    expect(permissionCatalog).toContain('"system_settings:read"');
    // The mechanical half of rule 3: the controller really does gate on it.
    expect(aboutController).toContain('SYSTEM_SETTINGS_READ');
    // And the permission the card would have invented does not exist anywhere
    // the API could seed it.
    expect(permissionCatalog).not.toMatch(/about:read/);
  });

  it('is visible to a system_settings:read holder and to nobody without it', () => {
    const settingsOnly = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'system_settings:read',
    );
    expect(titlesOf(settingsOnly)).toContain('About');

    const usersOnly = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'users:read',
    );
    expect(titlesOf(usersOnly)).not.toContain('About');
  });

  it('titles the compact AppBar "About" at its route', () => {
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/about'),
    ).toBe('About');
  });
});

/**
 * The Doctor card (#464, epic #462). The card is the PACKAGE'S entry
 * (`doctorSettingsPage.card`), appended to Operations; what this app owns is
 * that it is registered, routed, and gated on the string the API enforces.
 */
describe('the Doctor card (#464)', () => {
  const operations = ADMIN_SECTIONS.find((section) => section.label === 'Operations');
  const doctor = operations?.cards.find((card) => card.title === 'Doctor');

  // The Doctor controller is the platform's (`@marinoscar/platform-api/doctor`),
  // so the string it enforces is read off the installed package.
  const doctorModule = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../../node_modules/@marinoscar/platform-api/dist/doctor/doctor.module.js',
    ),
    'utf8',
  );

  it('is the last Operations card, routed to /admin/settings/doctor and not inert', () => {
    expect(operations?.cards.at(-1)?.title).toBe('Doctor');
    expect(doctor?.path).toBe('/admin/settings/doctor');
    expect(doctor?.disabled).toBeUndefined();
    expect(doctor?.Icon).toBeDefined();
  });

  it('binds to system_settings:read, the permission the platform controller defaults to', () => {
    expect(doctor?.permission).toBe('system_settings:read');
    expect(doctorModule).toContain("exports.DEFAULT_DOCTOR_PERMISSION = 'system_settings:read'");
  });

  it('is visible to a system_settings:read holder and to nobody without it', () => {
    const settingsOnly = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'system_settings:read',
    );
    expect(titlesOf(settingsOnly)).toContain('Doctor');

    const usersOnly = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'users:read',
    );
    expect(titlesOf(usersOnly)).not.toContain('Doctor');
  });

  it('titles the compact AppBar "Doctor" at its route', () => {
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/doctor'),
    ).toBe('Doctor');
  });
});

/**
 * The Storage card (#469, epic #467). The page is the platform storage slice's
 * (`StorageConfigPage`, `@marinoscar/platform-web/storage/ui`), so the string
 * the card gates on is read off the installed `@marinoscar/platform-api`
 * package rather than off any app controller (CLAUDE.md Settings UI Pattern
 * rule 3).
 */
describe('the Storage card (#469)', () => {
  const general = ADMIN_SECTIONS.find((section) => section.label === 'General');
  const storage = general?.cards.find((card) => card.title === 'Storage');

  const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src');
  const PLATFORM_API_DIST = resolve(API_SRC, '../../../node_modules/@marinoscar/platform-api/dist');
  const permissionCatalog = readFileSync(
    resolve(API_SRC, '../prisma/catalog/permissions.json'),
    'utf8',
  );
  const storageController = readFileSync(
    resolve(PLATFORM_API_DIST, 'storage/config/storage-config.controller.js'),
    'utf8',
  );

  it('is the last General card but the two AI cards #477 appended, in General and not Operations', () => {
    expect(general?.cards.at(-3)?.title).toBe('Storage');
    expect(general?.cards.slice(-2).map((card) => card.title)).toEqual(['AI models', 'AI usage']);
  });

  it('is routed to /admin/settings/storage, and is not inert', () => {
    expect(storage?.path).toBe('/admin/settings/storage');
    expect(storage?.disabled).toBeUndefined();
    expect(storage?.alwaysShow).toBeUndefined();
  });

  it('binds to storage_config:read, which the platform controller enforces — never storage:read', () => {
    expect(storage?.permission).toBe('storage_config:read');
    expect(storage?.permission).not.toBe('storage:read');
    expect(storage?.permission).not.toBe('system_settings:read');
    expect(permissionCatalog).toContain('"storage_config:read"');
    expect(permissionCatalog).toContain('"storage_config:write"');
    expect(storageController).toContain('STORAGE_CONFIG_READ');
    expect(storageController).toContain('STORAGE_CONFIG_WRITE');
  });

  it('is visible to a storage_config:read holder and to nobody without it', () => {
    const holder = visibleSettingsSections(
      ADMIN_SECTIONS,
      (permission) => permission === 'storage_config:read',
    );
    expect(titlesOf(holder)).toEqual(['Storage']);

    for (const other of ['system_settings:read', 'storage:read', 'users:read']) {
      const result = visibleSettingsSections(ADMIN_SECTIONS, (p) => p === other);
      expect(titlesOf(result)).not.toContain('Storage');
    }
  });

  it('titles the compact AppBar "Storage" at its route', () => {
    expect(
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, '/admin/settings/storage'),
    ).toBe('Storage');
  });
});

/**
 * The Observability cards (#471, epic #467). The pages are the platform's
 * telemetry slice (`@marinoscar/platform-web/telemetry/ui`), so the strings the
 * cards gate on are read off the installed `@marinoscar/platform-api` package
 * rather than off any app controller (CLAUDE.md Settings UI Pattern rule 3).
 */
describe('the Observability cards (#471)', () => {
  const observability = ADMIN_SECTIONS.find((section) => section.label === 'Observability');
  const cardsByTitle = new Map(
    ADMIN_SECTIONS.flatMap((section) => section.cards).map((card) => [card.title, card]),
  );

  const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../api/src');
  const PLATFORM_TELEMETRY_DIST = resolve(
    API_SRC,
    '../../../node_modules/@marinoscar/platform-api/dist/telemetry',
  );
  const permissionCatalog = readFileSync(
    resolve(API_SRC, '../prisma/catalog/permissions.json'),
    'utf8',
  );
  const adminController = readFileSync(
    resolve(PLATFORM_TELEMETRY_DIST, 'telemetry-admin.controller.js'),
    'utf8',
  );
  const explorerController = readFileSync(
    resolve(PLATFORM_TELEMETRY_DIST, 'telemetry-explorer.controller.js'),
    'utf8',
  );
  const telemetryPermissions = readFileSync(
    resolve(PLATFORM_TELEMETRY_DIST, 'telemetry.permissions.js'),
    'utf8',
  );

  it('is APPENDED as the last group, after the three that existed', () => {
    expect(ADMIN_SECTIONS.at(-1)?.label).toBe('Observability');
  });

  it('declares the three cards in the package’s order, none inserted into an existing group', () => {
    expect(observability?.cards.map((card) => card.title)).toEqual([
      'Telemetry',
      'Telemetry Explorer',
      'Telemetry Dashboard',
    ]);
    for (const section of ADMIN_SECTIONS) {
      if (section.label === 'Observability') continue;
      expect(
        section.cards.some((card) => card.title.startsWith('Telemetry')),
        `${section.label} must not carry a telemetry card`,
      ).toBe(false);
    }
  });

  it('routes every card, none of them inert', () => {
    expect(cardsByTitle.get('Telemetry')?.path).toBe('/admin/settings/telemetry');
    expect(cardsByTitle.get('Telemetry Explorer')?.path).toBe('/admin/settings/telemetry/explorer');
    expect(cardsByTitle.get('Telemetry Dashboard')?.path).toBe(
      '/admin/settings/telemetry/dashboard',
    );
    for (const card of observability?.cards ?? []) {
      expect(card.disabled, `${card.title} must not be inert`).toBeUndefined();
      expect(card.alwaysShow, `${card.title} must be deniable`).toBeUndefined();
    }
  });

  it('binds Telemetry to telemetry:read, which the platform admin controller enforces', () => {
    expect(cardsByTitle.get('Telemetry')?.permission).toBe('telemetry:read');
    expect(cardsByTitle.get('Telemetry')?.permission).not.toBe('system_settings:read');
    expect(permissionCatalog).toContain('"telemetry:read"');
    expect(permissionCatalog).toContain('"telemetry:write"');
    expect(telemetryPermissions).toContain("id: 'telemetry:read'");
    expect(telemetryPermissions).toContain("id: 'telemetry:write'");
    expect(adminController).toContain('TELEMETRY_PERMISSIONS.READ');
    expect(adminController).toContain('TELEMETRY_PERMISSIONS.WRITE');
  });

  it('binds the Explorer and the Dashboard to telemetry:query, which the platform explorer controller enforces', () => {
    for (const title of ['Telemetry Explorer', 'Telemetry Dashboard']) {
      expect(cardsByTitle.get(title)?.permission, title).toBe('telemetry:query');
    }
    expect(permissionCatalog).toContain('"telemetry:query"');
    expect(telemetryPermissions).toContain("id: 'telemetry:query'");
    expect(explorerController).toContain('TELEMETRY_PERMISSIONS.QUERY');
  });

  it('gates only the Explorer and the Dashboard on the telemetry feature, never the settings page', () => {
    // The settings page is where telemetry is switched on: it must be reachable
    // while the feature is off.
    expect(cardsByTitle.get('Telemetry')?.feature).toBeUndefined();
    expect(cardsByTitle.get('Telemetry Explorer')?.feature).toBe('telemetry');
    expect(cardsByTitle.get('Telemetry Dashboard')?.feature).toBe('telemetry');
  });

  it('registers a resolver for the telemetry feature, so the gated cards can open', () => {
    expect(registeredSettingsFeatures()).toContain('telemetry');
  });

  describe('visibility', () => {
    it('shows a telemetry:read holder the settings card alone, with the feature on or off', () => {
      const holds = (permission: string) => permission === 'telemetry:read';
      expect(titlesOf(visibleSettingsSections(ADMIN_SECTIONS, holds))).toEqual(['Telemetry']);
      expect(
        titlesOf(visibleSettingsSections(ADMIN_SECTIONS, holds, undefined, { telemetry: true })),
      ).toEqual(['Telemetry']);
    });

    it('hides the Explorer and the Dashboard from a telemetry:query holder until the feature is on (fail closed)', () => {
      const holds = (permission: string) => permission === 'telemetry:query';
      expect(titlesOf(visibleSettingsSections(ADMIN_SECTIONS, holds))).toEqual([]);
      expect(
        titlesOf(visibleSettingsSections(ADMIN_SECTIONS, holds, undefined, { telemetry: false })),
      ).toEqual([]);
      expect(
        titlesOf(visibleSettingsSections(ADMIN_SECTIONS, holds, undefined, { telemetry: true })),
      ).toEqual(['Telemetry Explorer', 'Telemetry Dashboard']);
    });

    it('shows nothing to a system_settings admin who was never granted a telemetry permission', () => {
      const result = visibleSettingsSections(
        ADMIN_SECTIONS,
        (permission) => permission === 'system_settings:read',
        undefined,
        { telemetry: true },
      );
      expect(result.find((section) => section.label === 'Observability')).toBeUndefined();
    });
  });

  describe('the AppBar title resolver', () => {
    const titleFor = (pathname: string) =>
      settingsPageTitle(ADMIN_SECTIONS, ADMIN_HUB_PATH, ADMIN_HUB_TITLE, pathname, {
        telemetry: true,
      });

    it('titles the three routes, the nested ones by longest prefix', () => {
      expect(titleFor('/admin/settings/telemetry')).toBe('Telemetry');
      expect(titleFor('/admin/settings/telemetry/explorer')).toBe('Telemetry Explorer');
      expect(titleFor('/admin/settings/telemetry/dashboard')).toBe('Telemetry Dashboard');
    });
  });
});
