import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// The wordmark assertions below derive the expected text from `@app/shared`
// rather than restating it (issue #164, epic #161): the point of the shared
// constant is that renaming the product is a one-line change, and a suite that
// hardcoded the old name would turn that rename into ~10 unrelated failures.
//
// `getByText(APP_NAME)` is an exact, case-SENSITIVE match on the element's own
// text, which is deliberately stricter than the `/enterprise app/i` regex it
// replaces — that one would have passed on "ENTERPRISE APP" or on a wordmark
// buried in a longer sentence. The negative drill-down assertions keep using
// the same matcher via `queryByText`, so they still assert the wordmark is
// absent and not merely that some looser pattern failed to match.
import { APP_NAME } from '@app/shared';
import { render, mockAdminUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { AppBar } from '../../../components/navigation/AppBar';
import SettingsHubPage from '../../../pages/Admin/SettingsHubPage';

// `...actual` is spread, so `MemoryRouter`/`useLocation`/everything else in
// react-router-dom stays real — this only replaces `useNavigate`, which lets
// the up-navigation tests below assert the exact structural target (never
// `navigate(-1)`) without needing a real history stack to inspect.
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

beforeEach(() => {
  mockNavigate.mockClear();
});

describe('AppBar', () => {
  describe('Rendering', () => {
    it('should render app title', () => {
      render(<AppBar />);

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
    });

    it('should render as banner landmark', () => {
      render(<AppBar />);

      const appBar = screen.getByRole('banner');
      expect(appBar).toBeInTheDocument();
    });
  });

  describe('No drawer affordance', () => {
    /**
     * NEGATIVE assertions, and deliberately so. The hamburger and the
     * `onMenuClick` prop it called were deleted with the temporary drawer in
     * issue #55; navigation is the bottom bar below `sm` and the permanent rail
     * at `sm` and up. Nothing else in the suite would notice a hamburger coming
     * back — it would simply be an extra button — so these tests are the only
     * thing standing between a stray re-add and a dead affordance shipping.
     */
    it('renders no drawer toggle', () => {
      render(<AppBar />);

      expect(screen.queryByRole('button', { name: /toggle drawer/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /menu/i })).not.toBeInTheDocument();
      expect(screen.queryByTestId('MenuIcon')).not.toBeInTheDocument();
    });

    it('renders exactly two buttons: the theme toggle and the user menu', () => {
      render(<AppBar />);

      expect(screen.getAllByRole('button')).toHaveLength(2);
    });

    it('renders no hamburger at a phone width either', async () => {
      // The drawer used to be `variant="temporary"` at EVERY breakpoint, so the
      // hamburger was unconditional. Checking only the desktop width would miss
      // a re-add gated on `down('sm')`.
      render(<AppBar />);

      await act(async () => setViewportWidth(375));

      expect(screen.queryByRole('button', { name: /menu/i })).not.toBeInTheDocument();
      expect(screen.getAllByRole('button')).toHaveLength(2);
    });
  });

  describe('Theme Toggle', () => {
    it('should render theme toggle button', () => {
      render(<AppBar />);

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toBeInTheDocument();
    });

    it('should show dark mode icon in light mode', () => {
      render(<AppBar />, {
        wrapperOptions: { theme: 'light' },
      });

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toBeInTheDocument();
      // Dark mode icon (moon) should be shown when in light mode
    });

    it('should show light mode icon in dark mode', () => {
      render(<AppBar />, {
        wrapperOptions: { theme: 'dark' },
      });

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toBeInTheDocument();
      // Light mode icon (sun) should be shown when in dark mode
    });

    it('should toggle theme on click', async () => {
      const user = userEvent.setup();

      render(<AppBar />);

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      await user.click(toggleButton);

      // Theme should have toggled (via ThemeContext)
      expect(toggleButton).toBeInTheDocument();
    });
  });

  describe('User Menu', () => {
    it('should render user menu', () => {
      render(<AppBar />);

      // UserMenu component should be rendered (contains avatar button)
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('should show user menu for authenticated users', () => {
      render(<AppBar />, {
        wrapperOptions: { authenticated: true },
      });

      // Should have at least theme toggle and user menu button
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Navigation', () => {
    it('should navigate to home when title is clicked', async () => {
      const user = userEvent.setup();

      render(<AppBar />);

      const title = screen.getByText(APP_NAME);
      await user.click(title);

      // Navigation should be triggered
      expect(title).toBeInTheDocument();
    });

    it('should have clickable title', () => {
      render(<AppBar />);

      const title = screen.getByText(APP_NAME);
      expect(title).toHaveStyle({ cursor: 'pointer' });
    });
  });

  describe('Styling', () => {
    it('should use sticky positioning', () => {
      render(<AppBar />);

      const banner = screen.getByRole('banner');
      expect(banner).toBeInTheDocument();
      // AppBar should have sticky position applied via MUI
    });

    it('should have proper elevation', () => {
      render(<AppBar />);

      const banner = screen.getByRole('banner');
      expect(banner).toBeInTheDocument();
    });
  });

  describe('Responsive Behavior', () => {
    it('should render all elements on desktop', () => {
      render(<AppBar />);

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have accessible theme toggle button', () => {
      render(<AppBar />);

      const toggleButton = screen.getByRole('button', { name: /toggle theme/i });
      expect(toggleButton).toHaveAccessibleName();
    });

    it('should have proper ARIA landmarks', () => {
      render(<AppBar />);

      expect(screen.getByRole('banner')).toBeInTheDocument();
    });
  });

  describe('Drill-down engages (below sm, on a settings route)', () => {
    it('shows Back + "Settings" title, and drops the wordmark and theme toggle, at the admin hub', () => {
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/admin/settings' } });

      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.queryByText(APP_NAME)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /toggle theme/i })).not.toBeInTheDocument();
    });

    it('resolves the card title at an admin detail route', () => {
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/admin/settings/users' } });

      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
      expect(screen.getByText('Users & Allowlist')).toBeInTheDocument();
    });

    it('resolves the card title at a nested admin detail route (longest-prefix match)', () => {
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/admin/settings/users/123' } });

      expect(screen.getByText('Users & Allowlist')).toBeInTheDocument();
    });

    it('resolves the hub title at the user settings hub', () => {
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/settings' } });

      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it('resolves the card title at a user settings detail route', () => {
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/settings/tokens' } });

      expect(screen.getByText('Access Tokens')).toBeInTheDocument();
    });

    it('still renders UserMenu in the drill-down branch', () => {
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/admin/settings' } });

      // Back + avatar, and nothing else — the theme toggle is gone.
      expect(screen.getAllByRole('button')).toHaveLength(2);
      // mockUser.displayName is 'Test User' -> avatar initials 'TU'.
      expect(screen.getByText('TU')).toBeInTheDocument();
    });
  });

  describe('Up-navigation', () => {
    it('goes to the admin hub from an admin detail page (not history-relative back)', async () => {
      const user = userEvent.setup();
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/admin/settings/users' } });

      await user.click(screen.getByRole('button', { name: 'Back' }));

      expect(mockNavigate).toHaveBeenCalledWith('/admin/settings');
    });

    it('goes to home from the admin hub itself', async () => {
      const user = userEvent.setup();
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/admin/settings' } });

      await user.click(screen.getByRole('button', { name: 'Back' }));

      expect(mockNavigate).toHaveBeenCalledWith('/');
    });

    it('goes to the user settings hub from a user settings detail page', async () => {
      const user = userEvent.setup();
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/settings/tokens' } });

      await user.click(screen.getByRole('button', { name: 'Back' }));

      expect(mockNavigate).toHaveBeenCalledWith('/settings');
    });

    it('goes to home from the user settings hub itself', async () => {
      const user = userEvent.setup();
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/settings' } });

      await user.click(screen.getByRole('button', { name: 'Back' }));

      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  describe('Drill-down does NOT engage', () => {
    it('keeps the normal toolbar on a settings route at >= sm', () => {
      setViewportWidth(600);
      render(<AppBar />, { wrapperOptions: { route: '/admin/settings' } });

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('keeps the normal toolbar below sm on a non-settings route', () => {
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/' } });

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('does not treat a look-alike path as a settings surface (segment-boundary match)', () => {
      // `/admin/settings-archive` must NOT match `/admin/settings` — a bare
      // `startsWith('/admin/settings')` would wrongly claim it.
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/admin/settings-archive' } });

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });
  });

  describe('Coupled-gate invariant (AppBar vs. SettingsHub)', () => {
    /**
     * `common/Layout.tsx` documents FIVE gates, all `theme.breakpoints.down('sm')`
     * at 600px, that must move together. This test targets the tightest-coupled
     * pair: AppBar's drill-down header (5) directly over SettingsHub's own
     * compact list-vs-grid switch (4). If the two ever disagree, the user gets a
     * back-arrow header over a card grid, or a wordmark toolbar over a
     * drill-down list with no way up.
     *
     * `mockAdminUser` is required, not incidental: with the default viewer
     * `mockUser`, `visibleSettingsSections` over `ADMIN_SECTIONS` returns no
     * cards at all, and SettingsHub renders neither a `<List>` nor a
     * `<Grid container>` for either width to assert on.
     */
    it('agrees with SettingsHub on the compact treatment just below 600px', () => {
      setViewportWidth(599);
      const { container } = render(
        <>
          <AppBar />
          <SettingsHubPage />
        </>,
        {
          wrapperOptions: {
            route: '/admin/settings/users',
            authenticated: true,
            user: mockAdminUser,
          },
        },
      );

      // AppBar: compact drill-down treatment.
      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
      expect(screen.queryByText(APP_NAME)).not.toBeInTheDocument();

      // SettingsHub: compact list treatment.
      expect(screen.getAllByRole('list').length).toBeGreaterThan(0);
      expect(container.querySelectorAll('.MuiGrid-container')).toHaveLength(0);
    });

    it('agrees with SettingsHub on the wide treatment at exactly 600px', () => {
      setViewportWidth(600);
      const { container } = render(
        <>
          <AppBar />
          <SettingsHubPage />
        </>,
        {
          wrapperOptions: {
            route: '/admin/settings/users',
            authenticated: true,
            user: mockAdminUser,
          },
        },
      );

      // AppBar: normal wordmark treatment.
      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

      // SettingsHub: wide grid treatment.
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
      expect(container.querySelectorAll('.MuiGrid-container').length).toBeGreaterThan(0);
    });
  });
});
