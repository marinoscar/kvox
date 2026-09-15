import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { BottomNav } from '../../../components/navigation/BottomNav';

/**
 * The phone half of the coverage migrated from the deleted `Sidebar.test.tsx`:
 * four items, permission gating, active highlight, navigate-on-click.
 *
 * ⚠ THE FOUR ITEMS ARE DIFFERENT ITEMS SINCE #106. They were Home · Library ·
 * Settings · Console; they are Home · Transcripts · Notes · Settings. Console
 * is `pinned` — a mode, not a peer destination — and the bar draws
 * `BOTTOM_BAR_DESTINATIONS`, which excludes pinned rows entirely. The suites
 * below therefore assert its ABSENCE under every permission set, because "the
 * admin sees four tabs" alone would still pass with Console present and Notes
 * missing.
 */

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePermissions } from '../../../hooks/usePermissions';

const mockUsePermissions = vi.mocked(usePermissions);

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

// The seeded `admin` role's navigation-relevant permissions. `transcripts:read`
// is in the set since #30 and `notes:read` since #57 — both are seeded to ALL
// THREE roles, so an admin fixture without them would be a user that cannot
// exist, and every assertion below about the bar's four-action ceiling would
// silently be testing two. The two admin permissions stay in the set even
// though #106 took Console off this bar: they are what a real admin holds, and
// the "never shows Console" suite needs them present to prove the absence is
// not just a missing grant.
const ADMIN_PERMISSIONS = [
  'users:read',
  'system_settings:read',
  'transcripts:read',
  'notes:read',
];
const PHONE = 375;

/** Renders at a phone width, which is the only width this bar exists at. */
function renderPhone(route = '/') {
  const result = render(<BottomNav />, {
    wrapperOptions: { route, user: mockAdminUser },
  });
  act(() => setViewportWidth(PHONE));
  return result;
}

describe('BottomNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(ADMIN_PERMISSIONS, true);
    setViewportWidth(PHONE);
  });

  describe('Self-gating', () => {
    it('renders nothing at or above sm, even though Layout also unmounts it there', () => {
      // Belt and braces: `Layout` mounts it only below `sm`, and it refuses to
      // render above `sm` anyway. Either gate alone would be enough; both
      // together mean a future caller cannot mount it into the rail's band.
      render(<BottomNav />, { wrapperOptions: { user: mockAdminUser } });

      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    });

    it('renders below sm', () => {
      renderPhone();

      expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
    });

    it('appears and disappears across the sm boundary', async () => {
      renderPhone();
      expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();

      await act(async () => setViewportWidth(600));
      expect(screen.queryByRole('button', { name: 'Home' })).not.toBeInTheDocument();

      await act(async () => setViewportWidth(599));
      expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    });
  });

  describe('Destinations', () => {
    it('renders exactly Home, Transcripts, Notes and User Settings for an admin (#106)', () => {
      // FOUR, and these four. The bar's ceiling is four labelled tabs at 360px
      // and #106 reaches it BY DESIGN: `BOTTOM_BAR_DESTINATIONS` is every
      // NON-PINNED destination, and there are exactly four.
      //
      // ⚠ CONSOLE IS ASSERTED ABSENT IN THE SAME TEST, not in a separate one.
      // The failure this guards is a swap, not a count: restore Console to the
      // bar and drop Notes and the bar still has four buttons, still shows
      // labels, and still passes any assertion phrased as "four actions".
      renderPhone();

      expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Transcripts' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'User Settings' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Console' })).not.toBeInTheDocument();
    });

    it('renders the four tabs in declaration order (#106)', () => {
      // Declaration order IS navigation order, and the order is the design:
      // the two things the product produces sit between Home and Settings.
      // `getAllByRole` returns document order, which for a flex row is visual
      // order.
      renderPhone();

      expect(
        screen.getAllByRole('button').map((tab) => tab.getAttribute('aria-label')),
      ).toEqual(['Home', 'Transcripts', 'Notes', 'User Settings']);
    });

    it('shows Transcripts to a user holding transcripts:read and nothing else', () => {
      // The seeded Viewer. `transcripts:read` is granted to every role, so
      // this is the ordinary user of this application rather than an edge case.
      setPermissions(['transcripts:read'], false);
      renderPhone();

      expect(screen.getByRole('button', { name: 'Transcripts' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Notes' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Console' })).not.toBeInTheDocument();
    });

    it('shows Notes and NOT Transcripts to a notes:read-only user (#106)', () => {
      // The row that used to be `library` was reachable on EITHER permission,
      // so this user got one tab that fronted both subtrees. Two destinations
      // gated on one permission each means the bar now shows exactly the half
      // they can read — and, crucially, does NOT show the half they cannot,
      // which under the old model was the tab they would be bounced off.
      setPermissions(['notes:read'], false);
      renderPhone();

      expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Transcripts' })).not.toBeInTheDocument();
    });

    it('shows the compact label as visible text but the full label as the accessible name', () => {
      // A 4-up bar at 375px gives each tab ~90px, which "User Settings" does
      // not fit into — so it keeps the full phrase as its ACCESSIBLE name and
      // shows the short one, and nothing is lost to a screen reader.
      //
      // `transcripts` and `notes` are the cases where the two fields agree
      // (#106), asserted here rather than left implicit: the split is still
      // real for `settings`, and "Transcripts" is the longest caption the bar
      // draws — it fits only because the theme pins the SELECTED label back to
      // 0.75rem (`theme/components.ts`).
      renderPhone();

      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'User Settings' })).toBeInTheDocument();
      expect(screen.getByText('Transcripts')).toBeInTheDocument();
      expect(screen.getByText('Notes')).toBeInTheDocument();
    });

    it('never renders more than four actions — showLabels depends on it', () => {
      renderPhone();

      expect(screen.getAllByRole('button')).toHaveLength(4);
      expect(screen.getAllByRole('button').length).toBeLessThanOrEqual(4);
    });

    it('hides destinations the user lacks permission for', () => {
      setPermissions([]);
      renderPhone();

      // Home and User Settings only: Transcripts and Notes are each gated, and
      // Console is not on this bar at any permission level.
      expect(screen.getAllByRole('button')).toHaveLength(2);
      expect(screen.queryByRole('button', { name: 'Transcripts' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Notes' })).not.toBeInTheDocument();
    });

    it('NEVER shows Console, whatever permissions are held (#106)', () => {
      // Every permission set that used to produce a Console tab, asserted in
      // one place. `console` is `pinned`, and the bar filters pinned rows out
      // BEFORE the permission gate runs — so no grant can put it back. It is
      // reachable below `sm` through the avatar UserMenu instead, which
      // `UserMenu.test.tsx` covers.
      for (const granted of [
        ['system_settings:read'],
        ['users:read'],
        ['system_settings:read', 'users:read'],
        ADMIN_PERMISSIONS,
      ]) {
        setPermissions(granted, true);
        const view = renderPhone();

        expect(
          screen.queryByRole('button', { name: 'Console' }),
          `Console appeared for ${granted.join(', ')}`,
        ).not.toBeInTheDocument();

        view.unmount();
      }
    });
  });

  describe('Active state', () => {
    it('selects the destination that owns the route', () => {
      renderPhone('/settings');

      expect(screen.getByRole('button', { name: 'User Settings' })).toHaveClass('Mui-selected');
      expect(screen.getByRole('button', { name: 'Home' })).not.toHaveClass('Mui-selected');
    });

    it('resolves a child route to its parent destination', () => {
      renderPhone('/transcripts/abc-123/history');

      expect(screen.getByRole('button', { name: 'Transcripts' })).toHaveClass('Mui-selected');
      expect(screen.getByRole('button', { name: 'Notes' })).not.toHaveClass('Mui-selected');
    });

    it('lights the two content tabs INDEPENDENTLY (#106)', () => {
      // Under the merged `library` row both subtrees lit the same tab, which is
      // exactly what #106 undid. Both directions are asserted, because a
      // leftover shared prefix would light one tab on both routes and look like
      // a highlight bug rather than a model bug.
      const transcripts = renderPhone('/transcripts');
      expect(screen.getByRole('button', { name: 'Transcripts' })).toHaveClass('Mui-selected');
      expect(screen.getByRole('button', { name: 'Notes' })).not.toHaveClass('Mui-selected');
      transcripts.unmount();

      renderPhone('/notes/abc-123');
      expect(screen.getByRole('button', { name: 'Notes' })).toHaveClass('Mui-selected');
      expect(screen.getByRole('button', { name: 'Transcripts' })).not.toHaveClass(
        'Mui-selected',
      );
    });

    it('selects NOTHING on an admin route — Console is not on this bar (#106)', () => {
      // `console` still OWNS `/admin` in the destination model, so
      // `resolveActiveDestination` answers `console` here. The bar must render
      // that as "nothing selected" rather than as a phantom highlight, which is
      // the same path the existing "a destination the user cannot see" case
      // takes — `false`, never `null`.
      renderPhone('/admin/settings/users');

      for (const action of screen.getAllByRole('button')) {
        expect(action).not.toHaveClass('Mui-selected');
      }
    });

    it('selects NOTHING on a route no destination owns', () => {
      // `false`, not `null`, is what BottomNavigation wants for "nothing
      // selected" — and an unowned route is exactly where that must show.
      renderPhone('/settingsfoo');

      for (const action of screen.getAllByRole('button')) {
        expect(action).not.toHaveClass('Mui-selected');
      }
    });

    it('selects nothing when the active destination is one the user cannot see', () => {
      setPermissions([]);
      renderPhone('/admin/settings');

      for (const action of screen.getAllByRole('button')) {
        expect(action).not.toHaveClass('Mui-selected');
      }
    });
  });

  describe('Navigation', () => {
    it('navigates to the destination path on tap', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      await user.click(screen.getByRole('button', { name: 'User Settings' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'User Settings' })).toHaveClass('Mui-selected');
      });
    });

    it('reaches every destination on the bar', async () => {
      const user = userEvent.setup();
      renderPhone('/');

      for (const name of ['User Settings', 'Transcripts', 'Notes', 'Home']) {
        await user.click(screen.getByRole('button', { name }));
        await waitFor(() => {
          expect(screen.getByRole('button', { name })).toHaveClass('Mui-selected');
        });
      }
    });
  });
});
