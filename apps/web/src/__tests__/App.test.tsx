import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '@testing-library/react';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import type { ReactElement } from 'react';
import { server } from './mocks/server';
import App from '../App';
// Issue #470: `main.tsx` configures the packaged notifications slice; a test that
// mounts the real tree does the same.
import '../platform/notifications';

/**
 * Every admin page is replaced with an UNGUARDED stand-in.
 *
 * The real pages already self-guard on the same permission and redirect to
 * `/`, so with them in place a route-guard test passes whether or not the route
 * guard exists — the page's own check produces an identical redirect. Mocking
 * them away is what makes these assertions actually about `App.tsx`'s wiring:
 * anything that renders here reached the page, and any redirect came from the
 * route.
 *
 * The page-level checks stay in the app as defence for a page mounted from
 * anywhere else; they are covered by those pages' own suites.
 *
 * The stand-ins carry DISTINCT headings (#92). With several routes under
 * `/admin/settings/*`, a shared heading would let a mis-wired route pass by
 * rendering a sibling — which is precisely the failure a route split invites.
 * (Email and Web Push are not stood in here — neither is exercised by this
 * route-guard suite — so only Notifications, Maintenance, About and Users are
 * mocked below, alongside the hub itself.)
 */
vi.mock('../pages/Admin/SettingsHubPage', () => ({
  default: () => <h1>Admin Settings Hub</h1>,
}));


vi.mock('../pages/Admin/MaintenancePage', () => ({
  default: () => <h1>Admin Maintenance</h1>,
}));

// Issue #126, epic #118. Same rationale as the stand-ins above, plus one
// specific to this page: the real one opens `GET /api/admin/about` on mount,
// which this route-guard suite is not about. Its own suite covers that; this
// file only proves `App.tsx` wires `/admin/settings/about` to it under
// `system_settings:read`.
vi.mock('../pages/Admin/AboutPage', () => ({
  default: () => <h1>Admin About</h1>,
}));
// Issue #464: the packaged Doctor page behind its own route and gate.
vi.mock('../pages/Admin/DoctorPage', () => ({
  default: () => <h1>Admin Doctor</h1>,
}));

// Issue #465: the route renders KVox's binding of the packaged Users page.
vi.mock('../identity/UsersPage', () => ({
  default: () => <h1>Admin Users</h1>,
}));

/**
 * The four `/settings/*` routes from issue #96, epic #90. Same rationale as
 * the admin stand-ins above: the real pages already render correctly (their
 * own suites cover that), so replacing them with distinctly-headed stand-ins
 * makes these assertions about `App.tsx`'s route wiring specifically —
 * nothing here passes because a page's own internal check happened to
 * produce the same outcome.
 */
vi.mock('../pages/UserSettingsHubPage', () => ({
  default: () => <h1>User Settings Hub</h1>,
}));

// Issue #466: Profile and Appearance are the packaged pages. Only the two pages
// are replaced; the barrel's hub, registry helpers and hooks stay real.
vi.mock('@marinoscar/platform-web/settings/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/settings/ui')>()),
  UserProfilePage: () => <h1>User Profile Page</h1>,
  UserAppearancePage: () => <h1>User Appearance Page</h1>,
}));

// Issue #465: the Access Tokens page is the packaged one. The registries in
// `config/` import their cards from the same module, so only the page is
// replaced and the rest of the barrel stays real.
vi.mock('@marinoscar/platform-web/identity/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/identity/ui')>()),
  UserTokensPage: () => <h1>User Tokens Page</h1>,
}));

// Issue #80; the platform's page since #480. Same rationale as the stand-ins above, plus one
// specific to this page: the real one opens a `GET /api/user-data/summary` and, while a
// deletion is running, a repeating poll - neither of which this route-guard suite is about.
// The platform's own suite covers that behaviour; this file only proves `App.tsx` wires
// `/settings/danger-zone` to it and carries no `RequirePermission`. Only the page is replaced:
// the barrel's `dangerZoneSettingsPage` (read by `config/userSettingsSections.tsx`) stays real.
vi.mock('@marinoscar/platform-web/user-data/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/user-data/ui')>()),
  UserDangerZonePage: () => <h1>User Danger Zone Page</h1>,
}));

// Issue #532: "Download your data" is the platform's page. Same rationale as the stand-ins above (the
// real one opens `GET /api/exports/sources` and `/api/exports`, and polls while an export runs); only the
// page is replaced, the barrel's `dataExportSettingsPage` (read by `config/userSettingsSections.tsx`) stays real.
vi.mock('@marinoscar/platform-web/exports/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/exports/ui')>()),
  DataExportPage: () => <h1>Data Export Page</h1>,
}));

// Issue #126, epic #109. Same rationale as the four stand-ins above: the real
// page's own suite (`UserNotificationsPage.test.tsx`) already proves it
// renders correctly, so this stand-in makes the assertions below about
// `App.tsx`'s route wiring specifically.
// Since #470 the page is the packaged one, so only it is replaced; the barrel's
// provider, bell, banner and hooks stay real.
vi.mock('@marinoscar/platform-web/notifications/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/notifications/ui')>()),
  UserNotificationsPage: () => <h1>User Notifications Page</h1>,
  NotificationSettingsPage: () => <h1>Admin Notifications</h1>,
}));

// Issue #369, now the graph slice's route data (#503, epic #498). The one GATED
// `/settings/*` route; the slice's own suite (`UserKnowledgeGraphPage.test.tsx`)
// covers the page itself. The page is replaced inside the slice's route list,
// keeping the route's path, permission and `redirectTo`, so the guard below is
// the real one.
vi.mock('@marinoscar/kvox-web/graph/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@marinoscar/kvox-web/graph/ui')>();
  return {
    ...actual,
    kvoxGraphRoutes: actual.kvoxGraphRoutes.map((route) =>
      route.path === '/settings/knowledge-graph'
        ? { ...route, Component: () => <h1>User Knowledge Graph Page</h1> }
        : route,
    ),
  };
});

/**
 * The four transcript routes from issue #30, epic #19, and the four note
 * routes from #57, epic #45. Same rationale as every stand-in above, with one
 * extra reason specific to these: the real pages open an SSE-fed poll, a file
 * picker and an `HTMLAudioElement` respectively, none of which this route-guard
 * suite is about and all of which jsdom would have to be taught about for no
 * gain. Distinct headings, so a mis-wired route cannot pass by rendering a
 * sibling.
 *
 * ⚠ TWO STAND-INS SINCE #106, WHERE ONE SERVED BOTH ROUTES. `/transcripts` and
 * `/notes` used to render the same `LibraryPage` — the tab was the URL (#57) —
 * so the suites below could only distinguish them by the PATH the router kept.
 * They are two pages now, so each gets its own heading and a route wired to the
 * wrong page fails on the heading rather than being invisible.
 */
// Issue #500, epic #498. The transcripts routes are the slice's data
// (`kvoxTranscriptsRoutes`), and two of its pages are rendered through this
// app's slot wrappers. The wrappers are replaced by name; the other two pages
// are replaced inside the slice's route list, keeping each route's path,
// permission and `redirectTo`, so the guards below are the real ones.
vi.mock('../kvox/TranscriptsPageWithSlots', () => ({
  TranscriptsPageWithSlots: () => <h1>Transcripts Page</h1>,
}));

// Issue #502, epic #498. The notes routes are the slice's data
// (`kvoxNotesRoutes`); three of its pages are rendered through this app's slot
// and AI wrappers, replaced by name, and the fourth (`/notes/:id/history`) is
// replaced inside the slice's route list, keeping each route's path, permission
// and `redirectTo`, so the guards below are the real ones.
vi.mock('../kvox/NotesLibraryWithSlots', () => ({
  NotesLibraryWithSlots: () => <h1>Notes Page</h1>,
}));

vi.mock('../kvox/NewNotePageWithAi', () => ({
  NewNotePageWithAi: () => <h1>New Note Page</h1>,
}));

vi.mock('../kvox/NotePageWithSlots', () => ({
  NotePageWithSlots: () => <h1>Note Page</h1>,
}));

vi.mock('@marinoscar/kvox-web/notes/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@marinoscar/kvox-web/notes/ui')>();
  return {
    ...actual,
    kvoxNotesRoutes: actual.kvoxNotesRoutes.map((route) =>
      route.path === '/notes/:id/history'
        ? { ...route, Component: () => <h1>Note History Page</h1> }
        : route,
    ),
  };
});

vi.mock('../kvox/TranscriptPageWithSlots', () => ({
  TranscriptPageWithSlots: () => <h1>Transcript Viewer Page</h1>,
}));

vi.mock('@marinoscar/kvox-web/transcripts/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@marinoscar/kvox-web/transcripts/ui')>();
  const standIns: Record<string, () => ReactElement> = {
    '/transcripts/new': () => <h1>New Transcript Page</h1>,
    '/transcripts/:id/history': () => <h1>Transcript History Page</h1>,
  };
  return {
    ...actual,
    kvoxTranscriptsRoutes: actual.kvoxTranscriptsRoutes.map((route) => {
      const standIn = standIns[route.path];
      return standIn ? { ...route, Component: standIn } : route;
    }),
  };
});

// Issue #477, epic #472. The AI pages are the platform's
// (`@marinoscar/platform-web/ai/ui`) and the admin AI page is this app's binding
// over one of them. Same rationale as every stand-in above: the pages' own
// suites cover what they render, so distinct stand-ins make the assertions
// below about `App.tsx`'s wiring (path, permission, feature gate). Only the
// pages are replaced; `RequireAiEnabled` is a separate entry and stays REAL, so
// the feature half of each gate is exercised over the shell's `GET /api/ai/config`.
vi.mock('../pages/Admin/AiSettingsPage', () => ({
  default: () => <h1>Admin AI</h1>,
}));
vi.mock('@marinoscar/platform-web/ai/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/ai/ui')>()),
  UserAiKeysPage: () => <h1>User AI Keys Page</h1>,
  AiModelsPage: () => <h1>Admin AI Models</h1>,
  AiUsagePage: () => <h1>Admin AI Usage</h1>,
}));

const API_BASE = '*/api';

/** Overrides `GET /auth/me` for one test, so the route tree sees this user. */
function signInAs(permissions: string[], roles: string[] = ['viewer']) {
  server.use(
    http.get(`${API_BASE}/auth/me`, () =>
      HttpResponse.json({
        data: {
          id: 'test-user-id',
          email: 'test@example.com',
          displayName: 'Test User',
          profileImageUrl: null,
          roles: roles.map((name) => ({ name })),
          permissions,
          isActive: true,
          createdAt: new Date().toISOString(),
        },
      }),
    ),
  );
}

/**
 * "The router landed on `/`" — the marker these redirect tests actually mean.
 *
 * It used to be `getByText(/welcome back/i)`, the template home page's banner.
 * Issue #32 rebuilt that page around transcripts and the banner is gone; the
 * stable landmark is now the greeting, which is the page's `h1` and the only
 * one on the document. Matched on the PREFIX rather than the whole string so
 * these tests assert "we are on Home", not "the greeting currently reads this",
 * which is not what any of them is about.
 *
 * The page is now asynchronous (a skeleton, then content, driven by
 * `GET /api/transcripts/summary` — answered by the default MSW handler), so
 * every call site wraps this in the `waitFor` it already had.
 */
function expectOnHomePage() {
  expect(screen.getByRole('heading', { level: 1, name: /^Hi,/ })).toBeInTheDocument();
}

describe('App', () => {
  it('renders without crashing and shows login page initially', async () => {
    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>,
    );

    // Wait for lazy loaded component to render
    // The App will make an API call to check auth, MSW will handle it
    await waitFor(
      () => {
        // Either page is acceptable here — this test only asserts the app
        // mounts and routes at all, not which way the auth probe went. Both
        // arms are the destination's `h1`: the login card's "Welcome", or the
        // signed-in home page's greeting (issue #32 replaced that page's
        // "Welcome back" banner, so matching on "Welcome" alone would now
        // answer only for the logged-OUT arm and silently stop covering the
        // other one).
        const loginHeading = screen.queryByRole('heading', { level: 1, name: /Welcome/i });
        const homeHeading = screen.queryByRole('heading', { level: 1, name: /^Hi,/ });
        expect(loginHeading || homeHeading).toBeTruthy();
      },
      { timeout: 5000 },
    );
  });

  describe('Route-level authorization', () => {
    /**
     * Issue #55. `ProtectedRoute` establishes only that SOMEONE is logged in.
     * Authorization now happens at the route too, through `RequirePermission`
     * — which until this change was dead code with zero usages anywhere in the
     * app despite existing, tested, in `components/common/`.
     *
     * These render the REAL route tree from `App.tsx` (with the pages stubbed
     * out, see the mocks above) because the thing under test is the wiring in
     * that file and nothing else.
     */
    it('redirects a user without system_settings:read away from /admin/settings', async () => {
      // Holds neither half of the console gate's OR (no system_settings:read,
      // no users:read either) — the case a widened-but-still-single-permission
      // gate would still get right, which is why it alone can't distinguish a
      // correct fix from an incomplete one. See the users:read-only test below
      // for the half that actually would have failed pre-fix.
      signInAs(['user_settings:read']);

      render(
        <MemoryRouter initialEntries={['/admin/settings']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(() => expectOnHomePage(), {
        timeout: 5000,
      });
      expect(screen.queryByRole('heading', { name: /system settings/i })).not.toBeInTheDocument();
    });

    it('redirects a user without users:read away from /admin/settings/users', async () => {
      signInAs(['user_settings:read']);

      render(
        <MemoryRouter initialEntries={['/admin/settings/users']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(() => expectOnHomePage(), {
        timeout: 5000,
      });
      expect(screen.queryByRole('heading', { name: 'Admin Users' })).not.toBeInTheDocument();
    });

    it('lets a user holding system_settings:read reach /admin/settings', async () => {
      signInAs(['user_settings:read', 'system_settings:read'], ['admin']);

      render(
        <MemoryRouter initialEntries={['/admin/settings']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { name: /admin settings hub/i }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('gates on the permission, not the admin role', async () => {
      // A Contributor granted `system_settings:read` gets in. That user is
      // precisely the one the old three-idiom gating stranded: a menu entry and
      // a quick action pointing at a page whose only route in was the URL bar.
      signInAs(['user_settings:read', 'system_settings:read'], ['contributor']);

      render(
        <MemoryRouter initialEntries={['/admin/settings']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { name: /admin settings hub/i }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('admits a user holding ONLY users:read to /admin/settings', async () => {
      // Issue #92 regression. The `console` destination is reachable on
      // `anyPermission: ['system_settings:read', 'users:read']` — an OR — but
      // the route itself used to keep only `system_settings:read`, so a
      // users:read-only admin saw the Console row everywhere, clicked it, and
      // was bounced straight back to `/`. This is the half of the OR the two
      // tests above never exercised: neither holds users:read without also
      // holding system_settings:read.
      signInAs(['user_settings:read', 'users:read'], ['contributor']);

      render(
        <MemoryRouter initialEntries={['/admin/settings']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { name: /admin settings hub/i }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('admits an admin holding users:read to /admin/settings/users', async () => {
      signInAs(['user_settings:read', 'users:read', 'allowlist:read'], ['admin']);

      render(
        <MemoryRouter initialEntries={['/admin/settings/users']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () => expect(screen.getByRole('heading', { name: 'Admin Users' })).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });
  });

  /**
   * Issue #96, epic #90. The per-user settings hub plus one route per card in
   * `config/userSettingsSections.tsx`. This file (and only this file) had no
   * assertions at all for `/settings/*` before this change — the split pages'
   * own suites (`SettingsHubPages.test.tsx`, and the package's own) proved
   * each page renders correctly in isolation, but nothing proved `App.tsx`
   * wires each PATH to the right one, and nothing proved these routes are
   * reachable without the `RequirePermission` gate the `/admin/settings/*`
   * block above carries.
   *
   * `/settings/notifications` (issue #126, epic #109) joined this set later:
   * `config/userSettingsSections.tsx` declares no `permission` on its card for
   * the same reason every other card here doesn't (see that file's own
   * header), and `UserNotificationsPage.test.tsx` covers the page's own
   * behaviour — this file only proves `App.tsx` wires the path to it and
   * carries no gate.
   */
  describe('User settings routes', () => {
    describe('/settings/knowledge-graph (issue #369, gated on graph:write)', () => {
      it('renders the page for a holder of graph:write', async () => {
        signInAs(['user_settings:read', 'user_settings:write', 'graph:read', 'graph:write']);

        render(
          <MemoryRouter initialEntries={['/settings/knowledge-graph']}>
            <App />
          </MemoryRouter>,
        );

        await waitFor(
          () =>
            expect(
              screen.getByRole('heading', { name: 'User Knowledge Graph Page' }),
            ).toBeInTheDocument(),
          { timeout: 5000 },
        );
      });

      it('redirects a user without graph:write to the settings hub', async () => {
        signInAs(['user_settings:read', 'user_settings:write', 'graph:read']);

        render(
          <MemoryRouter initialEntries={['/settings/knowledge-graph']}>
            <App />
          </MemoryRouter>,
        );

        await waitFor(
          () =>
            expect(screen.getByRole('heading', { name: 'User Settings Hub' })).toBeInTheDocument(),
          { timeout: 5000 },
        );
        expect(
          screen.queryByRole('heading', { name: 'User Knowledge Graph Page' }),
        ).not.toBeInTheDocument();
      });
    });

    it.each([
      ['/settings', 'User Settings Hub'],
      ['/settings/profile', 'User Profile Page'],
      ['/settings/appearance', 'User Appearance Page'],
      ['/settings/notifications', 'User Notifications Page'],
      ['/settings/tokens', 'User Tokens Page'],
      ['/settings/danger-zone', 'User Danger Zone Page'],
      ['/settings/data-export', 'Data Export Page'],
    ])('renders %s as %s for a user holding only user_settings:read', async (path, heading) => {
      signInAs(['user_settings:read']);

      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(() => expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument(), {
        timeout: 5000,
      });

      // Isolation: reaching one of these routes must render exactly that
      // page's stand-in, never a sibling's.
      const allHeadings = [
        'User Settings Hub',
        'User Profile Page',
        'User Appearance Page',
        'User Notifications Page',
        'User Tokens Page',
        'User Danger Zone Page',
        'Data Export Page',
      ];
      for (const other of allHeadings.filter((h) => h !== heading)) {
        expect(screen.queryByRole('heading', { name: other })).not.toBeInTheDocument();
      }
    });

    it('reaches /settings/profile with an empty permission set — contrast with /admin/settings, which redirects', async () => {
      // The strongest version of "not gated": no permissions at all, not even
      // `user_settings:read`. `/admin/settings` above redirects a user
      // lacking BOTH `system_settings:read` and `users:read`; these routes
      // have no such check to fail, because `ProtectedRoute` (authentication)
      // is the only thing standing between a signed-in user and their own
      // settings.
      signInAs([]);

      render(
        <MemoryRouter initialEntries={['/settings/profile']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { name: 'User Profile Page' }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('reaches /settings/notifications with an empty permission set - it renders every user\'s own preferences, not an admin-only surface', async () => {
      signInAs([]);

      render(
        <MemoryRouter initialEntries={['/settings/notifications']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { name: 'User Notifications Page' }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });
  });

  /**
   * Issue #30, epic #19. Four routes, two permissions, and one asymmetry worth
   * asserting explicitly: `/transcripts/new` is the ONLY one gated on
   * `transcripts:write`, and its fallback is `/transcripts` rather than `/` —
   * a user who may read but not create should land on the library they CAN
   * reach, not on the home page.
   */
  describe('Transcript routes', () => {
    const READER = ['transcripts:read'];

    it.each([
      ['/transcripts', 'Transcripts Page'],
      ['/transcripts/abc-123', 'Transcript Viewer Page'],
      ['/transcripts/abc-123/history', 'Transcript History Page'],
    ])('renders %s as %s for a user holding transcripts:read', async (path, heading) => {
      signInAs(READER);

      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () => expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument(),
        { timeout: 5000 },
      );

      // Isolation: `/transcripts/new` and `/transcripts/:id` both match a
      // two-segment path, and React Router ranks the literal higher — a
      // regression there would render the viewer for `/transcripts/new`.
      const allHeadings = [
        'Transcripts Page',
        'New Transcript Page',
        'Transcript Viewer Page',
        'Transcript History Page',
      ];
      for (const other of allHeadings.filter((h) => h !== heading)) {
        expect(screen.queryByRole('heading', { name: other })).not.toBeInTheDocument();
      }
    });

    it('renders /transcripts/new for a user holding transcripts:write', async () => {
      signInAs(['transcripts:read', 'transcripts:write']);

      render(
        <MemoryRouter initialEntries={['/transcripts/new']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { name: 'New Transcript Page' }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('sends a read-only user from /transcripts/new to the list, not to home', async () => {
      signInAs(READER);

      render(
        <MemoryRouter initialEntries={['/transcripts/new']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { name: 'Transcripts Page' }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
      expect(
        screen.queryByRole('heading', { name: 'New Transcript Page' }),
      ).not.toBeInTheDocument();
    });

    it.each(['/transcripts', '/transcripts/abc-123', '/transcripts/abc-123/history'])(
      'redirects a user without transcripts:read away from %s',
      async (path) => {
        signInAs(['user_settings:read']);

        render(
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>,
        );

        await waitFor(() => expectOnHomePage(), {
          timeout: 5000,
        });
      },
    );

    it('sends a notes-only user from /transcripts HOME, not sideways (#106)', async () => {
      // ⚠ THE INVERSE OF WHAT #57 ASSERTED HERE, and the change is the point.
      // Then, the ONE `library` row was reachable on either permission with
      // `/transcripts` as its path, so a notes-only user clicked a row they
      // were legitimately shown and landed on a route they could not read —
      // bouncing them to `/` would have been the #92 bug, a nav row promising a
      // surface the router refuses, so the fallback pointed one tab sideways.
      //
      // #106 gives each subtree its own destination gated on its own single
      // permission, so this user is never shown a Transcripts row at all. They
      // can only arrive here by an old bookmark or a typed URL, and for that
      // `/` is the honest answer — `/notes` would be a guess about what they
      // meant.
      signInAs(['notes:read']);

      render(
        <MemoryRouter initialEntries={['/transcripts']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(() => expectOnHomePage(), { timeout: 5000 });
      expect(screen.queryByRole('heading', { name: 'Notes Page' })).not.toBeInTheDocument();
    });
  });

  /**
   * Issue #57, epic #45. Four routes, two permissions, and the same asymmetry
   * the transcript block above asserts: `/notes/new` is the only one gated on
   * `notes:write`, and its fallback is `/notes` rather than `/`.
   */
  describe('Note routes', () => {
    const READER = ['notes:read'];

    it.each([
      ['/notes', 'Notes Page'],
      ['/notes/abc-123', 'Note Page'],
      ['/notes/abc-123/history', 'Note History Page'],
    ])('renders %s as %s for a user holding notes:read', async (path, heading) => {
      signInAs(READER);

      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () => expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument(),
        { timeout: 5000 },
      );

      // Isolation: `/notes/new` and `/notes/:id` both match a two-segment
      // path, and React Router ranks the literal higher — a regression there
      // would render the note viewer for `/notes/new`.
      const allHeadings = ['Notes Page', 'New Note Page', 'Note Page', 'Note History Page'];
      for (const other of allHeadings.filter((h) => h !== heading)) {
        expect(screen.queryByRole('heading', { name: other })).not.toBeInTheDocument();
      }
    });

    it('renders /notes/new for a user holding notes:write', async () => {
      signInAs(['notes:read', 'notes:write']);

      render(
        <MemoryRouter initialEntries={['/notes/new']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () => expect(screen.getByRole('heading', { name: 'New Note Page' })).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('sends a read-only user from /notes/new to the list, not to home', async () => {
      signInAs(READER);

      render(
        <MemoryRouter initialEntries={['/notes/new']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () => expect(screen.getByRole('heading', { name: 'Notes Page' })).toBeInTheDocument(),
        { timeout: 5000 },
      );
      expect(screen.queryByRole('heading', { name: 'New Note Page' })).not.toBeInTheDocument();
    });

    it.each(['/notes', '/notes/abc-123', '/notes/abc-123/history'])(
      'redirects a user without notes:read away from %s',
      async (path) => {
        signInAs(['user_settings:read']);

        render(
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>,
        );

        await waitFor(() => expectOnHomePage(), { timeout: 5000 });
      },
    );
  });

  /**
   * Issue #92, epic #90. The admin tab strips became one route per settings
   * page. These assert the two things a split can silently get wrong: a route
   * that renders the WRONG page (hence the distinct stand-in headings above),
   * and a route that carries the wrong permission.
   */
  describe('Console settings routes', () => {
    const READER = ['user_settings:read', 'system_settings:read'];

    it.each([
      ['/admin/settings/notifications', 'Admin Notifications'],
      ['/admin/settings/maintenance', 'Admin Maintenance'],
      ['/admin/settings/about', 'Admin About'],
      ['/admin/settings/doctor', 'Admin Doctor'],
    ])('renders %s for a user holding system_settings:read', async (path, heading) => {
      signInAs(READER, ['contributor']);

      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(() => expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument(), {
        timeout: 5000,
      });
    });

    it.each([
      '/admin/settings/notifications',
      '/admin/settings/maintenance',
      '/admin/settings/about',
      '/admin/settings/doctor',
    ])(
      'redirects a user without system_settings:read away from %s',
      async (path) => {
        signInAs(['user_settings:read']);

        render(
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>,
        );

        await waitFor(() => expectOnHomePage(), {
          timeout: 5000,
        });
      },
    );
  });

  /**
   * The redirects are REAL routes, not catch-all fallout. Before #92 a
   * bookmarked `/admin/users` matched only `*` and landed silently on `/`, so
   * "did the user reach the right page" and "did the user reach home" were the
   * same observation. Asserting the destination page is what separates them.
   */
  describe('Legacy admin URL redirects', () => {
    it('sends /admin/users to the Users & Allowlist page', async () => {
      signInAs(['user_settings:read', 'users:read', 'allowlist:read'], ['admin']);

      render(
        <MemoryRouter initialEntries={['/admin/users']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () => expect(screen.getByRole('heading', { name: 'Admin Users' })).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('sends the bare /admin to the settings hub', async () => {
      signInAs(['user_settings:read', 'system_settings:read'], ['admin']);

      render(
        <MemoryRouter initialEntries={['/admin']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(
        () =>
          expect(
            screen.getByRole('heading', { name: 'Admin Settings Hub' }),
          ).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('still refuses a redirected route the user may not reach', async () => {
      // The redirect itself is ungated — it is the TARGET route that gates, and
      // this is what proves the redirect did not become a way around it.
      signInAs(['user_settings:read']);

      render(
        <MemoryRouter initialEntries={['/admin/users']}>
          <App />
        </MemoryRouter>,
      );

      await waitFor(() => expectOnHomePage(), {
        timeout: 5000,
      });
      expect(screen.queryByRole('heading', { name: 'Admin Users' })).not.toBeInTheDocument();
    });
  });
  /**
   * Issue #477, epic #472. The four AI routes, each gated on the permission the
   * platform's AI controllers enforce AND on the AI feature, except the admin
   * `AI` route, which is where AI is switched on and must stay reachable while
   * it is off (AI rule 5). The feature half is the shell's one
   * `GET /api/ai/config` answer, served per test.
   */
  describe('AI routes (#477)', () => {
    function serveAi(enabled: boolean) {
      server.use(
        http.get(`${API_BASE}/ai/config`, () =>
          HttpResponse.json({ data: { enabled, keyPolicy: 'byok', providers: [] } }),
        ),
      );
    }

    function renderAt(path: string) {
      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );
    }

    it('shows /settings/ai to a holder of ai:use while AI is on', async () => {
      signInAs(['ai:use']);
      serveAi(true);
      renderAt('/settings/ai');

      await waitFor(
        () => expect(screen.getByRole('heading', { name: 'User AI Keys Page' })).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('redirects /settings/ai away for a user without ai:use', async () => {
      signInAs(['user_settings:read']);
      serveAi(true);
      renderAt('/settings/ai');

      await waitFor(() => expectOnHomePage(), { timeout: 5000 });
      expect(screen.queryByRole('heading', { name: 'User AI Keys Page' })).not.toBeInTheDocument();
    });

    it('redirects /settings/ai away while AI is off, even for a holder of ai:use', async () => {
      signInAs(['ai:use']);
      serveAi(false);
      renderAt('/settings/ai');

      await waitFor(() => expectOnHomePage(), { timeout: 5000 });
      expect(screen.queryByRole('heading', { name: 'User AI Keys Page' })).not.toBeInTheDocument();
    });

    it('keeps /admin/settings/ai reachable while AI is off — it is the switch', async () => {
      signInAs(['ai_config:read'], ['admin']);
      serveAi(false);
      renderAt('/admin/settings/ai');

      await waitFor(
        () => expect(screen.getByRole('heading', { name: 'Admin AI' })).toBeInTheDocument(),
        { timeout: 5000 },
      );
    });

    it('redirects /admin/settings/ai away for system_settings:read without ai_config:read', async () => {
      signInAs(['system_settings:read'], ['admin']);
      serveAi(true);
      renderAt('/admin/settings/ai');

      await waitFor(() => expectOnHomePage(), { timeout: 5000 });
      expect(screen.queryByRole('heading', { name: 'Admin AI' })).not.toBeInTheDocument();
    });

    it.each([
      ['/admin/settings/ai/models', 'Admin AI Models'],
      ['/admin/settings/ai/usage', 'Admin AI Usage'],
    ])('shows %s to an ai_config:read holder while AI is on', async (path, heading) => {
      signInAs(['ai_config:read'], ['admin']);
      serveAi(true);
      renderAt(path);

      await waitFor(() => expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument(), {
        timeout: 5000,
      });
      // Isolation: never the `AI` page's stand-in.
      expect(screen.queryByRole('heading', { name: 'Admin AI' })).not.toBeInTheDocument();
    });

    it.each(['/admin/settings/ai/models', '/admin/settings/ai/usage'])(
      'redirects %s away while AI is off',
      async (path) => {
        signInAs(['ai_config:read'], ['admin']);
        serveAi(false);
        renderAt(path);

        await waitFor(() => expectOnHomePage(), { timeout: 5000 });
      },
    );

    it.each(['/admin/settings/ai/models', '/admin/settings/ai/usage'])(
      'redirects %s away for a user without ai_config:read',
      async (path) => {
        signInAs(['user_settings:read']);
        serveAi(true);
        renderAt(path);

        await waitFor(() => expectOnHomePage(), { timeout: 5000 });
      },
    );
  });
});
