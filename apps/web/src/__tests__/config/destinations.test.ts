import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  BOTTOM_BAR_DESTINATIONS,
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
        // #30, epic #19 — the four transcript routes.
        '/transcripts',
        '/transcripts/new',
        '/transcripts/:id',
        '/transcripts/:id/history',
        // #57, epic #45 — the four note routes, their own destination's
        // subtree since #106.
        '/notes',
        '/notes/new',
        '/notes/:id',
        '/notes/:id/history',
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

  it('offers five destinations: Home, Transcripts, Notes, Settings and the merged Console', () => {
    // Three after #92 merged the two admin rows; four once #30 added a library
    // row; FIVE since #106 split that row into Transcripts and Notes. The
    // count grew and the BAR did not — Console is `pinned`, so it is the fifth
    // destination and never a fifth tab. `/admin/users` is still not a
    // destination PATH while staying a resolvable route — it redirects to
    // `/admin/settings/users`, and the assertion above is what proves the
    // merge cost no reachability.
    expect(DESTINATIONS.map((destination) => destination.path).sort()).toEqual([
      '/',
      '/admin/settings',
      '/notes',
      '/settings',
      '/transcripts',
    ]);
  });

  it('keeps Home, Transcripts, Notes, Settings, Console as the declared ORDER', () => {
    // Declaration order IS navigation order on the bottom bar and in the user
    // menu (the rail only lifts `pinned` rows to its foot). Sorting the array
    // above proves membership and says nothing about sequence, so the two
    // assertions are deliberately separate.
    expect(DESTINATIONS.map((destination) => destination.key)).toEqual([
      'home',
      'transcripts',
      'notes',
      'settings',
      'console',
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

  it('leaves Home and User Settings open to any authenticated user', () => {
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));
    expect(byKey.home.permission).toBeUndefined();
    expect(byKey.settings.permission).toBeUndefined();
  });

  it('gates Transcripts on the ONE permission its controller enforces (#106)', () => {
    // Verified against the controller, not assumed:
    //   transcripts.controller.ts → PERMISSIONS.TRANSCRIPTS_READ
    //
    // ⚠ A SINGLE `permission`, NOT AN `anyPermission` PAIR. The pair was
    // correct for the merged `library` row, which fronted two controllers and
    // had to be reachable on either. This row fronts one, so "or" has no
    // meaning here — and leaving the old pair behind would show a Transcripts
    // row to a user holding only `notes:read`, who would then be bounced by
    // `/transcripts`' own route gate. That is the #92 bug, in the exact place
    // #106 was most likely to reintroduce it.
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));
    expect(byKey.transcripts.permission).toBe('transcripts:read');
    expect(byKey.transcripts.anyPermission).toBeUndefined();

    const holding = (granted: string[]) => (permission: string) =>
      granted.includes(permission);
    expect(isDestinationVisible(byKey.transcripts, holding(['transcripts:read']))).toBe(true);
    expect(isDestinationVisible(byKey.transcripts, holding(['notes:read']))).toBe(false);
    expect(isDestinationVisible(byKey.transcripts, holding([]))).toBe(false);
    // The admin ROLE grants nothing here, exactly as for Console.
    expect(isDestinationVisible(byKey.transcripts, holding(['rbac:manage']))).toBe(false);
  });

  it('gates Notes on the ONE permission its controller enforces (#106)', () => {
    // notes.controller.ts → PERMISSIONS.NOTES_READ. The mirror of the
    // assertion above, and asserted separately rather than as a loop: the way
    // this gets broken is one of the two keeping a stale gate, which a shared
    // loop over "both rows look sane" would not localise.
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));
    expect(byKey.notes.permission).toBe('notes:read');
    expect(byKey.notes.anyPermission).toBeUndefined();

    const holding = (granted: string[]) => (permission: string) =>
      granted.includes(permission);
    expect(isDestinationVisible(byKey.notes, holding(['notes:read']))).toBe(true);
    expect(isDestinationVisible(byKey.notes, holding(['transcripts:read']))).toBe(false);
    expect(isDestinationVisible(byKey.notes, holding([]))).toBe(false);
    expect(isDestinationVisible(byKey.notes, holding(['rbac:manage']))).toBe(false);
  });

  it('labels the two content rows by what they front (#106)', () => {
    // The rail caption, the user-menu row and the bottom-bar tab all read one
    // of these two fields. #57's premise was that one row fronted a "library";
    // #106's is that each row fronts exactly one noun and says which. A row
    // still reading "Library" would be a bar naming a surface that no longer
    // exists.
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));
    expect(byKey.transcripts.label).toBe('Transcripts');
    expect(byKey.transcripts.compactLabel).toBe('Transcripts');
    expect(byKey.notes.label).toBe('Notes');
    expect(byKey.notes.compactLabel).toBe('Notes');
    expect(DESTINATIONS.map((d) => d.label)).not.toContain('Library');
  });

  it('owns the whole /transcripts subtree, children included (#30)', () => {
    // One prefix covers the list, the New-transcript flow, the viewer and
    // #31's history page: a reader drilled into one transcript has not left
    // the destination, so the tab stays lit.
    expect(resolveActiveDestination('/transcripts')).toBe('transcripts');
    expect(resolveActiveDestination('/transcripts/new')).toBe('transcripts');
    expect(resolveActiveDestination('/transcripts/abc-123')).toBe('transcripts');
    expect(resolveActiveDestination('/transcripts/abc-123/history')).toBe('transcripts');
    // …and stops at the segment boundary, like every other prefix here.
    expect(resolveActiveDestination('/transcriptsfoo')).toBeNull();
    expect(resolveActiveDestination('/transcripts-archive')).toBeNull();
  });

  it('owns the whole /notes subtree on its OWN destination (#106)', () => {
    // The claim the split rests on, and the exact inverse of what #57's
    // version of this test asserted: `/notes` resolves to `notes`, never to
    // the transcripts row. If it still resolved to a shared key, the two rows
    // would light up together and the bar would be lying about where the user
    // is on every note route.
    expect(resolveActiveDestination('/notes')).toBe('notes');
    expect(resolveActiveDestination('/notes/new')).toBe('notes');
    expect(resolveActiveDestination('/notes/abc-123')).toBe('notes');
    expect(resolveActiveDestination('/notes/abc-123/history')).toBe('notes');
    // …and stops at the segment boundary, like every other prefix here.
    expect(resolveActiveDestination('/notesfoo')).toBeNull();
    expect(resolveActiveDestination('/notes-archive')).toBeNull();
  });

  it('keeps no trace of the merged library destination (#106)', () => {
    // The inverse of #57's "notes must not reappear as a fifth key". That
    // constraint is gone — `notes` IS a key now — and what replaces it is that
    // `library` must not come back as a third content row alongside the two
    // that replaced it.
    expect(DESTINATIONS.map((d) => d.key)).toContain('notes');
    expect(DESTINATIONS.map((d) => d.key)).toContain('transcripts');
    expect(DESTINATIONS.map((d) => d.key)).not.toContain('library');
    expect(Object.keys(DESTINATION_ROUTES)).not.toContain('library');
    expect(DESTINATIONS).toHaveLength(5);
  });

  it('marks Console pinned and leaves the four content rows ordinary (#105, #106)', () => {
    // The rail's foot section is driven entirely by this flag — see
    // `NavigationRail`'s `listDestinations`/`pinnedDestinations` split — and
    // since #106 so is the bottom bar's whole membership
    // (`BOTTOM_BAR_DESTINATIONS`). A console row that stops being flagged
    // `pinned` silently falls back to rendering inline as a fourth content
    // destination AND reappears as a fifth bottom-bar tab, which is the state
    // #106 exists to leave behind.
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));
    expect(byKey.console.pinned).toBe(true);
    expect(byKey.home.pinned).toBeFalsy();
    expect(byKey.transcripts.pinned).toBeFalsy();
    expect(byKey.notes.pinned).toBeFalsy();
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

  it('gives every destination a compactLabel short enough for the 72px rail', () => {
    // ELEVEN, not eight. The old bound was sized for `RAIL_WIDTH_COLLAPSED =
    // 56`, whose 48px caption box held about eight characters at the caption's
    // 0.625rem. #106 introduces "Transcripts" — 11 characters, ~54px in Inter
    // and ~57px in the widest sans fallback — and widens the rail to 72px,
    // which leaves a 64px box. So the bound moves with the rail rather than the
    // label being abbreviated into something that names a different thing.
    //
    // It is still a BOUND and not a formality: at the same measurements a
    // 13-character caption would overflow 64px, and this is what catches it
    // before anyone sees an ellipsis at 800px.
    for (const destination of DESTINATIONS) {
      expect(destination.compactLabel.length, `${destination.key} compactLabel`).toBeLessThanOrEqual(
        11,
      );
    }
  });

  it('caps the BOTTOM BAR at four destinations, not the table (#106)', () => {
    // The ceiling was always the bar's, and until #106 the two counts were the
    // same number so the distinction never had to be made. Console is `pinned`
    // — a mode — so the table may grow past four while the bar cannot.
    expect(BOTTOM_BAR_DESTINATIONS).toHaveLength(4);
    expect(BOTTOM_BAR_DESTINATIONS.length).toBeLessThanOrEqual(4);
  });

  it('excludes every pinned destination from the bottom bar (#106)', () => {
    // The derivation itself, asserted rather than assumed: a hand-written
    // second array would satisfy the length check above while silently
    // including Console.
    expect(BOTTOM_BAR_DESTINATIONS.some((d) => d.pinned)).toBe(false);
    expect(BOTTOM_BAR_DESTINATIONS.map((d) => d.key)).toEqual([
      'home',
      'transcripts',
      'notes',
      'settings',
    ]);
    // …and it is a SUBSET of the table, in the table's own order — the bar
    // never invents a destination or reorders one.
    expect(BOTTOM_BAR_DESTINATIONS.every((d) => DESTINATIONS.includes(d))).toBe(true);
    expect(DESTINATIONS.filter((d) => !d.pinned)).toEqual([...BOTTOM_BAR_DESTINATIONS]);
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

  it('gates /transcripts and /notes on exactly their own destination permissions (#106)', () => {
    // The same invariant as the Console one below, applied to the two
    // destinations #106 created — and it is now a PER-ROUTE comparison rather
    // than #57's union of two routes against one `anyPermission` array,
    // because each row fronts exactly one controller and one route.
    //
    // ⚠ WHAT THIS CATCHES, AND IT IS THE LIKELIEST WAY TO BREAK THE SPLIT:
    // `/notes` still gated on `transcripts:read`, or either row keeping the
    // merged `anyPermission` pair. Both produce a navigation row that promises
    // a surface its own route then refuses — the #92 bug, reintroduced by a
    // rename.
    const byKey = Object.fromEntries(DESTINATIONS.map((d) => [d.key, d]));

    for (const [path, destination] of [
      ['/transcripts', byKey.transcripts],
      ['/notes', byKey.notes],
    ] as const) {
      const gates = declaredRoutePermissions(path);
      // Guards the parser: an empty array would compare equal to an undefined
      // permission and prove nothing.
      expect(gates.length, `${path} has no parsed permission gate`).toBe(1);
      expect(destination.permission, `${destination.key} declares no permission`).toBeTruthy();
      expect(gates[0], `${path} route gate vs ${destination.key} destination`).toBe(
        destination.permission,
      );
      // …and neither carries the "or" the merged row needed.
      expect(destination.anyPermission).toBeUndefined();
    }
  });

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
