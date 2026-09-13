import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TuneIcon from '@mui/icons-material/Tune';
import PaletteIcon from '@mui/icons-material/Palette';
import FlagIcon from '@mui/icons-material/Flag';
import DataObjectIcon from '@mui/icons-material/DataObject';

import { render } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { SettingsHub } from '../../../components/settings/SettingsHub';
import type { SettingsHubProps } from '../../../components/settings/SettingsHub';
import type { SettingsSectionDef } from '../../../config/adminSections';

/**
 * Issue #93, epic #90. `SettingsHub` is the shared component both the admin
 * hub (this issue) and the user hub (#96) render, so most of this suite
 * drives it directly through a small, HAND-BUILT fixture registry rather than
 * `ADMIN_SECTIONS`. Pinning to the real registry would mean every future
 * settings page needs a matching edit here just to keep the suite green — the
 * exact churn a controlled fixture avoids, while still exercising every real
 * behaviour: search, permission gating, the two width treatments, disabled
 * cards.
 *
 * A short pass at the bottom renders the real admin binding
 * (`pages/Admin/SettingsHubPage`) with the real `ADMIN_SECTIONS`, to catch
 * anything the fixture can't — a bad title/subtitle constant, the wrong
 * `hubKey`, or a route that doesn't match what `App.tsx` actually wires.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';
import SettingsHubPage from '../../../pages/Admin/SettingsHubPage';
import UserSettingsHubPage from '../../../pages/UserSettingsHubPage';

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

const PHONE = 375;
const DESKTOP = 1400;

/**
 * `Toaster Oven` has no `path`, which the component treats identically to
 * `disabled: true` — "declared but not yet routed" is the same inert state
 * as "declared and switched off". `Banana Bread`'s description deliberately
 * contains the word "apple" and `Apple Pie`'s contains "lattice": neither
 * word appears in any TITLE, which is what lets the search tests prove the
 * match is title-only.
 */
const FIXTURE_SECTIONS: SettingsSectionDef[] = [
  {
    label: 'Kitchen',
    cards: [
      {
        title: 'Apple Pie',
        description: 'A dessert with a lattice crust.',
        Icon: TuneIcon,
        path: '/fixture/apple',
      },
      {
        title: 'Banana Bread',
        description: 'A moist loaf, good with apple butter.',
        Icon: PaletteIcon,
        path: '/fixture/banana',
      },
      {
        title: 'Toaster Oven',
        description: 'A compact countertop oven — not wired up yet.',
        Icon: FlagIcon,
        // No `path` on purpose: inert, same as `disabled: true`.
      },
    ],
  },
  {
    label: 'Vault',
    cards: [
      {
        title: 'Secret Recipe',
        description: "Grandma's secret sauce formula.",
        Icon: DataObjectIcon,
        path: '/fixture/secret',
        permission: 'fixture:secret',
      },
    ],
  },
];

/** Grants every permission the fixture registry gates on. */
const FIXTURE_PERMISSIONS = ['fixture:secret'];

/** A registry every card of which is gated behind a permission nobody in this suite holds. */
const ALL_GATED_SECTIONS: SettingsSectionDef[] = [
  {
    label: 'Restricted',
    cards: [
      {
        title: 'Gated Card',
        description: 'Visible only with a permission nobody in this suite holds.',
        Icon: TuneIcon,
        path: '/fixture/gated',
        permission: 'fixture:unreachable',
      },
    ],
  },
];

function renderHub(
  sections: SettingsSectionDef[] = FIXTURE_SECTIONS,
  overrides: Partial<Omit<SettingsHubProps, 'sections'>> = {},
) {
  return render(
    <SettingsHub
      sections={sections}
      hubKey="fixture-hub"
      title="Fixture Settings"
      subtitle="Fixture subtitle copy."
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setPermissions(FIXTURE_PERMISSIONS);
  window.sessionStorage.clear();
});

describe('SettingsHub', () => {
  describe('Structure', () => {
    it.each([
      ['compact', PHONE],
      ['wide', DESKTOP],
    ])('renders the title and subtitle at %s width', (_label, width) => {
      setViewportWidth(width);
      renderHub();

      expect(
        screen.getByRole('heading', { level: 4, name: 'Fixture Settings' }),
      ).toBeInTheDocument();
      expect(screen.getByText('Fixture subtitle copy.')).toBeInTheDocument();
    });

    it.each([
      ['compact', PHONE],
      ['wide', DESKTOP],
    ])('renders the search field with its accessible name at %s width', (_label, width) => {
      setViewportWidth(width);
      renderHub();

      expect(screen.getByRole('textbox', { name: 'Search settings' })).toBeInTheDocument();
    });
  });

  describe('Card grid (>= sm)', () => {
    beforeEach(() => setViewportWidth(DESKTOP));

    it('renders every visible card title and description', () => {
      renderHub();

      expect(screen.getByRole('heading', { level: 6, name: 'Apple Pie' })).toBeInTheDocument();
      expect(screen.getByText('A dessert with a lattice crust.')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 6, name: 'Banana Bread' })).toBeInTheDocument();
      expect(screen.getByText('A moist loaf, good with apple butter.')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 6, name: 'Secret Recipe' })).toBeInTheDocument();
      expect(screen.getByText("Grandma's secret sauce formula.")).toBeInTheDocument();
    });

    it('renders each visible card as a single focusable action target', () => {
      renderHub();

      // Three enabled cards (Apple Pie, Banana Bread, Secret Recipe) => three
      // buttons. Toaster Oven is inert and contributes none. If title and
      // description were separately focusable, this count would be wrong.
      const cardButtons = screen.getAllByRole('button');
      expect(cardButtons).toHaveLength(3);

      const appleCard = screen.getByRole('heading', { level: 6, name: 'Apple Pie' }).closest(
        'button',
      )!;
      expect(within(appleCard).getByText('A dessert with a lattice crust.')).toBeInTheDocument();
    });

    it("navigates to the clicked card's path", async () => {
      const user = userEvent.setup();
      renderHub();

      await user.click(screen.getByRole('heading', { level: 6, name: 'Banana Bread' }));

      expect(mockNavigate).toHaveBeenCalledWith('/fixture/banana');
    });
  });

  describe('Drill-down list (< sm)', () => {
    beforeEach(() => setViewportWidth(PHONE));

    it('renders row titles with a chevron, and never a description', () => {
      renderHub();

      expect(screen.getByText('Apple Pie')).toBeInTheDocument();
      expect(screen.queryByText('A dessert with a lattice crust.')).not.toBeInTheDocument();
      expect(screen.queryByText('A moist loaf, good with apple butter.')).not.toBeInTheDocument();
      expect(screen.queryByText("Grandma's secret sauce formula.")).not.toBeInTheDocument();

      // An enabled row carries two icons — the leading icon and the trailing
      // chevron. The inert row (checked below, and again in "Disabled /
      // pathless cards") swaps the chevron for a "Coming soon" chip instead.
      const appleRow = screen.getByRole('button', { name: /Apple Pie/ });
      expect(appleRow.querySelectorAll('svg')).toHaveLength(2);
    });

    it("navigates to the clicked row's path", async () => {
      const user = userEvent.setup();
      renderHub();

      await user.click(screen.getByRole('button', { name: /Secret Recipe/ }));

      expect(mockNavigate).toHaveBeenCalledWith('/fixture/secret');
    });
  });

  describe('Mounting, not CSS', () => {
    it('mounts only the grid at wide widths — no list role, no card headings hidden elsewhere', () => {
      setViewportWidth(DESKTOP);
      const { container } = renderHub();

      expect(screen.queryByRole('list')).not.toBeInTheDocument();
      expect(container.querySelectorAll('.MuiGrid-container').length).toBeGreaterThan(0);
    });

    it('mounts only the drill-down list at compact widths — the grid cards are absent, not hidden', () => {
      setViewportWidth(PHONE);
      const { container } = renderHub();

      expect(screen.getAllByRole('list').length).toBeGreaterThan(0);
      // "Absent", not "hidden": no card DOM at all, not merely display:none.
      expect(container.querySelectorAll('.MuiCard-root').length).toBe(0);
      expect(container.querySelectorAll('.MuiGrid-container').length).toBe(0);
      expect(screen.queryByRole('heading', { level: 6 })).not.toBeInTheDocument();
    });
  });

  describe('Search', () => {
    it.each([
      ['compact', PHONE],
      ['wide', DESKTOP],
    ])('filters by title, case-insensitively, at %s width', async (_label, width) => {
      setViewportWidth(width);
      const user = userEvent.setup();
      renderHub();

      await user.type(screen.getByRole('textbox', { name: 'Search settings' }), 'APPLE');

      expect(screen.getByText('Apple Pie')).toBeInTheDocument();
      expect(screen.queryByText('Banana Bread')).not.toBeInTheDocument();
    });

    it('does not match a term that appears only in a description', async () => {
      setViewportWidth(DESKTOP);
      const user = userEvent.setup();
      renderHub();

      // "lattice" is in Apple Pie's DESCRIPTION only — no card title contains it.
      await user.type(screen.getByRole('textbox', { name: 'Search settings' }), 'lattice');

      expect(screen.queryByText('Apple Pie')).not.toBeInTheDocument();
      expect(screen.getByText('No settings match “lattice”.')).toBeInTheDocument();
    });

    it('drops a group entirely, header included, once every card in it filters out', async () => {
      setViewportWidth(DESKTOP);
      const user = userEvent.setup();
      renderHub();

      // "banana" matches only Banana Bread's title. Vault's one card
      // (Secret Recipe) has no match, so the whole group — header too — must
      // disappear, while Kitchen survives with its one matching card.
      await user.type(screen.getByRole('textbox', { name: 'Search settings' }), 'banana');

      expect(screen.getByText('Kitchen')).toBeInTheDocument();
      expect(screen.getByText('Banana Bread')).toBeInTheDocument();
      expect(screen.queryByText('Apple Pie')).not.toBeInTheDocument();
      expect(screen.queryByText('Vault')).not.toBeInTheDocument();
      expect(screen.queryByText('Secret Recipe')).not.toBeInTheDocument();
    });

    it('shows the clear button only once a query exists, and clearing restores the full set', async () => {
      setViewportWidth(DESKTOP);
      const user = userEvent.setup();
      renderHub();

      expect(
        screen.queryByRole('button', { name: 'Clear settings search' }),
      ).not.toBeInTheDocument();

      const search = screen.getByRole('textbox', { name: 'Search settings' });
      await user.type(search, 'banana');
      expect(screen.queryByText('Apple Pie')).not.toBeInTheDocument();

      const clearButton = screen.getByRole('button', { name: 'Clear settings search' });
      await user.click(clearButton);

      expect(search).toHaveValue('');
      expect(
        screen.queryByRole('button', { name: 'Clear settings search' }),
      ).not.toBeInTheDocument();
      expect(screen.getByText('Apple Pie')).toBeInTheDocument();
      expect(screen.getByText('Banana Bread')).toBeInTheDocument();
      expect(screen.getByText('Secret Recipe')).toBeInTheDocument();
    });
  });

  describe('Empty state', () => {
    it('shows "No settings match" for a non-empty query with no hits', async () => {
      setViewportWidth(DESKTOP);
      const user = userEvent.setup();
      renderHub();

      await user.type(screen.getByRole('textbox', { name: 'Search settings' }), 'zzz-no-match');

      expect(screen.getByText('No settings match “zzz-no-match”.')).toBeInTheDocument();
    });

    it('does NOT show the search-miss copy when the registry yields nothing with an EMPTY query', () => {
      // Zero visible sections with an empty query is a PERMISSION problem, not
      // a search miss — the component must not blame the user's typing for it.
      setViewportWidth(DESKTOP);
      setPermissions([]);
      renderHub(ALL_GATED_SECTIONS);

      expect(screen.queryByText('Gated Card')).not.toBeInTheDocument();
      expect(screen.queryByText(/No settings match/)).not.toBeInTheDocument();
    });
  });

  describe('Permission gating', () => {
    it.each([
      ['compact', PHONE],
      ['wide', DESKTOP],
    ])('never renders a card whose permission the user lacks, at %s width', (_label, width) => {
      setViewportWidth(width);
      setPermissions([]); // lacks fixture:secret
      renderHub();

      expect(screen.queryByText('Secret Recipe')).not.toBeInTheDocument();
      expect(screen.queryByText('Vault')).not.toBeInTheDocument();
      // A card with no permission requirement is unaffected.
      expect(screen.getByText('Apple Pie')).toBeInTheDocument();
    });
  });

  describe('Disabled / pathless cards', () => {
    it('renders a Coming soon chip, is not a tab stop, and does not navigate on click, in the card grid', async () => {
      setViewportWidth(DESKTOP);
      const user = userEvent.setup();
      renderHub();

      expect(screen.getByText('Coming soon')).toBeInTheDocument();

      const card = screen.getByText('Toaster Oven').closest('.MuiCard-root') as HTMLElement;
      // No CardActionArea at all for an inert card — not merely a disabled one.
      expect(within(card).queryByRole('button')).not.toBeInTheDocument();

      await user.click(card);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('renders a Coming soon chip, is not a tab stop, and does not navigate on click, in the drill-down list', () => {
      setViewportWidth(PHONE);
      renderHub();

      expect(screen.getByText('Coming soon')).toBeInTheDocument();

      const row = screen.getByRole('button', { name: /Toaster Oven/ });
      expect(row).toHaveAttribute('aria-disabled', 'true');
      expect(row).toHaveAttribute('tabindex', '-1');
      // Chevron is replaced by the chip — only the leading icon remains.
      expect(row.querySelectorAll('svg')).toHaveLength(1);

      // `userEvent.click` refuses outright here — MUI's disabled styling sets
      // `pointer-events: none`, so a real pointer can never reach this row at
      // all. `fireEvent` bypasses that to prove the JS handler is ALSO
      // guarded, not just the CSS.
      fireEvent.click(row);
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });
});

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
    render(<SettingsHubPage />);

    await user.click(screen.getByRole('heading', { level: 6, name: 'Email' }));

    expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/email');
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
    const { unmount } = render(<UserSettingsHubPage />);

    expect(screen.getByRole('heading', { level: 6, name: 'Notifications' })).toBeInTheDocument();
    expect(
      screen.getByText(/choose which events notify you, and whether they arrive by email or in your browser/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('heading', { level: 6, name: 'Notifications' }));
    expect(mockNavigate).toHaveBeenCalledWith('/settings/notifications');

    unmount();
    mockNavigate.mockClear();

    setViewportWidth(PHONE);
    render(<UserSettingsHubPage />);

    // Drill-down rows are plain text, not `h6` headings (see the phone test
    // below) - a row and a leading-icon + trailing-chevron pair is the whole
    // contract at this width.
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    const notificationsRow = screen.getByRole('button', { name: /Notifications/ });
    expect(notificationsRow.querySelectorAll('svg')).toHaveLength(2);

    await user.click(notificationsRow);
    expect(mockNavigate).toHaveBeenCalledWith('/settings/notifications');
  });

  it("navigates to a real card's route on click", async () => {
    setViewportWidth(DESKTOP);
    setPermissions(SETTINGS_OWNER);
    const user = userEvent.setup();
    render(<UserSettingsHubPage />);

    await user.click(screen.getByRole('heading', { level: 6, name: 'Appearance' }));

    expect(mockNavigate).toHaveBeenCalledWith('/settings/appearance');
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
