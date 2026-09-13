import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  DESTINATIONS,
  DESTINATION_ROUTES,
  UNOWNED_ROUTES,
  isDestinationVisible,
  owns,
  resolveActiveDestination,
} from '../../config/destinations';
import type { Destination, DestinationKey } from '../../config/destinations';
import { ADMIN_SECTIONS } from '../../config/adminSections';

/**
 * The route-ownership table is the one piece of this navigation that manual
 * testing cannot check: a route claimed by two destinations emits
 * `aria-current="page"` twice and highlights two rail rows, and a route claimed
 * by none silently highlights nothing. Both look fine on the screen you happen
 * to be standing on.
 *
 * So this suite reads the LIVE `App.tsx` rather than a copy of its route list.
 * A hand-maintained copy would drift the first time someone adds a route, which
 * is exactly the moment the assertion is supposed to fire.
 */
const APP_TSX = resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx');

function declaredRoutePaths(): string[] {
  const source = readFileSync(APP_TSX, 'utf8');
  const paths = [...source.matchAll(/path="([^"]+)"/g)].map((match) => match[1]);
  // `*` is the catch-all, which redirects to `/` rather than rendering a page.
  return [...new Set(paths)].filter((path) => path !== '*');
}

describe('destinations — route ownership', () => {
  it('finds the destination routes, the admin pages and the public ones in App.tsx', () => {
    // Guards the regex above: if it silently stopped matching, every assertion
    // below would pass vacuously over an empty list.
    //
    // `/admin/users` is still in this list after #92 — as a redirect route to
    // `/admin/settings/users` rather than a page. That is the point of the
    // redirect: the path is DECLARED, so a bookmark reaches it instead of
    // falling through `*` to `/`.
    const paths = declaredRoutePaths();
    expect(paths).toEqual(
      expect.arrayContaining([
        '/',
        '/settings',
        '/admin',
        '/admin/users',
        '/admin/settings',
        '/admin/settings/notifications',
        '/admin/settings/maintenance',
        '/admin/settings/users',
      ]),
    );
    expect(paths.length).toBeGreaterThanOrEqual(8);
  });

  it('declares no route for the pages removed by #366', () => {
    // System, Appearance, Feature Flags and Advanced (JSON) were removed
    // outright, not merely hidden — a regression guard against any of the
    // four quietly getting a route back.
    const paths = declaredRoutePaths();
    expect(paths).not.toContain('/admin/settings/general');
    expect(paths).not.toContain('/admin/settings/appearance');
    expect(paths).not.toContain('/admin/settings/feature-flags');
    expect(paths).not.toContain('/admin/settings/advanced');
  });

  it('claims every route in App.tsx exactly once, or deliberately not at all', () => {
    for (const path of declaredRoutePaths()) {
      const owners = (Object.keys(DESTINATION_ROUTES) as DestinationKey[]).filter((key) =>
        DESTINATION_ROUTES[key].some((prefix) => owns(prefix, path)),
      );

      if (UNOWNED_ROUTES.includes(path)) {
        expect(owners, `${path} is listed as unowned but a destination claims it`).toEqual([]);
      } else {
        // NOT `toHaveLength(1)` with a bare message: naming the owners is what
        // makes the failure actionable when it does fire.
        expect(owners, `${path} should be owned by exactly one destination`).toHaveLength(1);
      }
    }
  });

  it('lists every declared route as either owned or explicitly unowned', () => {
    // The complement of the assertion above: a route that is neither claimed
    // nor listed as deliberately unowned is an OVERSIGHT, and without this it
    // would pass the previous test by being "unowned by accident".
    for (const path of declaredRoutePaths()) {
      const owned = resolveActiveDestination(path) !== null;
      const explicitlyUnowned = UNOWNED_ROUTES.includes(path);
      expect(
        owned || explicitlyUnowned,
        `${path} is neither owned by a destination nor listed in UNOWNED_ROUTES`,
      ).toBe(true);
    }
  });

  it('highlights NOTHING on the deliberately unowned routes', () => {
    // Asserted explicitly so a later contributor does not "fix" this into
    // highlighting something arbitrary. No destination is better than a wrong
    // one — the login screen does not belong to Home.
    for (const path of UNOWNED_ROUTES) {
      expect(resolveActiveDestination(path), `${path} must activate no destination`).toBeNull();
    }
  });

  it('gives every destination in the table a route it owns', () => {
    for (const destination of DESTINATIONS) {
      expect(
        resolveActiveDestination(destination.path),
        `${destination.path} should activate ${destination.key}`,
      ).toBe(destination.key);
    }
  });
});

describe('destinations — segment-boundary matching', () => {
  it('matches a prefix only at a segment boundary', () => {
    expect(owns('/settings', '/settings')).toBe(true);
    expect(owns('/settings', '/settings/profile')).toBe(true);
    expect(owns('/settings', '/settingsfoo')).toBe(false);
    expect(owns('/settings', '/settings-archive')).toBe(false);
  });

  it('does not let /settingsfoo activate User Settings', () => {
    // A bare `startsWith` — what the old Sidebar's isActive did — matches here.
    expect(resolveActiveDestination('/settingsfoo')).toBeNull();
  });

  it('does not let /adminfoo activate Console', () => {
    // `/admin/users-archive` used to be this assertion's example, back when
    // `users` owned `/admin/users`. Since #92 `console` owns the whole `/admin`
    // subtree, so that path legitimately activates Console — the boundary that
    // still matters is the one at the end of `/admin` itself.
    expect(resolveActiveDestination('/adminfoo')).toBeNull();
    expect(resolveActiveDestination('/admin-archive')).toBeNull();
    expect(resolveActiveDestination('/admin/users-archive')).toBe('console');
  });

  it('activates Home on / only, never on any other path', () => {
    // Every path starts with '/', so without the exact-match rule Home would
    // own the entire app and beat nothing only by prefix length.
    expect(resolveActiveDestination('/')).toBe('home');
    expect(resolveActiveDestination('/settings')).not.toBe('home');
    expect(resolveActiveDestination('/admin/settings')).not.toBe('home');
    expect(owns('/', '/anything')).toBe(false);
  });

  it('activates a destination for its child routes', () => {
    expect(resolveActiveDestination('/settings/profile')).toBe('settings');
    expect(resolveActiveDestination('/admin/settings/users')).toBe('console');
    expect(resolveActiveDestination('/admin/settings/users/abc-123')).toBe('console');
  });

  it('gives Console the whole /admin subtree, bare path included', () => {
    // #92: one admin destination, not two. `console` owns `/admin` rather than
    // `/admin/settings`, so the bare `/admin` redirect route and the
    // `/admin/users` redirect route both highlight it for the frame they
    // render — with `/admin/settings` as the prefix they would have
    // highlighted nothing.
    expect(resolveActiveDestination('/admin')).toBe('console');
    expect(resolveActiveDestination('/admin/users')).toBe('console');
    expect(resolveActiveDestination('/admin/settings')).toBe('console');
    expect(resolveActiveDestination('/admin/settings/notifications')).toBe('console');
  });
});

describe('destinations — reachability regression', () => {
  /**
   * The design's central claim is that replacing the drawer makes nothing
   * unreachable. These are the four rows the deleted `Sidebar` offered, by the
   * paths it navigated to.
   */
  const OLD_SIDEBAR_PATHS = ['/', '/settings', '/admin/users', '/admin/settings'];

  it('still resolves every path the old Sidebar menu offered', () => {
    for (const path of OLD_SIDEBAR_PATHS) {
      expect(resolveActiveDestination(path), `${path} became unreachable`).not.toBeNull();
    }
  });

  it('offers three destinations, with the two admin rows merged into Console', () => {
    // NOT four any more (#92). `/admin/users` stops being a destination PATH
    // while staying a resolvable route — it redirects to
    // `/admin/settings/users`, and the assertion above is what proves the
    // merge cost no reachability.
    expect(DESTINATIONS.map((destination) => destination.path).sort()).toEqual([
      '/',
      '/admin/settings',
      '/settings',
    ]);
  });
});

describe('destinations — the table itself', () => {
  it('gates Console on either permission the API enforces, never on one alone', () => {
    // Verified against the controllers, not assumed:
    //   users.controller.ts           → PERMISSIONS.USERS_READ
    //   system-settings.controller.ts → PERMISSIONS.SYSTEM_SETTINGS_READ
    //
    // Both, because `/admin/settings` fronts pages from both. The obvious way
    // to get this wrong while merging two destinations into one is to keep
    // whichever permission was typed first and silently strip the other, which
    // would lock a users-only admin out of the surface entirely.
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));
    expect(byKey.console.permission).toBeUndefined();
    expect([...(byKey.console.anyPermission ?? [])].sort()).toEqual([
      'system_settings:read',
      'users:read',
    ]);
  });

  it('reads anyPermission as OR, and permission as a hard requirement', () => {
    const [consoleDestination] = DESTINATIONS.filter((d) => d.key === 'console');
    const holding = (granted: string[]) => (permission: string) =>
      granted.includes(permission);

    expect(isDestinationVisible(consoleDestination, holding(['users:read']))).toBe(true);
    expect(
      isDestinationVisible(consoleDestination, holding(['system_settings:read'])),
    ).toBe(true);
    expect(isDestinationVisible(consoleDestination, holding([]))).toBe(false);
    // The admin ROLE grants nothing here; only permissions do.
    expect(isDestinationVisible(consoleDestination, holding(['rbac:manage']))).toBe(false);

    // The two fields AND together when both are set — stated in the type's
    // comment, asserted here so the rule is not just prose.
    const both: Destination = {
      ...consoleDestination,
      permission: 'users:write',
      anyPermission: ['users:read'],
    };
    expect(isDestinationVisible(both, holding(['users:read']))).toBe(false);
    expect(isDestinationVisible(both, holding(['users:write']))).toBe(false);
    expect(isDestinationVisible(both, holding(['users:write', 'users:read']))).toBe(true);
  });

  it('leaves the non-admin destinations open to any authenticated user', () => {
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));
    expect(byKey.home.permission).toBeUndefined();
    expect(byKey.settings.permission).toBeUndefined();
  });

  it('marks Console pinned and leaves Home and Settings as ordinary list rows (#105)', () => {
    // The rail's foot section is driven entirely by this flag — see
    // `NavigationRail`'s `listDestinations`/`pinnedDestinations` split — so a
    // console row that stops being flagged `pinned` silently falls back to
    // rendering inline as a third library destination, with no other signal.
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));
    expect(byKey.console.pinned).toBe(true);
    expect(byKey.home.pinned).toBeFalsy();
    expect(byKey.settings.pinned).toBeFalsy();
  });

  it('declares Icon as a component, never as a rendered element', () => {
    // Surfaces draw the icon at different sizes — the rail at `small` when
    // collapsed and `medium` when expanded — so a pre-rendered element here
    // would bake one size into every surface that consumes the table.
    for (const destination of DESTINATIONS) {
      expect(
        isValidElement(destination.Icon),
        `${destination.key} Icon must be a component, not a rendered element`,
      ).toBe(false);
      expect(destination.Icon).toBeTruthy();
    }
  });

  it('gives every destination a compactLabel short enough for a 56px rail', () => {
    for (const destination of DESTINATIONS) {
      expect(destination.compactLabel.length, `${destination.key} compactLabel`).toBeLessThanOrEqual(
        8,
      );
    }
  });

  it('caps the destination set at four — the bottom bar ceiling', () => {
    expect(DESTINATIONS.length).toBeLessThanOrEqual(4);
  });
});

/**
 * The registry and the router are two lists of the same admin pages, and epic
 * #90's whole premise is that they cannot be allowed to disagree. A card whose
 * `path` has no route is a hub tile leading to the catch-all; a card whose
 * permission differs from its route's is the split-brain in miniature — the
 * card appears, the click 403s or redirects.
 */
describe('admin sections — registry against the live routes', () => {
  /** Every `<Route>` element in `App.tsx`, as `path` → the `permission` it wraps. */
  function declaredRouteGates(): Map<string, string | null> {
    const source = readFileSync(APP_TSX, 'utf8');
    const gates = new Map<string, string | null>();
    // Split on the element opener so each chunk holds exactly one route, and
    // the first `permission=` inside it is that route's own guard. Chunks that
    // do not start with a `path` — `<Routes>`, the layout and guard routes —
    // fall out on their own. Parsing the file rather than importing the tree
    // keeps this honest about what a reviewer actually reads.
    for (const chunk of source.split('<Route').slice(1)) {
      const path = /^\s*path="([^"]+)"/.exec(chunk)?.[1];
      if (!path) continue;
      gates.set(path, /permission="([^"]+)"/.exec(chunk)?.[1] ?? null);
    }
    return gates;
  }

  it('routes every card path, under the exact permission the card declares', () => {
    const gates = declaredRouteGates();
    const cards = ADMIN_SECTIONS.flatMap((section) => section.cards);
    expect(cards.length).toBeGreaterThan(0);

    for (const card of cards) {
      if (!card.path) continue;
      expect(gates.has(card.path), `${card.title} → ${card.path} has no route`).toBe(true);
      expect(gates.get(card.path), `${card.title} route gate`).toBe(card.permission);
    }
  });

  it('gives Email (#124) its own card, routed and gated on system_settings:read like its three siblings', () => {
    // Saving and test-sending need `system_settings:write`, but that is the
    // PAGE's own internal gate — see `EmailSettingsPage`'s `canWrite` — not
    // the card's reachability gate, which mirrors the read-only siblings so a
    // read-only admin can still open the page to diagnose "why is mail
    // broken".
    const gates = declaredRouteGates();
    const emailCard = ADMIN_SECTIONS.flatMap((section) => section.cards).find(
      (card) => card.title === 'Email',
    );

    expect(emailCard).toBeDefined();
    expect(emailCard?.path).toBe('/admin/settings/email');
    expect(emailCard?.permission).toBe('system_settings:read');
    expect(gates.get('/admin/settings/email')).toBe('system_settings:read');
  });

  it('leaves the old admin URLs as declared redirect routes, not catch-all fallout', () => {
    const gates = declaredRouteGates();
    // Declared with no permission of their own: they redirect, and the target
    // route is what gates. A missing entry here means a bookmark lands on `/`.
    expect(gates.has('/admin/users')).toBe(true);
    expect(gates.get('/admin/users')).toBeNull();
    expect(gates.has('/admin')).toBe(true);
    expect(gates.get('/admin')).toBeNull();
  });

  it('puts every card inside the Console destination', () => {
    for (const card of ADMIN_SECTIONS.flatMap((section) => section.cards)) {
      if (!card.path) continue;
      expect(resolveActiveDestination(card.path), `${card.path} activates`).toBe('console');
    }
  });
});

/**
 * Issue #92 regression. The `console` destination becomes VISIBLE (a rail row,
 * a menu entry, a quick action) whenever the user holds either permission in
 * `anyPermission` — but the `/admin/settings` route itself once kept only
 * `system_settings:read`. A user holding `users:read` alone saw the row,
 * clicked it, and was bounced straight back to `/`: the destination said "you
 * can go here" and the route said "no you can't", and nothing but a manual
 * click-through would ever have caught the disagreement.
 *
 * This suite reads BOTH sides live rather than restating either as a hardcoded
 * list — `declaredRoutePermissions` parses the actual `<Route path="/admin/settings">`
 * element out of `App.tsx`, and `DESTINATIONS` is the same import every other
 * suite in this file uses — so the two can never silently drift again: change
 * either one without the other and this test is the one that fires.
 */
describe('destinations — route gate matches the console anyPermission (#92)', () => {
  /**
   * The permission(s) that gate the exact route `targetPath`, read straight out
   * of `App.tsx`. Handles both shapes `RequirePermission` accepts: a single
   * `permission="x"` string, and a `permissions={['a', 'b']}` array (ANY, since
   * `requireAll` defaults to false — see `RequirePermission.tsx`). Deliberately
   * separate from `declaredRouteGates()` above, which only ever reads the
   * single-string form used by every OTHER route in this file.
   */
  function declaredRoutePermissions(targetPath: string): string[] {
    const source = readFileSync(APP_TSX, 'utf8');
    for (const chunk of source.split('<Route').slice(1)) {
      const path = /^\s*path="([^"]+)"/.exec(chunk)?.[1];
      if (path !== targetPath) continue;

      const arrayMatch = /permissions=\{\s*\[([^\]]*)\]\s*\}/.exec(chunk);
      if (arrayMatch) {
        return arrayMatch[1]
          .split(',')
          .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
      }

      const singleMatch = /(?<!s)permission="([^"]+)"/.exec(chunk);
      return singleMatch ? [singleMatch[1]] : [];
    }
    // Not found is a real failure, not "no gate" — surfaced as an empty array
    // that the assertion below rejects via the length check.
    return [];
  }

  it('gates /admin/settings on exactly the permissions the console destination allows', () => {
    const routePermissions = declaredRoutePermissions('/admin/settings');
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));
    const destinationPermissions = [...(byKey.console.anyPermission ?? [])];

    // Guards the parser itself: if it silently stopped matching (or the route
    // were ever found ungated), the set-equality check below would pass
    // vacuously by comparing two empty arrays.
    expect(
      routePermissions.length,
      '/admin/settings has no parsed permission gate — either the route lost its guard or the parser regex stopped matching',
    ).toBeGreaterThan(0);
    expect(destinationPermissions.length).toBeGreaterThan(0);

    expect(
      [...routePermissions].sort(),
      'the /admin/settings route permissions and the console destination anyPermission set must be identical',
    ).toEqual([...destinationPermissions].sort());
  });
});
