/**
 * `createKvoxNavigation` (issue #629): composition of the host's own destinations
 * with the slices', their order, route ownership, pinned handling and feature gating.
 */

import { describe, expect, it } from 'vitest';
import HomeIcon from '@mui/icons-material/Home';
import AdminIcon from '@mui/icons-material/AdminPanelSettings';
import {
  isDestinationVisible,
  resolveActiveDestination,
  shellDestinationRoutes,
} from '@marinoscar/platform-web/shell/headless';
import type { ShellDestination } from '@marinoscar/platform-web/shell/headless';

import {
  createKvoxNavigation,
  defaultKvoxLinks,
  withoutPinned,
} from '../../src/shell/index.js';

type HostKey = 'home' | 'console';

const HOME: ShellDestination<HostKey> = {
  key: 'home',
  label: 'Home',
  compactLabel: 'Home',
  Icon: HomeIcon,
  path: '/',
};
const CONSOLE: ShellDestination<HostKey> = {
  key: 'console',
  label: 'Console',
  compactLabel: 'Console',
  Icon: AdminIcon,
  path: '/admin/settings',
  anyPermission: ['system_settings:read', 'users:read'],
  pinned: true,
};

const keys = (destinations: readonly { key: string }[]) => destinations.map((d) => d.key);
const holding = (...permissions: string[]) => (permission: string) => permissions.includes(permission);

describe('createKvoxNavigation', () => {
  it('lists the packaged Home row first when asked, owning exactly the landing page', () => {
    const { navigation } = createKvoxNavigation({ include: ['home', 'transcripts', 'notes', 'graph'] });
    expect(keys(navigation.destinations)).toEqual(['home', 'transcripts', 'notes', 'knowledge']);
    expect(navigation.destinations[0]).toMatchObject({ label: 'Home', compactLabel: 'Home', path: '/' });
    expect(navigation.destinations[0]?.permission).toBeUndefined();
    expect(navigation.destinationRoutes?.home).toEqual(['/']);
  });

  it('does not list Home unless asked, so a host with its own Home row is unchanged', () => {
    const { navigation } = createKvoxNavigation({ include: ['notes'] });
    expect(keys(navigation.destinations)).toEqual(['notes']);
  });

  it('defaults to the rows KVox web draws: Transcripts, Notes, Knowledge', () => {
    const { navigation } = createKvoxNavigation();
    expect(keys(navigation.destinations)).toEqual(['transcripts', 'notes', 'knowledge']);
  });

  it('puts unpinned host rows first and pinned ones last, around the slice rows', () => {
    const { navigation } = createKvoxNavigation<HostKey>({
      extra: [CONSOLE, HOME],
      settingsPath: '/settings',
    });
    expect(keys(navigation.destinations)).toEqual([
      'home',
      'transcripts',
      'notes',
      'knowledge',
      'settings',
      'console',
    ]);
  });

  it('orders the rows Notes, Knowledge, Review, Ask, Templates whatever the include order', () => {
    const { navigation } = createKvoxNavigation({
      include: ['templates', 'ask', 'review', 'graph', 'notes'],
      settingsPath: '/settings',
    });
    expect(keys(navigation.destinations)).toEqual([
      'notes',
      'knowledge',
      'review',
      'ask',
      'templates',
      'settings',
    ]);
  });

  it('adds a pinned Settings row at settingsPath, unless the host declares its own', () => {
    const generated = createKvoxNavigation({ settingsPath: '/settings' }).navigation.destinations;
    expect(generated.at(-1)).toMatchObject({
      key: 'settings',
      label: 'Settings',
      path: '/settings',
      pinned: true,
    });

    const own: ShellDestination<'settings'> = {
      key: 'settings',
      label: 'User Settings',
      compactLabel: 'Settings',
      Icon: HomeIcon,
      path: '/settings',
      pinned: true,
    };
    const { navigation } = createKvoxNavigation<'settings'>({ extra: [own], settingsPath: '/settings' });
    expect(navigation.destinations.filter((d) => d.key === 'settings')).toEqual([own]);
  });

  it('carries the gates the slices declare: permission and the graph feature', () => {
    const { navigation } = createKvoxNavigation({
      include: ['transcripts', 'notes', 'graph', 'review', 'ask', 'templates'],
    });
    const byKey = Object.fromEntries(navigation.destinations.map((d) => [d.key, d]));
    expect(byKey.transcripts.permission).toBe('transcripts:read');
    expect(byKey.notes.permission).toBe('notes:read');
    for (const key of ['knowledge', 'review', 'ask']) {
      expect(byKey[key].permission).toBe('graph:read');
      expect(byKey[key].feature).toBe('graph');
    }
    // The template manager has no permission and no feature, like its route and hub card.
    expect(byKey.templates.permission).toBeUndefined();
    expect(byKey.templates.feature).toBeUndefined();
  });

  it('hides the graph-gated rows while the host feature is off, with no host-side if', () => {
    const { navigation } = createKvoxNavigation({
      include: ['notes', 'graph', 'review', 'ask', 'templates'],
    });
    const canDoAnything = holding('notes:read', 'graph:read');
    const visible = (graph: boolean) =>
      navigation.destinations
        .filter((d) => isDestinationVisible(d, canDoAnything, { graph } as never))
        .map((d) => d.key);
    expect(visible(true)).toEqual(['notes', 'knowledge', 'review', 'ask', 'templates']);
    expect(visible(false)).toEqual(['notes', 'templates']);
  });

  it('lights exactly one row on every path, including Review and Ask beside Knowledge', () => {
    const { navigation } = createKvoxNavigation({
      include: ['notes', 'graph', 'review', 'ask', 'templates'],
      settingsPath: '/settings',
    });
    const routes = shellDestinationRoutes(navigation);
    const owner = (path: string) => resolveActiveDestination(routes, path);
    expect(owner('/notes/abc/history')).toBe('notes');
    expect(owner('/graph')).toBe('knowledge');
    expect(owner('/graph/entities/e1')).toBe('knowledge');
    expect(owner('/graph/review')).toBe('review');
    expect(owner('/ask')).toBe('ask');
    expect(owner('/ask/c1')).toBe('ask');
    expect(owner('/settings/note-templates')).toBe('templates');
    expect(owner('/settings/ai')).toBe('settings');
    // Knowledge no longer claims /ask once Ask is a row of its own.
    expect(routes.knowledge).toEqual(['/graph']);
  });

  it('keeps /ask under Knowledge when Ask is not a row (KVox web)', () => {
    const { navigation } = createKvoxNavigation();
    const routes = shellDestinationRoutes(navigation);
    expect(resolveActiveDestination(routes, '/ask/c1')).toBe('knowledge');
  });

  it('gives host rows their own path as prefix unless extraRoutes says more', () => {
    const { navigation } = createKvoxNavigation<HostKey>({
      extra: [HOME, CONSOLE],
      extraRoutes: { console: ['/admin'] },
    });
    const routes = shellDestinationRoutes(navigation);
    expect(routes.home).toEqual(['/']);
    expect(routes.console).toEqual(['/admin']);
    expect(resolveActiveDestination(routes, '/admin/users')).toBe('console');
  });

  it('builds the drill-down surface from settingsSections, and passes the host extras through', () => {
    const useRailPreference = () => ({ railCollapsed: false, toggleRailCollapsed: () => undefined });
    const { navigation } = createKvoxNavigation({
      settingsPath: '/settings',
      settingsSections: [],
      homePath: '/home',
      useRailPreference,
    });
    expect(navigation.settingsSurfaces).toEqual([
      { sections: [], hubPath: '/settings', hubTitle: 'Settings' },
    ]);
    expect(navigation.homePath).toBe('/home');
    expect(navigation.useRailPreference).toBe(useRailPreference);
  });

  describe('the phone bar (a pinned destination is a mode, never a peer, #106)', () => {
    it('is the navigation without its pinned destinations', () => {
      const { navigation, bottomBarNavigation } = createKvoxNavigation<HostKey>({
        extra: [HOME, CONSOLE],
        settingsPath: '/settings',
      });
      expect(keys(bottomBarNavigation.destinations)).toEqual([
        'home',
        'transcripts',
        'notes',
        'knowledge',
      ]);
      expect(bottomBarNavigation.destinationRoutes).toBe(navigation.destinationRoutes);
      // The rail and the menu still have them.
      expect(keys(navigation.destinations)).toContain('console');
    });

    it('is the same object every time, because the shell keys on identity', () => {
      const { navigation, bottomBarNavigation } = createKvoxNavigation({ settingsPath: '/settings' });
      expect(withoutPinned(navigation)).toBe(bottomBarNavigation);
      expect(withoutPinned(navigation)).toBe(withoutPinned(navigation));
    });
  });
});

describe('defaultKvoxLinks', () => {
  it('serves the slices under their usual paths', () => {
    expect(defaultKvoxLinks.transcript('t1')).toBe('/transcripts/t1');
    expect(defaultKvoxLinks.note('n1')).toBe('/notes/n1');
    expect(defaultKvoxLinks.entity('e1')).toBe('/graph/entities/e1');
    expect(defaultKvoxLinks.conversation('c1')).toBe('/ask/c1');
  });
});
