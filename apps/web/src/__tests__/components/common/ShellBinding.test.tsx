import { describe, it, expect, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import {
  ShellBottomNav,
  ShellNavigationRail,
  ShellUserMenu,
} from '@marinoscar/platform-web/shell/ui';
import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { server } from '../../mocks/server';
import { mockGraphAiConfig } from '../../mocks/graphData';
import { AppGraphFeatureProvider } from '../../../platform/GraphFeatureBinding';
import { BOTTOM_BAR_DESTINATIONS, DESTINATIONS } from '../../../config/destinations';
import { KVOX_BOTTOM_BAR_NAVIGATION, KVOX_NAVIGATION } from '../../../config/shell';
import { ADMIN_SECTIONS } from '../../../config/adminSections';
import { USER_SETTINGS_SECTIONS } from '../../../config/userSettingsSections';
// A side-effect import: registers the `graph` settings feature the destinations gate on.
import '../../../config/settingsFeatures';

/**
 * This app's binding of the packaged shell (issue #484, epic #478), against the
 * REAL package components: the phone bar, the rail and the avatar menu draw
 * `config/shell.ts`'s navigation, and the `knowledge` destination follows the
 * connected-knowledge switch through `platform/GraphFeatureBinding.tsx`.
 *
 * The package proves the chrome itself; these cases pin what only this app
 * decides:
 *
 *   - the phone bar is Home · Transcripts · Notes · Knowledge with connected
 *     knowledge on, Home · Transcripts · Notes with it off, and NEVER carries
 *     Settings, Console or a "More" tab (the package would draw all six and
 *     overflow, which is why the bar is bound to `KVOX_BOTTOM_BAR_NAVIGATION`);
 *   - `knowledge` stays hidden while the switch is unknown: loading, failed and
 *     signed-out all read "off", so the row never shows and then vanishes;
 *   - the rail keeps Settings and Console pinned at its foot, and the Console
 *     mode turns on under `/admin`.
 */

const PHONE = 375;
const TABLET = 800;
const DESKTOP = 1400;

/** An administrator who also holds `graph:read`, which `knowledge` gates on. */
const admin = { ...mockAdminUser, permissions: [...mockAdminUser.permissions, 'graph:read'] };

const BAR_LABELS = (): string[] =>
  screen.getAllByRole('button').map((tab) => tab.getAttribute('aria-label') ?? '');

type Switch = 'on' | 'off' | 'loading' | 'failed';

function serveAiTasksConfig(state: Switch) {
  server.use(
    http.get('*/api/ai-tasks/config', async () => {
      if (state === 'loading') {
        await delay('infinite');
      }
      if (state === 'failed') {
        return HttpResponse.json({ error: { message: 'forbidden' } }, { status: 403 });
      }
      return HttpResponse.json({ data: mockGraphAiConfig({ graphEnabled: state === 'on' }) });
    }),
  );
}

describe('phone bottom bar (KVOX_BOTTOM_BAR_NAVIGATION)', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewportWidth(PHONE);
  });

  function renderBar(route = '/', navigation = KVOX_BOTTOM_BAR_NAVIGATION) {
    return render(
      <AppGraphFeatureProvider>
        <ShellBottomNav navigation={navigation} />
      </AppGraphFeatureProvider>,
      { wrapperOptions: { route, user: admin } },
    );
  }

  it('is Home, Transcripts, Notes and Knowledge with connected knowledge on, and nothing else', async () => {
    serveAiTasksConfig('on');
    renderBar();

    expect(await screen.findByRole('button', { name: 'Knowledge' })).toBeInTheDocument();
    expect(BAR_LABELS()).toEqual(['Home', 'Transcripts', 'Notes', 'Knowledge']);
    // A pinned destination is a MODE, never a peer on the bar, and no overflow tab either.
    expect(screen.queryByRole('button', { name: 'Console' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'User Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more/i })).not.toBeInTheDocument();
  });

  it('is Home, Transcripts and Notes with connected knowledge off', async () => {
    serveAiTasksConfig('off');
    renderBar();

    await waitFor(() => expect(BAR_LABELS()).toEqual(['Home', 'Transcripts', 'Notes']));
    // Give a late flip to `on` the chance to happen: it must not.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(BAR_LABELS()).toEqual(['Home', 'Transcripts', 'Notes']);
    expect(screen.queryByRole('button', { name: /more/i })).not.toBeInTheDocument();
  });

  it('hides Knowledge while the AI task config is still loading (hide rather than show-then-remove)', async () => {
    serveAiTasksConfig('loading');
    renderBar();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(BAR_LABELS()).toEqual(['Home', 'Transcripts', 'Notes']);
    expect(screen.queryByRole('button', { name: 'Knowledge' })).not.toBeInTheDocument();
  });

  it('hides Knowledge when the config cannot be read (a failed load is "off")', async () => {
    serveAiTasksConfig('failed');
    renderBar();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole('button', { name: 'Knowledge' })).not.toBeInTheDocument();
    expect(BAR_LABELS()).toEqual(['Home', 'Transcripts', 'Notes']);
  });

  it('also needs the permission: graph:read missing hides Knowledge even with the switch on', async () => {
    serveAiTasksConfig('on');
    render(
      <AppGraphFeatureProvider>
        <ShellBottomNav navigation={KVOX_BOTTOM_BAR_NAVIGATION} />
      </AppGraphFeatureProvider>,
      {
        wrapperOptions: {
          user: { ...mockUser, permissions: [...mockUser.permissions, 'transcripts:read', 'notes:read'] },
        },
      },
    );

    await waitFor(() => expect(BAR_LABELS()).toEqual(['Home', 'Transcripts', 'Notes']));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole('button', { name: 'Knowledge' })).not.toBeInTheDocument();
  });

  it('is exactly the non-pinned destinations, and never more than four', () => {
    expect(KVOX_BOTTOM_BAR_NAVIGATION.destinations).toBe(BOTTOM_BAR_DESTINATIONS);
    expect(KVOX_BOTTOM_BAR_NAVIGATION.destinations.map((d) => d.key)).toEqual([
      'home',
      'transcripts',
      'notes',
      'knowledge',
    ]);
    expect(KVOX_BOTTOM_BAR_NAVIGATION.destinations.some((d) => d.pinned)).toBe(false);
    expect(KVOX_BOTTOM_BAR_NAVIGATION.destinations.length).toBeLessThanOrEqual(4);
  });

  it('lights the owning tab on a child route', async () => {
    serveAiTasksConfig('on');
    renderBar('/transcripts/abc-123/history');

    const tab = await screen.findByRole('button', { name: 'Transcripts' });
    expect(tab).toHaveClass('Mui-selected');
    expect(screen.getByRole('button', { name: 'Notes' })).not.toHaveClass('Mui-selected');
  });

  it('lights no tab on a mode route (Settings is pinned, so it is not on the bar)', async () => {
    serveAiTasksConfig('on');
    renderBar('/settings/profile');

    await screen.findByRole('button', { name: 'Knowledge' });
    for (const tab of screen.getAllByRole('button')) {
      expect(tab).not.toHaveClass('Mui-selected');
    }
  });

  it('is what the unbound navigation would NOT give: the full table adds a "More" tab', async () => {
    // Documents the package behaviour step 4 of #484 exists to avoid. If a package
    // upgrade stops overflowing pinned destinations, this case (and the binding)
    // can be revisited.
    serveAiTasksConfig('on');
    renderBar('/', KVOX_NAVIGATION);

    await screen.findByRole('button', { name: /more/i });
    expect(BAR_LABELS().slice(0, 3)).toEqual(['Home', 'Transcripts', 'Notes']);
    expect(screen.queryByRole('button', { name: 'Knowledge' })).not.toBeInTheDocument();
  });
});

describe('rail (KVOX_NAVIGATION)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function renderRail(route: string, width: number) {
    setViewportWidth(width);
    serveAiTasksConfig('on');
    return render(
      <AppGraphFeatureProvider>
        <ShellNavigationRail navigation={KVOX_NAVIGATION} />
      </AppGraphFeatureProvider>,
      { wrapperOptions: { route, user: admin } },
    );
  }

  it.each([
    ['desktop', DESKTOP],
    ['tablet', TABLET],
  ])('shows the four destinations and Settings and Console pinned at its foot @ %s', async (_n, width) => {
    renderRail('/', width);

    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Knowledge' })).toBeVisible());

    expect(within(nav).getAllByRole('link').map((link) => link.getAttribute('aria-label'))).toEqual([
      'Home',
      'Transcripts',
      'Notes',
      'Knowledge',
      'User Settings',
      'Console',
    ]);
    // The foot is below a divider, separate from the destination list.
    const lists = within(nav).getAllByRole('list');
    expect(lists).toHaveLength(2);
    expect(within(lists[1]).getAllByRole('link').map((l) => l.getAttribute('aria-label'))).toEqual([
      'User Settings',
      'Console',
    ]);
  });

  it('marks the owning destination current, including for Console under /admin', async () => {
    renderRail('/admin/settings/users', DESKTOP);

    // Expanded, so Console mode is on: the rail lists the admin sections instead.
    const nav = await screen.findByRole('navigation', { name: 'Console navigation' });
    const current = within(nav).getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', '/admin/settings/users');
  });

  it('turns on Console mode under /admin: a way back plus the admin cards', async () => {
    renderRail('/admin/settings', DESKTOP);

    const nav = await screen.findByRole('navigation', { name: 'Console navigation' });
    expect(within(nav).getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/');
    // A card an administrator can see, straight from `ADMIN_SECTIONS`.
    const usersCard = ADMIN_SECTIONS.flatMap((s) => s.cards).find((c) => c.path === '/admin/settings/users');
    expect(usersCard).toBeDefined();
    expect(within(nav).getByRole('link', { name: usersCard!.title })).toHaveAttribute(
      'href',
      '/admin/settings/users',
    );
    // The library destinations are not listed in Console mode.
    expect(within(nav).queryByRole('link', { name: 'Transcripts' })).not.toBeInTheDocument();
  });

  it('does not turn Console mode on outside /admin', async () => {
    renderRail('/settings', DESKTOP);

    await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(screen.queryByRole('navigation', { name: 'Console navigation' })).not.toBeInTheDocument();
  });
});

describe('avatar menu (KVOX_NAVIGATION)', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewportWidth(PHONE);
  });

  it('lists every visible destination except Home, Settings and Console included', async () => {
    serveAiTasksConfig('on');
    const user = userEvent.setup();
    render(
      <AppGraphFeatureProvider>
        <ShellUserMenu navigation={KVOX_NAVIGATION} />
      </AppGraphFeatureProvider>,
      { wrapperOptions: { user: admin } },
    );

    await user.click(screen.getByRole('button'));
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Knowledge' })).toBeVisible());

    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Transcripts',
      'Notes',
      'Knowledge',
      'User Settings',
      'Console',
      'Logout',
    ]);
    expect(within(menu).queryByRole('menuitem', { name: 'Home' })).not.toBeInTheDocument();
  });
});

describe('navigation tables', () => {
  it('binds the admin and user settings registries to their hubs for the drill-down and Console', () => {
    expect(KVOX_NAVIGATION.settingsSurfaces).toEqual([
      expect.objectContaining({ sections: ADMIN_SECTIONS, hubPath: '/admin/settings' }),
      expect.objectContaining({ sections: USER_SETTINGS_SECTIONS, hubPath: '/settings' }),
    ]);
    expect(KVOX_NAVIGATION.console).toEqual(
      expect.objectContaining({ prefix: '/admin', sections: ADMIN_SECTIONS }),
    );
    expect(KVOX_NAVIGATION.homePath).toBe('/');
    expect(KVOX_NAVIGATION.destinations).toBe(DESTINATIONS);
  });

  it('keeps the default rail preference: the package hook over the `navigation` namespace', () => {
    // Overriding it would fork where the collapse choice is stored.
    expect(KVOX_NAVIGATION.useRailPreference).toBeUndefined();
  });
});
