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
  it('shows every user-settings card, since none of them declare a permission', () => {
    const result = visibleSettingsSections(USER_SETTINGS_SECTIONS, () => false);

    expect(titlesOf(result).sort()).toEqual(titlesOf(USER_SETTINGS_SECTIONS).sort());
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
    expect(ADMIN_SECTIONS.map((section) => section.label)).toEqual([
      'General',
      'Access',
      'Operations',
    ]);
  });

  it('registers all four of the epic’s cards at once, and epic #319 appends a fifth', () => {
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
    const rolesConstants = readFileSync(
      resolve(API_SRC, 'common/constants/roles.constants.ts'),
      'utf8',
    );
    const jobsController = readFileSync(
      resolve(API_SRC, 'jobs/job-admin.controller.ts'),
      'utf8',
    );
    const nodesAdminController = readFileSync(
      resolve(API_SRC, 'nodes/nodes-admin.controller.ts'),
      'utf8',
    );
    const broadcastsController = readFileSync(
      resolve(API_SRC, 'notifications/broadcasts/broadcasts.controller.ts'),
      'utf8',
    );
    const dbBackupController = readFileSync(
      resolve(API_SRC, 'db-backup/db-backup.controller.ts'),
      'utf8',
    );

    it('binds both Jobs cards to jobs:read, which job-admin.controller.ts enforces on its reads', () => {
      expect(cardsByTitle.get('Jobs')?.permission).toBe('jobs:read');
      expect(cardsByTitle.get('Job Insights')?.permission).toBe('jobs:read');
      expect(rolesConstants).toContain("JOBS_READ: 'jobs:read'");
      expect(jobsController).toContain('PERMISSIONS.JOBS_READ');
    });

    it('binds Worker Nodes to nodes:read, never to jobs:read', () => {
      // `roles.constants.ts` splits the two deliberately: a Workers card gated
      // on `jobs:read` would advertise a permission the nodes controller never
      // checks, so the hub would decide reachability on unrelated evidence.
      expect(cardsByTitle.get('Worker Nodes')?.permission).toBe('nodes:read');
      expect(cardsByTitle.get('Worker Nodes')?.permission).not.toBe('jobs:read');
      expect(rolesConstants).toContain("NODES_READ: 'nodes:read'");
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
      expect(rolesConstants).toContain("BROADCASTS_READ: 'broadcasts:read'");
      expect(rolesConstants).toContain("BROADCASTS_WRITE: 'broadcasts:write'");
      // And the controller really does enforce it — the mechanical half of
      // CLAUDE.md Settings UI Pattern rule 3.
      expect(broadcastsController).toContain('PERMISSIONS.BROADCASTS_READ');
      expect(broadcastsController).toContain('PERMISSIONS.BROADCASTS_WRITE');
    });

    it('binds Database Backup to the dedicated db_backup:read, never to system_settings:read', () => {
      const card = cardsByTitle.get('Database Backup');
      expect(card?.permission).toBe('db_backup:read');
      expect(card?.permission).not.toBe('system_settings:read');
      expect(rolesConstants).toContain("DB_BACKUP_READ: 'db_backup:read'");
      // And the controller really does enforce it — the mechanical half of
      // CLAUDE.md Settings UI Pattern rule 3, now that the card is routed and
      // the string gates a page somebody can actually open (#287).
      expect(dbBackupController).toContain('PERMISSIONS.DB_BACKUP_READ');
      // The THIRD permission is what the split is for: restoring is deliberately
      // not `db_backup:write`, so it can be withheld from someone who may
      // schedule backups but must not be able to replace the database. The card
      // must NOT mirror it — a reachability gate on `restore` would hide the
      // history from the read-only admin the page is most useful to.
      expect(rolesConstants).toContain("DB_BACKUP_RESTORE: 'db_backup:restore'");
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

      expect(result.map((section) => section.label)).toEqual(['General', 'Access']);
      expect(titlesOf(result)).toEqual([
        'Email',
        'Notifications',
        'Maintenance',
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
