import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '@testing-library/react';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';
import App from '../App';

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
 * route-guard suite — so only Notifications, Maintenance and Users are
 * mocked below, alongside the hub itself.)
 */
vi.mock('../pages/Admin/SettingsHubPage', () => ({
  default: () => <h1>Admin Settings Hub</h1>,
}));

vi.mock('../pages/Admin/NotificationSettingsPage', () => ({
  default: () => <h1>Admin Notifications</h1>,
}));

vi.mock('../pages/Admin/MaintenancePage', () => ({
  default: () => <h1>Admin Maintenance</h1>,
}));

vi.mock('../pages/Admin/UsersPage', () => ({
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

vi.mock('../pages/UserProfilePage', () => ({
  default: () => <h1>User Profile Page</h1>,
}));

vi.mock('../pages/UserAppearancePage', () => ({
  default: () => <h1>User Appearance Page</h1>,
}));

vi.mock('../pages/UserTokensPage', () => ({
  default: () => <h1>User Tokens Page</h1>,
}));

// Issue #126, epic #109. Same rationale as the four stand-ins above: the real
// page's own suite (`UserNotificationsPage.test.tsx`) already proves it
// renders correctly, so this stand-in makes the assertions below about
// `App.tsx`'s route wiring specifically.
vi.mock('../pages/UserNotificationsPage', () => ({
  default: () => <h1>User Notifications Page</h1>,
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
        // Should either show login page or home page depending on mock auth state
        const welcomeText = screen.queryByText(/Welcome/i);
        const homeText = screen.queryByText(/Home Page/i);
        expect(welcomeText || homeText).toBeTruthy();
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

      await waitFor(() => expect(screen.getByText(/welcome back/i)).toBeInTheDocument(), {
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

      await waitFor(() => expect(screen.getByText(/welcome back/i)).toBeInTheDocument(), {
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
   * own suites (`UserSettingsPages.test.tsx`, `SettingsHub.test.tsx`) proved
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
    it.each([
      ['/settings', 'User Settings Hub'],
      ['/settings/profile', 'User Profile Page'],
      ['/settings/appearance', 'User Appearance Page'],
      ['/settings/notifications', 'User Notifications Page'],
      ['/settings/tokens', 'User Tokens Page'],
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

    it.each(['/admin/settings/notifications', '/admin/settings/maintenance'])(
      'redirects a user without system_settings:read away from %s',
      async (path) => {
        signInAs(['user_settings:read']);

        render(
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>,
        );

        await waitFor(() => expect(screen.getByText(/welcome back/i)).toBeInTheDocument(), {
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

      await waitFor(() => expect(screen.getByText(/welcome back/i)).toBeInTheDocument(), {
        timeout: 5000,
      });
      expect(screen.queryByRole('heading', { name: 'Admin Users' })).not.toBeInTheDocument();
    });
  });
});
