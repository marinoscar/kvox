import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useLocation } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../utils/test-utils';
import { setViewportWidth } from '../setup';

/**
 * The two settings hub BINDINGS (issues #93 and #96, epic #90; #466, epic #462).
 *
 * The hub component is the platform's now (`@marinoscar/platform-web/settings/ui`,
 * with its own suite: search, both width treatments, the empty state, disabled
 * cards, permission gating). What is KVox's, and what this suite pins, is the
 * WIRING: the real registries, the real title and subtitle constants, the
 * scroll keys, the permission seam, and the version line (#296) that the
 * packaged hub has no slot for.
 */

vi.mock('@marinoscar/platform-web/identity/headless', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/identity/headless')>()),
  usePermissions: vi.fn(),
}));

import { usePermissions } from '@marinoscar/platform-web/identity/headless';
import SettingsHubPage from '../../pages/Admin/SettingsHubPage';
import UserSettingsHubPage from '../../pages/UserSettingsHubPage';

const mockUsePermissions = vi.mocked(usePermissions);

function setPermissions(granted: string[]) {
  mockUsePermissions.mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(),
    hasPermission: (perm: string) => granted.includes(perm),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: false,
  });
}

/**
 * The packaged hub navigates through the real router (a `vi.mock` of
 * `react-router-dom` never reaches a dependency Vite externalises), so a click
 * is asserted on the location the router ends up at.
 */
function Location() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function expectNavigatedTo(path: string) {
  expect(screen.getByTestId('location')).toHaveTextContent(path);
}

const PHONE = 375;
const DESKTOP = 1400;

/**
 * The real admin binding, per issue #93's own reference in the additional
 * context: title/subtitle/search render, filtering and clearing, the empty
 * state, below/above-`sm` treatments, permission gating, and click-to-navigate
 * are already proven generically above. What's admin-specific and worth its
 * own coverage is the WIRING — the real registry, the real constants, and the
 * real scroll key — plus the concrete regression #92 called out: a
 * `users:read`-only admin must land on a hub with exactly one usable card, not
 * on an access-denied page.
 */
describe('SettingsHubPage — the real admin registry', () => {
  const ADMIN_READER = ['system_settings:read', 'system_settings:write', 'users:read'];

  it('renders the admin hub title and every card an admin reader can see', () => {
    setViewportWidth(DESKTOP);
    setPermissions(ADMIN_READER);
    render(<SettingsHubPage />);

    expect(screen.getByRole('heading', { level: 4, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Email' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Maintenance' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 6, name: 'Users & Allowlist' }),
    ).toBeInTheDocument();
  });

  it("navigates to a real card's route on click", async () => {
    setViewportWidth(DESKTOP);
    setPermissions(ADMIN_READER);
    const user = userEvent.setup();
    render(
      <>
        <SettingsHubPage />
        <Location />
      </>,
    );

    await user.click(screen.getByRole('heading', { level: 6, name: 'Email' }));

    expectNavigatedTo('/admin/settings/email');
  });

  it('shows exactly the one card a users:read-only admin can use (issue #92 regression)', () => {
    setViewportWidth(DESKTOP);
    setPermissions(['users:read']);
    render(<SettingsHubPage />);

    expect(screen.getByRole('heading', { level: 6, name: 'Users & Allowlist' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 6, name: 'Email' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 6, name: 'Maintenance' }),
    ).not.toBeInTheDocument();
  });

  describe('Scroll restoration wiring', () => {
    it('writes a scroll offset under the admin-settings-hub key', async () => {
      // The hook's own retry/coalescing/deadline behaviour is covered in
      // `__tests__/hooks/useScrollRestoration.test.ts`. This only proves
      // `SettingsHubPage` passes its documented `hubKey` through to it.
      setViewportWidth(DESKTOP);
      setPermissions(ADMIN_READER);
      render(<SettingsHubPage />);

      Object.defineProperty(window, 'scrollY', { value: 42, configurable: true });
      window.dispatchEvent(new Event('scroll'));

      await waitFor(() => {
        expect(window.sessionStorage.getItem('eab:scroll:admin-settings-hub')).toBe('42');
      });
    });
  });
});

/**
 * The real user binding (issue #96), the twin of the admin pass above and for
 * the same reason: generic `SettingsHub` behaviour (search, both width
 * treatments, click-to-navigate, the empty state) is already proven against
 * the fixture registry, so this section only has to prove the WIRING —
 * `USER_SETTINGS_SECTIONS`, `USER_HUB_TITLE`, and the `user-settings-hub`
 * scroll key — plus the one thing that makes this hub different from the
 * admin one: no card here declares a `permission`, so a user holding nothing
 * but `user_settings:read` must still see every card. A `RequirePermission`
 * (or an accidental `permission` string) added to any of these cards would
 * fail that test without touching anything checked above.
 */
describe('UserSettingsHubPage — the real user registry', () => {
  // Deliberately NOT `users:read` or `system_settings:read` — those are what
  // the admin hub gates on, and this suite exists to prove the user hub does
  // not borrow that gate.
  const SETTINGS_OWNER = ['user_settings:read'];

  it('renders the hub title, both groups, and all four cards for a user_settings:read-only user', () => {
    setViewportWidth(DESKTOP);
    setPermissions(SETTINGS_OWNER);
    render(<UserSettingsHubPage />);

    expect(screen.getByRole('heading', { level: 4, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Appearance' })).toBeInTheDocument();
    // Issue #126, epic #109. Same Account group as Profile/Appearance.
    expect(screen.getByRole('heading', { level: 6, name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Access Tokens' })).toBeInTheDocument();
  });

  it('holds no card behind a permission: an empty permission set still sees all four cards', () => {
    // The strongest version of "no permission is required" — not merely
    // "the permission this user happens to hold is enough", but "there is no
    // gate to satisfy at all".
    setViewportWidth(DESKTOP);
    setPermissions([]);
    render(<UserSettingsHubPage />);

    expect(screen.getByRole('heading', { level: 6, name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Access Tokens' })).toBeInTheDocument();
  });

  // Issue #126, epic #109. The registry-driven promise this hub makes: a card
  // declared in `USER_SETTINGS_SECTIONS` with no `permission` appears in BOTH
  // width treatments with no further wiring, and clicking it navigates to its
  // declared path — exactly the "appears in the hub's grid and drill-down"
  // behaviour the issue calls out.
  it('shows the Notifications card in the desktop grid, in the phone drill-down list, and navigates to its route', async () => {
    setViewportWidth(DESKTOP);
    setPermissions(SETTINGS_OWNER);
    const user = userEvent.setup();
    const { unmount } = render(
      <>
        <UserSettingsHubPage />
        <Location />
      </>,
    );

    expect(screen.getByRole('heading', { level: 6, name: 'Notifications' })).toBeInTheDocument();
    expect(
      screen.getByText(/choose which events notify you, and whether they arrive by email or in your browser/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('heading', { level: 6, name: 'Notifications' }));
    expectNavigatedTo('/settings/notifications');

    unmount();

    setViewportWidth(PHONE);
    render(
      <>
        <UserSettingsHubPage />
        <Location />
      </>,
    );

    // Drill-down rows are plain text, not `h6` headings (see the phone test
    // below) - a row and a leading-icon + trailing-chevron pair is the whole
    // contract at this width.
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    const notificationsRow = screen.getByRole('button', { name: /Notifications/ });
    expect(notificationsRow.querySelectorAll('svg')).toHaveLength(2);

    await user.click(notificationsRow);
    expectNavigatedTo('/settings/notifications');
  });

  it("navigates to a real card's route on click", async () => {
    setViewportWidth(DESKTOP);
    setPermissions(SETTINGS_OWNER);
    const user = userEvent.setup();
    render(
      <>
        <UserSettingsHubPage />
        <Location />
      </>,
    );

    await user.click(screen.getByRole('heading', { level: 6, name: 'Appearance' }));

    expectNavigatedTo('/settings/appearance');
  });

  it('filters cards by title, and clearing restores the full set', async () => {
    setViewportWidth(DESKTOP);
    setPermissions(SETTINGS_OWNER);
    const user = userEvent.setup();
    render(<UserSettingsHubPage />);

    const search = screen.getByRole('textbox', { name: 'Search settings' });
    await user.type(search, 'Access');

    // "Access" matches only "Access Tokens" — the whole Account group (which
    // has no matching card) must disappear, header included.
    expect(screen.getByRole('heading', { level: 6, name: 'Access Tokens' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 6, name: 'Profile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 6, name: 'Appearance' })).not.toBeInTheDocument();
    expect(screen.queryByText('Account')).not.toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear settings search' }));

    expect(search).toHaveValue('');
    expect(screen.getByRole('heading', { level: 6, name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 6, name: 'Access Tokens' })).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
  });

  it('renders the card grid with descriptions at sm and above', () => {
    setViewportWidth(DESKTOP);
    setPermissions(SETTINGS_OWNER);
    render(<UserSettingsHubPage />);

    expect(screen.getByRole('heading', { level: 6, name: 'Profile' })).toBeInTheDocument();
    expect(
      screen.getByText(/your display name and profile image/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('renders the drill-down list — rows with a chevron, no descriptions — below sm', () => {
    setViewportWidth(PHONE);
    setPermissions(SETTINGS_OWNER);
    render(<UserSettingsHubPage />);

    expect(screen.getByText('Profile')).toBeInTheDocument();
    expect(
      screen.queryByText(/your display name and profile image/i),
    ).not.toBeInTheDocument();
    // No card headings at this width — titles are plain row text, not `h6`s.
    expect(screen.queryByRole('heading', { level: 6 })).not.toBeInTheDocument();

    const profileRow = screen.getByRole('button', { name: /Profile/ });
    // Leading icon + trailing chevron — an enabled row carries exactly two.
    expect(profileRow.querySelectorAll('svg')).toHaveLength(2);
  });

  describe('Scroll restoration wiring', () => {
    it('writes a scroll offset under the user-settings-hub key', async () => {
      setViewportWidth(DESKTOP);
      setPermissions(SETTINGS_OWNER);
      render(<UserSettingsHubPage />);

      Object.defineProperty(window, 'scrollY', { value: 84, configurable: true });
      window.dispatchEvent(new Event('scroll'));

      await waitFor(() => {
        expect(window.sessionStorage.getItem('eab:scroll:user-settings-hub')).toBe('84');
      });
    });
  });
});

/**
 * The point of parameterising `SettingsHub` over `hubKey` in the first place:
 * the admin hub and the user hub must never restore each other's scroll
 * offset. Issue #96's own description calls this out by name. Proving it
 * requires both hubs in the same test — writing to one key and then asserting
 * the OTHER key is untouched is the only way to catch a hub that silently
 * fell back to a shared or hardcoded key.
 */
describe('Admin hub and user hub keep separate scroll offsets', () => {
  it('writes distinct sessionStorage keys, and one hub never clobbers the other', async () => {
    setViewportWidth(DESKTOP);
    setPermissions(['system_settings:read', 'system_settings:write', 'users:read']);

    const { unmount } = render(<SettingsHubPage />);
    Object.defineProperty(window, 'scrollY', { value: 111, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    await waitFor(() => {
      expect(window.sessionStorage.getItem('eab:scroll:admin-settings-hub')).toBe('111');
    });
    unmount();

    // No user_settings-specific permission granted — proves the user hub
    // needs none of the above to mount and restore its own offset.
    setPermissions([]);
    render(<UserSettingsHubPage />);
    Object.defineProperty(window, 'scrollY', { value: 222, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    await waitFor(() => {
      expect(window.sessionStorage.getItem('eab:scroll:user-settings-hub')).toBe('222');
    });

    // The admin hub's offset survived the user hub's write untouched — the
    // two keys are genuinely independent, not the same key overwritten twice.
    expect(window.sessionStorage.getItem('eab:scroll:admin-settings-hub')).toBe('111');
    expect(window.sessionStorage.getItem('eab:scroll:user-settings-hub')).toBe('222');
  });
});

// =============================================================================
// The version line  (issue #296)
// =============================================================================
//
// THREE CLAIMS, AND THE THIRD IS THE WHOLE POINT OF THE ISSUE:
//
//   1. `__APP_VERSION__` resolves. It is a build-time `define`, not a module,
//      so a config that forgot it fails as a ReferenceError at render rather
//      than as a type error anybody would see first — and `vite.config.ts` and
//      `vitest.config.ts` are separate files that share nothing.
//   2. It renders on BOTH hubs, which is what putting it on the shared
//      component means (Settings UI Pattern rule 4).
//   3. It renders for a user holding NO permissions at all. The version was
//      previously visible only at `/admin/settings/about`, behind
//      `system_settings:read` — seeded Admin-only — so a Contributor or a
//      Viewer could not see their own build number anywhere.
// =============================================================================

describe('the application version line (#296)', () => {
  it('resolves the build-time define to this package\'s real version', () => {
    // Not a literal assertion: pinning the number here would mean editing this
    // test on every release, which is exactly what #295 makes routine.
    expect(typeof __APP_VERSION__).toBe('string');
    expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('renders at the foot of the ADMIN hub', () => {
    setViewportWidth(DESKTOP);
    setPermissions(['system_settings:read', 'users:read']);
    render(<SettingsHubPage />);

    expect(screen.getByText(`Version ${__APP_VERSION__}`)).toBeInTheDocument();
  });

  it('renders at the foot of the USER hub', () => {
    setViewportWidth(DESKTOP);
    setPermissions([]);
    render(<UserSettingsHubPage />);

    expect(screen.getByText(`Version ${__APP_VERSION__}`)).toBeInTheDocument();
  });

  it('renders for a user with NO permissions — the reason this issue exists', () => {
    // `GET /api/admin/about` is gated on `system_settings:read`, which is
    // seeded Admin-only. This line asks the API nothing and gates on nothing.
    setViewportWidth(DESKTOP);
    setPermissions([]);
    render(<UserSettingsHubPage />);

    expect(screen.getByText(`Version ${__APP_VERSION__}`)).toBeInTheDocument();
  });

  it('renders at phone width too, without a breakpoint read of its own', () => {
    // Rule 5's five coupled gates are untouched: this is content inside an
    // existing surface, so it must look the same at every width rather than
    // becoming a sixth `down('sm')`.
    setViewportWidth(PHONE);
    setPermissions([]);
    render(<UserSettingsHubPage />);

    expect(screen.getByText(`Version ${__APP_VERSION__}`)).toBeInTheDocument();
  });

  it('does not claim to be the deployed revision — About stays authoritative', () => {
    // #296 §3: About answers "what is deployed on this server" (revision,
    // install/update instants, database). This answers "what am I running".
    setViewportWidth(DESKTOP);
    setPermissions(['system_settings:read']);
    render(<SettingsHubPage />);

    const line = screen.getByText(`Version ${__APP_VERSION__}`);
    expect(line.textContent).not.toMatch(/revision|commit|deployed/i);
  });
});
