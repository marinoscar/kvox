import SettingsIcon from '@mui/icons-material/Settings';
import type {
  ShellDestination,
  ShellNavigation,
  ShellSettingsSurface,
} from '@marinoscar/platform-web/shell/headless';

import type { KvoxDestination } from '../core/ui/index.js';
import {
  kvoxAskDestinationRoutes,
  kvoxAskDestinations,
} from '../ask/ui/index.js';
import {
  kvoxGraphDestinationRoutes,
  kvoxGraphDestinations,
  kvoxReviewDestinationRoutes,
  kvoxReviewDestinations,
} from '../graph/ui/index.js';
import {
  kvoxNoteTemplatesDestinationRoutes,
  kvoxNoteTemplatesDestinations,
  kvoxNotesDestinationRoutes,
  kvoxNotesDestinations,
} from '../notes/ui/index.js';
import {
  kvoxTranscriptsDestinationRoutes,
  kvoxTranscriptsDestinations,
} from '../transcripts/ui/index.js';

/**
 * The destinations a KVox slice contributes, by the name {@link
 * CreateKvoxNavigationOptions.include} takes.
 *
 * @stability experimental
 */
export type KvoxNavigationSlice =
  | 'transcripts'
  | 'notes'
  | 'graph'
  | 'ask'
  | 'review'
  | 'templates';

/**
 * The destination keys the slices contribute: `graph` contributes the
 * `knowledge` row.
 *
 * @stability experimental
 */
export type KvoxSliceDestinationKey =
  | 'transcripts'
  | 'notes'
  | 'knowledge'
  | 'ask'
  | 'review'
  | 'templates';

/**
 * Options of {@link createKvoxNavigation}.
 *
 * @typeParam K - the keys of the host's own (`extra`) destinations.
 *
 * @stability experimental
 */
export interface CreateKvoxNavigationOptions<K extends string = never> {
  /**
   * The slice destinations to list. The order of this array is not significant:
   * rows always come as Transcripts, Notes, Knowledge, Review, Ask, Templates.
   * Default `['transcripts', 'notes', 'graph']`, the rows KVox web
   * draws; Desktop asks for `['notes', 'graph', 'review', 'ask', 'templates']`.
   *
   * @remarks
   * `'graph'` is the Knowledge row (gated on `graph:read` and the `graph`
   * feature). `'review'` and `'ask'` are rows of their own and carry the same
   * gates; when `'ask'` is listed, `/ask` stops belonging to Knowledge so exactly
   * one row lights up. `'templates'` is the note-template manager.
   */
  include?: readonly KvoxNavigationSlice[];
  /**
   * The host's own destinations (web: Home, Settings, Console; Desktop: none).
   * Unpinned ones come BEFORE the slice rows (Home leads), pinned ones AFTER them
   * (the rail's foot), each group in the order given.
   */
  extra?: readonly ShellDestination<K>[];
  /**
   * The route prefixes the `extra` destinations own, when they own more than their
   * `path` (the Console navigates to `/admin/settings` and owns `/admin`). An
   * `extra` destination without an entry owns its own `path`.
   */
  extraRoutes?: Readonly<Partial<Record<K, readonly string[]>>>;
  /**
   * Where the pinned Settings destination goes. When set, and `extra` has no
   * destination keyed `settings`, a pinned "Settings" row is added after the slice
   * rows and before the pinned `extra` ones. Also the hub path of the drill-down
   * surface built from `settingsSections`.
   */
  settingsPath?: string;
  /** The label of that Settings row and of the hub. Default `'Settings'`. */
  settingsLabel?: string;
  /**
   * The registry of the settings hub at `settingsPath`, for the compact app bar's
   * drill-down (back arrow plus the card's title below `sm`).
   */
  settingsSections?: ShellSettingsSurface['sections'];
  /**
   * Full control of the drill-down surfaces, for a host with more than one hub
   * (web: the admin and the user hub). Wins over `settingsSections`.
   */
  settingsSurfaces?: readonly ShellSettingsSurface[];
  /** The rail's Console mode (web only). */
  console?: ShellNavigation['console'];
  /** Where the brand and the drill-down's top level lead. Default `'/'`. */
  homePath?: string;
  /** The desktop rail's collapse preference hook; a module-level reference. */
  useRailPreference?: ShellNavigation['useRailPreference'];
}

/**
 * What {@link createKvoxNavigation} returns.
 *
 * @typeParam K - the keys of the host's own destinations.
 *
 * @stability experimental
 */
export interface KvoxNavigation<K extends string = never> {
  /** For the rail, the avatar menu and the app bar's drill-down. */
  navigation: ShellNavigation<K | KvoxSliceDestinationKey | 'settings'>;
  /**
   * For the phone bar: {@link navigation} without the pinned destinations (see
   * {@link withoutPinned}). {@link KvoxAppShell} derives the same value itself, so
   * a host that mounts the shell passes only `navigation`.
   */
  bottomBarNavigation: ShellNavigation<K | KvoxSliceDestinationKey | 'settings'>;
}

/**
 * A slice's destinations as the platform's. They are structurally the same type
 * except for `feature`: a slice names the `graph` feature as a plain string, while
 * the platform types it as the union the HOST declares by augmenting
 * `SettingsFeatureRegistry` and registering a resolver (`registerSettingsFeature`).
 * With no `graph` registration the platform fails closed and hides the row.
 */
function asShell(destinations: readonly KvoxDestination<string, string>[]): ShellDestination<string>[] {
  return destinations as unknown as ShellDestination<string>[];
}

const DEFAULT_INCLUDE: readonly KvoxNavigationSlice[] = ['transcripts', 'notes', 'graph'];

const bottomBarCache = new WeakMap<object, ShellNavigation>();

/**
 * The navigation the phone bottom bar draws: the given one with the pinned
 * destinations (the modes: Settings, Console) taken out.
 *
 * @remarks
 * KVox's rule since #106: a pinned destination is a mode and never a peer on the
 * phone bar. The platform's bar draws pinned destinations too (at the end), so the
 * filter is data, not a breakpoint: `ShellBottomNav` keeps its own `down('sm')`
 * self-gate and there are still exactly five gates. The result is cached per input,
 * so the same navigation always yields the same object (the shell keys on identity).
 *
 * @param navigation - the host's navigation.
 * @returns the same navigation with only its non-pinned destinations.
 *
 * @stability experimental
 */
export function withoutPinned<N extends ShellNavigation<string>>(navigation: N): N {
  const cached = bottomBarCache.get(navigation);
  if (cached) return cached as N;
  const filtered = {
    ...navigation,
    destinations: navigation.destinations.filter((destination) => !destination.pinned),
  } as N;
  bottomBarCache.set(navigation, filtered);
  return filtered;
}

/**
 * Composes the KVox navigation: the host's own destinations plus the ones the
 * KVox slices declare, with the route ownership that makes the right row light up.
 *
 * @remarks
 * The slice rows are the slices' own data (`kvoxNotesDestinations` and friends), so
 * their labels, icons, paths and gates (`permission`, `feature: 'graph'`) live in
 * the slices; this only orders them. A row with `feature: 'graph'` is hidden by the
 * shell unless the host's `graph` settings feature (`registerSettingsFeature`) says
 * on: no host-side `if`. Declare the result ONCE at module scope: the shell keys on
 * its identity.
 *
 * @param options - see {@link CreateKvoxNavigationOptions}.
 * @returns the navigation and its phone-bar twin.
 *
 * @example
 * ```ts
 * // Desktop, a local single-user host.
 * export const { navigation } = createKvoxNavigation({
 *   include: ['notes', 'graph', 'review', 'ask', 'templates'],
 *   settingsPath: '/settings',
 *   settingsSections: DESKTOP_SETTINGS_SECTIONS,
 * });
 * ```
 *
 * @stability experimental
 */
export function createKvoxNavigation<K extends string = never>(
  options: CreateKvoxNavigationOptions<K> = {},
): KvoxNavigation<K> {
  const include = new Set(options.include ?? DEFAULT_INCLUDE);
  const extra = options.extra ?? [];

  const slices: ShellDestination<string>[] = [];
  const routes: Record<string, readonly string[]> = {};
  if (include.has('transcripts')) {
    slices.push(...asShell(kvoxTranscriptsDestinations));
    Object.assign(routes, kvoxTranscriptsDestinationRoutes);
  }
  if (include.has('notes')) {
    slices.push(...asShell(kvoxNotesDestinations));
    Object.assign(routes, kvoxNotesDestinationRoutes);
  }
  if (include.has('graph')) {
    slices.push(...asShell(kvoxGraphDestinations));
    Object.assign(routes, kvoxGraphDestinationRoutes);
  }
  if (include.has('review')) {
    slices.push(...asShell(kvoxReviewDestinations));
    Object.assign(routes, kvoxReviewDestinationRoutes);
  }
  if (include.has('ask')) {
    slices.push(...asShell(kvoxAskDestinations));
    Object.assign(routes, kvoxAskDestinationRoutes);
    // `/ask` belongs to the Ask row now: one row lights up, never two.
    if (routes.knowledge) {
      routes.knowledge = routes.knowledge.filter((prefix) => prefix !== '/ask');
    }
  }
  if (include.has('templates')) {
    slices.push(...asShell(kvoxNoteTemplatesDestinations));
    Object.assign(routes, kvoxNoteTemplatesDestinationRoutes);
  }

  const settingsRow: ShellDestination<string>[] =
    options.settingsPath !== undefined && !extra.some((destination) => destination.key === 'settings')
      ? [
          {
            key: 'settings',
            label: options.settingsLabel ?? 'Settings',
            compactLabel: options.settingsLabel ?? 'Settings',
            Icon: SettingsIcon,
            path: options.settingsPath,
            pinned: true,
          },
        ]
      : [];

  const destinations: ShellDestination<string>[] = [
    ...extra.filter((destination) => !destination.pinned),
    ...slices,
    ...settingsRow,
    ...extra.filter((destination) => destination.pinned),
  ];

  // The settings row owns its hub; the extras own what they say, or their own path.
  const destinationRoutes: Record<string, readonly string[]> = { ...routes };
  for (const row of settingsRow) destinationRoutes[row.key] = [row.path];
  for (const destination of extra) {
    destinationRoutes[destination.key] =
      (options.extraRoutes as Record<string, readonly string[]> | undefined)?.[destination.key] ?? [
        destination.path,
      ];
  }

  const settingsSurfaces: readonly ShellSettingsSurface[] | undefined =
    options.settingsSurfaces ??
    (options.settingsSections && options.settingsPath !== undefined
      ? [
          {
            sections: options.settingsSections,
            hubPath: options.settingsPath,
            hubTitle: options.settingsLabel ?? 'Settings',
          },
        ]
      : undefined);

  const navigation: ShellNavigation<string> = {
    destinations,
    destinationRoutes,
    ...(settingsSurfaces ? { settingsSurfaces } : {}),
    ...(options.console ? { console: options.console } : {}),
    ...(options.homePath !== undefined ? { homePath: options.homePath } : {}),
    ...(options.useRailPreference ? { useRailPreference: options.useRailPreference } : {}),
  };

  type Keys = K | KvoxSliceDestinationKey | 'settings';
  return {
    navigation: navigation as ShellNavigation<Keys>,
    bottomBarNavigation: withoutPinned(navigation) as ShellNavigation<Keys>,
  };
}
