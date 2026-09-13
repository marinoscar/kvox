import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { NavigationRail, RAIL_WIDTH_COLLAPSED } from '../../../components/navigation/NavigationRail';

/**
 * Coverage migrated from the deleted `Sidebar.test.tsx` — four items, admin
 * gating, active highlight, navigate-on-click — plus what the rail adds that a
 * temporary drawer never had: two width treatments, a persisted collapse
 * preference, and real links.
 */

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../../hooks/useNavigationPrefs', () => ({
  useNavigationPrefs: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';
import { useNavigationPrefs } from '../../../hooks/useNavigationPrefs';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseNavigationPrefs = vi.mocked(useNavigationPrefs);

const toggleRailCollapsed = vi.fn();

function setPermissions(granted: string[], isAdmin = false) {
  mockUsePermissions.mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: (perm: string) => granted.includes(perm),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin,
  });
}

function setPrefs(railCollapsed: boolean) {
  mockUseNavigationPrefs.mockReturnValue({
    railCollapsed,
    toggleRailCollapsed,
    isLoading: false,
  });
}

const ADMIN_PERMISSIONS = ['users:read', 'system_settings:read'];

describe('NavigationRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions([]);
    setPrefs(false);
  });

  describe('Destinations', () => {
    it('renders all three destinations for a fully permitted user', () => {
      // THREE, not four: issue #92 merged `User Management` and `System
      // Settings` into one `Console` row, because two rows both matching
      // `/admin/*` give the rail two active candidates on every admin route.
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      const nav = screen.getByRole('navigation', { name: /main navigation/i });
      expect(within(nav).getAllByRole('link')).toHaveLength(3);
      expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'User Settings' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Console' })).toBeInTheDocument();
    });

    it('hides Console from a user holding neither admin permission', () => {
      render(<NavigationRail />);

      expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'User Settings' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Console' })).not.toBeInTheDocument();
    });

    it('gates on PERMISSION, not on the admin role', () => {
      // The bug this replaces: the old Sidebar gated on the `admin` role while
      // UserMenu gated on `system_settings:read`, so a Contributor granted that
      // permission got a menu entry and a working page with no route in.
      setPermissions(['system_settings:read'], false);

      render(<NavigationRail />);

      expect(screen.getByRole('link', { name: 'Console' })).toBeInTheDocument();
    });

    it('shows Console on users:read alone', () => {
      // The half of `anyPermission` that a single-string gate would have
      // dropped: this user can administer users but not system settings, and
      // the surface is still worth reaching for the Users & Allowlist page.
      setPermissions(['users:read'], false);

      render(<NavigationRail />);

      expect(screen.getByRole('link', { name: 'Console' })).toBeInTheDocument();
    });
  });

  describe('Links, not click handlers', () => {
    it('renders each row as a real anchor with an href', () => {
      // An onClick div gives up focus, middle-click and tab order — and needed
      // the `setTimeout(() => navigate(path), 0)` the drawer forced on it.
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
      expect(screen.getByRole('link', { name: 'User Settings' })).toHaveAttribute(
        'href',
        '/settings',
      );
      expect(screen.getByRole('link', { name: 'Console' })).toHaveAttribute(
        'href',
        '/admin/settings',
      );
    });

    it('navigates on click without any deferred timer', async () => {
      const user = userEvent.setup();
      render(<NavigationRail />, { wrapperOptions: { route: '/' } });

      await user.click(screen.getByRole('link', { name: 'User Settings' }));

      await waitFor(() => {
        expect(screen.getByRole('link', { name: 'User Settings' })).toHaveAttribute(
          'aria-current',
          'page',
        );
      });
    });
  });

  describe('Active state', () => {
    it('marks the active destination with aria-current="page"', () => {
      render(<NavigationRail />, { wrapperOptions: { route: '/settings' } });

      expect(screen.getByRole('link', { name: 'User Settings' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
    });

    it('marks exactly one row active on a nested admin route', () => {
      setPermissions(ADMIN_PERMISSIONS, true);

      // A genuinely nested settings route (#92), not just `/admin/settings`:
      // Console owns the whole `/admin` subtree, so this is where two admin
      // rows would have produced two `aria-current` attributes.
      render(<NavigationRail />, {
        wrapperOptions: { route: '/admin/settings/users', user: mockAdminUser },
      });

      const current = screen
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page');
      expect(current).toHaveLength(1);
      // Not 'Console' any more (#94): at >= lg this route is Console mode, so
      // the `Console` destination row is absent entirely and the active row is
      // the longest-prefix-matching admin card — `Users & Allowlist`
      // (`/admin/settings/users`) — rather than the library destination that
      // used to own the whole `/admin` subtree. The one-`aria-current`
      // invariant above is what this test actually guards and is unchanged.
      expect(current[0]).toHaveAccessibleName('Users & Allowlist');
    });

    it('marks nothing active on a route no destination owns', () => {
      // `/settingsfoo` would match under the old `startsWith` isActive.
      render(<NavigationRail />, { wrapperOptions: { route: '/settingsfoo' } });

      const current = screen
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page');
      expect(current).toHaveLength(0);
    });
  });

  describe('Two treatments', () => {
    it('shows full labels as visible text at >= lg', () => {
      render(<NavigationRail />);

      expect(screen.getByText('User Settings')).toBeInTheDocument();
      expect(screen.queryByText('Settings')).not.toBeInTheDocument();
    });

    it('shows compact captions below lg, with the full label still accessible', async () => {
      render(<NavigationRail />);

      await act(async () => setViewportWidth(800));

      // The caption is aria-hidden; the accessible name is still the full label,
      // so the row is findable by it either way.
      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'User Settings' })).toBeInTheDocument();
    });

    it('stays collapsed below lg even when the stored preference says expanded', async () => {
      // Honouring `railCollapsed: false` at 800px would render a 220px rail on
      // a screen that has room for 56.
      setPrefs(false);
      render(<NavigationRail />);

      await act(async () => setViewportWidth(800));

      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.queryByText('User Settings')).not.toBeInTheDocument();
    });

    it('honours the stored collapse preference at >= lg', () => {
      setPrefs(true);

      render(<NavigationRail />);

      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.queryByText('User Settings')).not.toBeInTheDocument();
    });
  });

  describe('Collapse toggle', () => {
    it('is a real button carrying aria-expanded', () => {
      render(<NavigationRail />);

      const toggle = screen.getByRole('button', { name: /collapse navigation/i });
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    });

    it('reports aria-expanded=false when the rail is collapsed', () => {
      setPrefs(true);

      render(<NavigationRail />);

      const toggle = screen.getByRole('button', { name: /expand navigation/i });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    it('calls the persisted toggle on click', async () => {
      const user = userEvent.setup();
      render(<NavigationRail />);

      await user.click(screen.getByRole('button', { name: /collapse navigation/i }));

      expect(toggleRailCollapsed).toHaveBeenCalledTimes(1);
    });

    it('is desktop-only — the medium tier is forced collapsed, so a toggle there would lie', async () => {
      render(<NavigationRail />);

      await act(async () => setViewportWidth(800));

      expect(screen.queryByRole('button', { name: /navigation/i })).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('is a nav landmark with an accessible name', () => {
      render(<NavigationRail />);

      expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    });

    it('keeps DOM order equal to visual order, so focus order follows it', () => {
      setPermissions(ADMIN_PERMISSIONS, true);

      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
        '/',
        '/settings',
        '/admin/settings',
      ]);
    });
  });

  describe('Console mode (#94)', () => {
    // A user holding every admin permission, so a section is never dropped by
    // `visibleSettingsSections` — the gating tests below flip permissions off
    // one at a time instead.
    const FULL_ADMIN_PERMISSIONS = [
      'system_settings:read',
      'system_settings:write',
      'users:read',
    ];

    describe('renders', () => {
      beforeEach(() => {
        setPermissions(FULL_ADMIN_PERMISSIONS, true);
      });

      it('renders both group headers', () => {
        render(<NavigationRail />, {
          wrapperOptions: { route: '/admin/settings/users', user: mockAdminUser },
        });

        expect(screen.getByText('General')).toBeInTheDocument();
        expect(screen.getByText('Access')).toBeInTheDocument();
      });

      it('renders the card rows with their titles', () => {
        render(<NavigationRail />, {
          wrapperOptions: { route: '/admin/settings/users', user: mockAdminUser },
        });

        expect(screen.getByRole('link', { name: 'Email' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Maintenance' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Users & Allowlist' })).toBeInTheDocument();
      });

      it('renders a permanent Back to library row linking to /', () => {
        render(<NavigationRail />, {
          wrapperOptions: { route: '/admin/settings/users', user: mockAdminUser },
        });

        expect(screen.getByRole('link', { name: 'Back to library' })).toHaveAttribute(
          'href',
          '/',
        );
      });

      it('hides the Console destination row — Back to library is the way out instead', () => {
        render(<NavigationRail />, {
          wrapperOptions: { route: '/admin/settings/users', user: mockAdminUser },
        });

        expect(screen.queryByRole('link', { name: 'Console' })).not.toBeInTheDocument();
      });

      it('names the nav landmark "Console navigation"', () => {
        render(<NavigationRail />, {
          wrapperOptions: { route: '/admin/settings/users', user: mockAdminUser },
        });

        expect(
          screen.getByRole('navigation', { name: 'Console navigation' }),
        ).toBeInTheDocument();
      });
    });

    describe('does not engage outside expanded desktop', () => {
      it('stays library navigation at sm-lg on the same /admin/* path — the expanded-only rule', async () => {
        // The rule most likely to be "fixed" into always-on later: Console mode
        // is `isConsole && expanded`, never `isConsole` alone. A 56px column
        // cannot host labelled group headers (see the file header), so the
        // medium tier keeps library destinations even under `/admin`.
        setPermissions(FULL_ADMIN_PERMISSIONS, true);
        render(<NavigationRail />, {
          wrapperOptions: { route: '/admin/settings/users', user: mockAdminUser },
        });

        await act(async () => setViewportWidth(800));

        expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Console' })).toBeInTheDocument();
        expect(
          screen.queryByRole('link', { name: 'Users & Allowlist' }),
        ).not.toBeInTheDocument();
      });

      it('stays library navigation when a desktop user has collapsed the rail, on the same /admin/* path', () => {
        setPermissions(FULL_ADMIN_PERMISSIONS, true);
        setPrefs(true);
        render(<NavigationRail />, {
          wrapperOptions: { route: '/admin/settings/users', user: mockAdminUser },
        });

        expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Console' })).toBeInTheDocument();
        expect(
          screen.queryByRole('link', { name: 'Users & Allowlist' }),
        ).not.toBeInTheDocument();
      });

      it.each(['/', '/settings'])(
        'stays library navigation on the non-admin route %s at >= lg',
        (route) => {
          setPermissions(FULL_ADMIN_PERMISSIONS, true);
          render(<NavigationRail />, { wrapperOptions: { route, user: mockAdminUser } });

          expect(
            screen.getByRole('navigation', { name: 'Main navigation' }),
          ).toBeInTheDocument();
          expect(screen.getByRole('link', { name: 'Console' })).toBeInTheDocument();
        },
      );
    });

    describe('active state', () => {
      beforeEach(() => {
        setPermissions(FULL_ADMIN_PERMISSIONS, true);
      });

      it('marks exactly one row active on /admin/settings/users, and it is Users & Allowlist', () => {
        // A plain `owns()` per card would light up more than one row here —
        // see the `longest prefix wins` comment on `consoleActivePath`.
        render(<NavigationRail />, {
          wrapperOptions: { route: '/admin/settings/users', user: mockAdminUser },
        });

        const current = screen
          .getAllByRole('link')
          .filter((link) => link.getAttribute('aria-current') === 'page');
        expect(current).toHaveLength(1);
        expect(current[0]).toHaveAccessibleName('Users & Allowlist');
      });

      it('marks nothing active on the hub path /admin/settings itself', () => {
        // No card's own path matches the hub path, and `Back to library` is
        // explicitly `active={false}` — so nothing should carry aria-current.
        render(<NavigationRail />, {
          wrapperOptions: { route: '/admin/settings', user: mockAdminUser },
        });

        const current = screen
          .getAllByRole('link')
          .filter((link) => link.getAttribute('aria-current') === 'page');
        expect(current).toHaveLength(0);
      });

      it('keeps Users & Allowlist active on a nested child route', () => {
        render(<NavigationRail />, {
          wrapperOptions: { route: '/admin/settings/users/123', user: mockAdminUser },
        });

        const current = screen
          .getAllByRole('link')
          .filter((link) => link.getAttribute('aria-current') === 'page');
        expect(current).toHaveLength(1);
        expect(current[0]).toHaveAccessibleName('Users & Allowlist');
      });
    });

    describe('permission gating', () => {
      it('shows ACCESS and Users & Allowlist, and hides GENERAL entirely, for users:read alone', () => {
        // Not just "the General cards are absent" — the emptied `General`
        // header must be gone too, since a bare header above nothing reads as
        // a loading failure rather than "you may see none of these"
        // (`visibleSettingsSections` drops empty sections).
        setPermissions(['users:read'], false);

        render(<NavigationRail />, { wrapperOptions: { route: '/admin/settings/users' } });

        expect(screen.getByText('Access')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Users & Allowlist' })).toBeInTheDocument();

        expect(screen.queryByText('General')).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Email' })).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Notifications' })).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Maintenance' })).not.toBeInTheDocument();
      });

      it('hides Web Push for system_settings:read without push:read', () => {
        // `Web Push` gates on its own dedicated permission, unlike its General
        // siblings, which all mirror `system_settings:read` — generating and
        // rotating key material is not routine settings access.
        setPermissions(['system_settings:read'], false);

        render(<NavigationRail />, { wrapperOptions: { route: '/admin/settings/users' } });

        expect(screen.getByRole('link', { name: 'Email' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Maintenance' })).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Web Push' })).not.toBeInTheDocument();
      });
    });
  });

  describe('Pinned foot section (#105)', () => {
    // Console is a MODE, not a third library destination, and its position at
    // the rail's foot is what says so. The old inline render — Console folded
    // into `visibleDestinations.map(...)` as the third row — put all three
    // links in ONE <ul>, which a naive "all three links exist" assertion
    // cannot tell apart from the fix. Every test below asserts the STRUCTURE
    // (a separate list, preceded by its own divider) rather than mere
    // presence, so it fails against that inline render.
    function pinnedList(nav: HTMLElement): HTMLElement {
      const consoleLink = within(nav).getByRole('link', { name: 'Console' });
      const list = consoleLink.closest('ul');
      if (!list) throw new Error('Console link is not inside a <ul>');
      return list as HTMLElement;
    }

    it('renders Console in a different list than Home and Settings, preceded by a divider', () => {
      setPermissions(ADMIN_PERMISSIONS, true);
      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      const nav = screen.getByRole('navigation', { name: /main navigation/i });
      const homeList = within(nav).getByRole('link', { name: 'Home' }).closest('ul');
      const footList = pinnedList(nav);

      expect(homeList).not.toBeNull();
      expect(footList).not.toBe(homeList);
      // A divider sits immediately above the foot list specifically — not
      // just somewhere on the page. The collapse toggle below the foot
      // section has its own divider too, so "a divider exists" alone would
      // not catch one in the wrong place.
      expect(footList.previousElementSibling?.tagName).toBe('HR');
      // `<hr>` carries the "separator" role implicitly (no explicit `role`
      // attribute), so confirm it via the accessibility tree rather than the
      // DOM attribute — this is the same element `getAllByRole` below counts.
      expect(within(nav).getAllByRole('separator')).toContain(footList.previousElementSibling);
    });

    it('keeps the pinned row last in DOM order, matching visual order', () => {
      setPermissions(ADMIN_PERMISSIONS, true);
      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
        '/',
        '/settings',
        '/admin/settings',
      ]);
    });

    it('pins Console at the foot in the collapsed tier (sm–lg)', async () => {
      setPermissions(ADMIN_PERMISSIONS, true);
      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      await act(async () => setViewportWidth(800));

      const nav = screen.getByRole('navigation', { name: /main navigation/i });
      const homeList = within(nav).getByRole('link', { name: 'Home' }).closest('ul');
      const footList = pinnedList(nav);

      expect(footList).not.toBe(homeList);
      expect(footList.previousElementSibling?.tagName).toBe('HR');
    });

    it('pins Console at the foot in the expanded rail on a non-admin route', () => {
      setPermissions(ADMIN_PERMISSIONS, true);
      render(<NavigationRail />, { wrapperOptions: { route: '/', user: mockAdminUser } });

      const nav = screen.getByRole('navigation', { name: /main navigation/i });
      expect(pinnedList(nav).previousElementSibling?.tagName).toBe('HR');
    });

    it('stays absent inside Console mode — Back to library is the affordance instead (#94)', () => {
      setPermissions(ADMIN_PERMISSIONS, true);
      render(<NavigationRail />, {
        wrapperOptions: { route: '/admin/settings/users', user: mockAdminUser },
      });

      expect(screen.queryByRole('link', { name: 'Console' })).not.toBeInTheDocument();
      // The pinned row links to /admin/settings specifically; Console mode's
      // own cards link to their own card paths, never the bare hub path, so
      // this is the one href a resurrected pinned row would introduce.
      const links = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
      expect(links).not.toContain('/admin/settings');
    });

    it('adds no orphan divider for a user holding neither system_settings:read nor users:read', () => {
      setPermissions([], false);
      render(<NavigationRail />);

      const nav = screen.getByRole('navigation', { name: /main navigation/i });
      // Only the collapse toggle's own divider remains — no pinned foot
      // section, so no divider hanging above an empty list. This is the edge
      // the `pinnedDestinations.length > 0` guard exists for.
      expect(within(nav).getAllByRole('separator')).toHaveLength(1);
      expect(screen.queryByRole('link', { name: 'Console' })).not.toBeInTheDocument();
    });

    it('keeps aria-current="page" on the pinned row at the collapsed tier — a relocated destination, not a shortcut', async () => {
      setPermissions(ADMIN_PERMISSIONS, true);
      render(<NavigationRail />, {
        wrapperOptions: { route: '/admin/settings/users', user: mockAdminUser },
      });

      // Collapsed tier: Console mode is expanded-only, so this route still
      // renders the library rail with Console pinned at the foot, and it must
      // still carry the active-state landmark its inline predecessor did.
      await act(async () => setViewportWidth(800));

      expect(screen.getByRole('link', { name: 'Console' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });
  });

  describe('Collapsed caption chrome (#105)', () => {
    // The bug: `mx: 0.5` + `px: 0.5` (16px of horizontal margin+padding) left
    // a ~40px caption box inside the 56px collapsed rail, and "Settings" /
    // "Console" both measure ~41px at the caption's 0.625rem — so both
    // ellipsised. The fix halves each to 0.25 (8px total), leaving a 48px
    // box. jsdom performs no layout, so a textContent check alone cannot see
    // an ellipsis — only the underlying chrome, asserted here via
    // getComputedStyle, can catch a regression back to the old spacing.
    function horizontalChrome(el: Element): number {
      const style = getComputedStyle(el);
      return (
        parseFloat(style.marginLeft) +
        parseFloat(style.marginRight) +
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight)
      );
    }

    it('keeps RAIL_WIDTH_COLLAPSED at 56 — the fix reclaims chrome, not rail width', () => {
      expect(RAIL_WIDTH_COLLAPSED).toBe(56);
    });

    it('reclaims the collapsed row chrome to 8px total, leaving a 48px caption box', async () => {
      setPermissions(ADMIN_PERMISSIONS, true);
      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      await act(async () => setViewportWidth(800));

      // Queried by the row's accessible name (the full label) — the visible
      // caption is aria-hidden, so it cannot be found by accessible name.
      const settingsRow = screen.getByRole('link', { name: 'User Settings' });
      const consoleRow = screen.getByRole('link', { name: 'Console' });

      expect(horizontalChrome(settingsRow)).toBeCloseTo(8, 5);
      expect(horizontalChrome(consoleRow)).toBeCloseTo(8, 5);
      // RAIL_WIDTH_COLLAPSED (56) minus that chrome is the 48px box the fix's
      // comment measures the captions against.
      expect(RAIL_WIDTH_COLLAPSED - horizontalChrome(settingsRow)).toBe(48);
    });

    it('renders the collapsed captions as full text content, not an abbreviation', async () => {
      setPermissions(ADMIN_PERMISSIONS, true);
      render(<NavigationRail />, { wrapperOptions: { user: mockAdminUser } });

      await act(async () => setViewportWidth(800));

      // The caption is aria-hidden; query by literal text rather than by
      // accessible name, which stays the full label either way and would not
      // distinguish a full caption from a shortened one.
      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.getByText('Console')).toBeInTheDocument();
    });
  });
});
