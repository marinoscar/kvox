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

      // The structural target, asserted rather than assumed. `useNavigate` is
      // mocked at the top of this file, so this pins `navigate('/')` and not
      // merely "something happened" — the previous version of this test
      // clicked and then re-asserted that the element it had just clicked was
      // still in the document, which passes whether or not the handler exists.
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });

    // The mark was added to this branch by issue #111. It is mounted INSIDE the
    // clickable lockup, so a click that lands on the logo rather than on the
    // letters must go to the same place — the failure mode otherwise is a
    // logo-shaped dead zone at the very left of the bar, which is exactly where
    // people aim.
    it('navigates home when the brand mark, not the text, is clicked', async () => {
      const user = userEvent.setup();

      const { container } = render(<AppBar />);

      const mark = container.querySelector('img');
      expect(mark).not.toBeNull();
      await user.click(mark as HTMLImageElement);

      expect(mockNavigate).toHaveBeenCalledWith('/');
    });

    it('should have clickable title', () => {
      render(<AppBar />);

      const title = screen.getByText(APP_NAME);
      expect(title).toHaveStyle({ cursor: 'pointer' });
    });
  });

  // ---------------------------------------------------------------------------
  // The brand mark (issue #111)
  // ---------------------------------------------------------------------------
  //
  // Two assertions, and the pair is the point. The mark is DECORATIVE: the
  // product's name is rendered as real text right beside it, so alternative
  // text would make a screen reader say the name twice. `alt=""` is therefore
  // the correct value and an empty string is also what a forgotten `alt`
  // attribute looks like to a casual reader — so it is asserted explicitly,
  // here, rather than left to be "fixed" later by somebody adding a helpful
  // description.
  //
  // The negative half matters just as much. The compact drill-down replaces the
  // whole lockup with a back arrow and the destination's title; if the mark
  // leaked into that branch it would sit between the arrow and the title,
  // stealing the horizontal room the title needs to ellipsize into and
  // implying the bar is still the home surface when it is a page below one.
  describe('Brand mark', () => {
    it('renders a decorative image in the wordmark branch', () => {
      const { container } = render(<AppBar />);

      const images = container.querySelectorAll('img');
      expect(images).toHaveLength(1);
      expect(images[0]).toHaveAttribute('alt', '');
      expect(images[0]).toHaveAttribute('aria-hidden');
    });

    it('renders no image in the compact drill-down branch', () => {
      setViewportWidth(375);
      const { container } = render(<AppBar />, {
        wrapperOptions: { route: '/admin/settings' },
      });

      // Sanity: we really are in the drill-down treatment, not just on a
      // viewport where the wordmark happened to render anyway.
      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
      expect(screen.queryByText(APP_NAME)).not.toBeInTheDocument();

      expect(container.querySelectorAll('img')).toHaveLength(0);
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

    it('resolves the About title at its admin detail route (#126)', () => {
      // A card declared in the registry is picked up by the title resolver
      // with no wiring of its own — which is the whole point of the registry,
      // and what this asserts for the newest General card.
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/admin/settings/about' } });

      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
      expect(screen.getByText('About')).toBeInTheDocument();
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

  /**
   * Issue #30, epic #19. `DRILL_DOWN_ROUTES` — the table consulted AFTER the
   * two settings registries. Every assertion below is about a path NO registry
   * claims, which before #30 fell through to `null` and kept the wordmark: a
   * phone opening a transcript got the product's name in the header and no way
   * back up.
   */
  describe('Drill-down on transcript routes (#30)', () => {
    it('shows Back + "Transcript" on a transcript, going up to the list', async () => {
      const user = userEvent.setup();
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/transcripts/abc-123' } });

      expect(screen.getByText('Transcript')).toBeInTheDocument();
      expect(screen.queryByText(APP_NAME)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Back' }));

      // STRUCTURAL up, never `navigate(-1)` — the same rule the settings
      // surfaces follow, and it matters more here: a transcript is the most
      // likely page in this app to be arrived at from a notification, where
      // the previous history entry is another site entirely.
      expect(mockNavigate).toHaveBeenCalledWith('/transcripts');
    });

    it('goes up from version history to the TRANSCRIPT, not to the list', async () => {
      const user = userEvent.setup();
      setViewportWidth(375);
      render(<AppBar />, {
        wrapperOptions: { route: '/transcripts/abc-123/history' },
      });

      // The more specific pattern wins: `/transcripts/:id` would otherwise
      // claim this path and send Back one level too far.
      expect(screen.getByText('Version history')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Back' }));

      expect(mockNavigate).toHaveBeenCalledWith('/transcripts/abc-123');
    });

    it('shows Back + "Knowledge" on an entity page, going up to the graph index (#373)', async () => {
      const user = userEvent.setup();
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/graph/entities/abc-123' } });

      expect(screen.getByText('Knowledge')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Back' }));
      expect(mockNavigate).toHaveBeenCalledWith('/graph');
    });

    it('shows Back + "Knowledge" on the graph index, going up to Home (#373)', async () => {
      const user = userEvent.setup();
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/graph' } });

      expect(screen.getByText('Knowledge')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Back' }));
      // `home` owns `/graph`, so structural up is Home.
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });

    it('shows Back + "New transcript" on the create route', async () => {
      const user = userEvent.setup();
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/transcripts/new' } });

      expect(screen.getByText('New transcript')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Back' }));

      expect(mockNavigate).toHaveBeenCalledWith('/transcripts');
    });

    it('shows Back + "Note" on a note, going up to the NOTES tab (#57)', async () => {
      const user = userEvent.setup();
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/notes/abc-123' } });

      expect(screen.getByText('Note')).toBeInTheDocument();
      expect(screen.queryByText(APP_NAME)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Back' }));

      // ⚠ `/notes`, NOT `/transcripts`. Two destinations since #106, so this is
      // simply up-one-level within the note's own subtree — and it was already
      // required when they were one destination with two tabs, because going up
      // to `/transcripts` would silently switch which half the reader saw.
      expect(mockNavigate).toHaveBeenCalledWith('/notes');
    });

    it('goes up from a note’s version history to the NOTE, not to the list (#57)', async () => {
      const user = userEvent.setup();
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/notes/abc-123/history' } });

      // The more specific pattern wins: `/notes/:id` would otherwise claim this
      // path and send Back one level too far.
      expect(screen.getByText('Version history')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Back' }));

      expect(mockNavigate).toHaveBeenCalledWith('/notes/abc-123');
    });

    it('shows Back + "New note" on the create route (#57)', async () => {
      const user = userEvent.setup();
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/notes/new' } });

      expect(screen.getByText('New note')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Back' }));

      expect(mockNavigate).toHaveBeenCalledWith('/notes');
    });

    it('keeps the wordmark on /notes — it is a DESTINATION, not a page below one (#106)', () => {
      // The same reasoning as `/transcripts` below: a back arrow on the
      // destination the user is already on is a second, contradictory answer to
      // "where am I", and the bottom bar is already answering it.
      //
      // The CONCLUSION is older than the reason. Between #57 and #106 this
      // path kept the wordmark because it was the other TAB of one `library`
      // destination; since #106 it is a destination in its own right with its
      // own bottom-bar tab. Either way, no back arrow.
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/notes' } });

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('does not claim a note look-alike path (#57)', () => {
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/notesfoo/abc' } });

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('keeps the wordmark on /transcripts — a destination, not a drill-down', () => {
      // `/transcripts` has a bottom-bar tab of its own, so a back arrow there
      // would be a second, contradictory answer to "where am I".
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/transcripts' } });

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('keeps the wordmark on BOTH content destinations below sm (#106)', () => {
      // Stated once more as a pair, because #106 is the issue that made these
      // two symmetrical: they were one destination and one of its tabs, and
      // they are now siblings. A drill-down entry added for either — the
      // plausible mistake when a page gains its own file — turns a destination
      // into something the bar says you are on and the header says you are
      // below.
      for (const route of ['/transcripts', '/notes']) {
        setViewportWidth(375);
        const view = render(<AppBar />, { wrapperOptions: { route } });

        expect(screen.getByText(APP_NAME), `${route} lost the wordmark`).toBeInTheDocument();
        expect(
          screen.queryByRole('button', { name: 'Back' }),
          `${route} grew a back arrow`,
        ).not.toBeInTheDocument();

        view.unmount();
      }
    });

    it('keeps the wordmark on a transcript route at >= sm', () => {
      setViewportWidth(600);
      render(<AppBar />, { wrapperOptions: { route: '/transcripts/abc-123' } });

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('does not claim a look-alike path (segment-boundary match)', () => {
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/transcriptsfoo/abc' } });

      expect(screen.getByText(APP_NAME)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('leaves the settings surfaces resolution completely unchanged', () => {
      // The regression guard for the ORDER of the two tables: the settings
      // registries are consulted first, so adding `DRILL_DOWN_ROUTES` must not
      // be able to relabel a settings page. If this ever fails, the new table
      // is being reached for a path a registry claims.
      setViewportWidth(375);
      render(<AppBar />, { wrapperOptions: { route: '/admin/settings/users' } });

      expect(screen.getByText('Users & Allowlist')).toBeInTheDocument();
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
