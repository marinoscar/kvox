/**
 * This app's binding of the packaged shell's navigation (issue #484, epic #478).
 *
 * The shell (`@marinoscar/platform-web/shell`) draws the rail, the bottom bar,
 * the avatar menu and the AppBar's settings drill-down from ONE value, declared
 * once at module scope: `ShellNavigation`. This file builds it from the app's
 * own tables — `DESTINATIONS` and `DESTINATION_ROUTES` (`config/destinations.ts`)
 * and the two settings registries — and does nothing else. No component reads a
 * breakpoint here; the five coupled gates are the package's
 * (`docs/specs/settings-ui.md`, "Breakpoint gates").
 *
 * TWO NAVIGATIONS, ONE TABLE. The rail, the avatar menu and the drill-down read
 * {@link KVOX_NAVIGATION}. The phone bar reads {@link KVOX_BOTTOM_BAR_NAVIGATION},
 * the same value with `destinations` narrowed to the non-pinned ones, because the
 * package draws EVERY visible destination on the bar (pinned ones included) and
 * turns a fifth into a "More" tab, while this app's rule since #106 is that a
 * pinned destination is a mode and never a peer on the bar. That is a data filter,
 * not a breakpoint: `ShellBottomNav` keeps its own `down('sm')` self-gate, so
 * there are still exactly five gates. Both are declared here, at module scope,
 * because the shell keys on their identity.
 */

import type { ShellNavigation } from '@marinoscar/platform-web/shell/headless';
import { ADMIN_HUB_PATH, ADMIN_HUB_TITLE, ADMIN_SECTIONS } from './adminSections';
import {
  BOTTOM_BAR_DESTINATIONS,
  DESTINATIONS,
  DESTINATION_ROUTES,
} from './destinations';
import type { DestinationKey } from './destinations';
import {
  USER_HUB_PATH,
  USER_HUB_TITLE,
  USER_SETTINGS_SECTIONS,
} from './userSettingsSections';

/** The Console's route prefix: any path under it turns the expanded rail into Console mode. */
export const CONSOLE_PREFIX = '/admin';

/**
 * Everything the rail, the avatar menu and the AppBar need from this app.
 *
 * `homePath` is `/`, so the brand and the drill-down's top level lead Home and
 * the avatar menu drops the Home row (the brand already goes there). The rail's
 * collapse preference is the package default (`useShellRailPreference`, the
 * `navigation` user-settings namespace, the same one this app has always used).
 */
export const KVOX_NAVIGATION: ShellNavigation<DestinationKey> = {
  destinations: DESTINATIONS,
  destinationRoutes: DESTINATION_ROUTES,
  settingsSurfaces: [
    { sections: ADMIN_SECTIONS, hubPath: ADMIN_HUB_PATH, hubTitle: ADMIN_HUB_TITLE },
    { sections: USER_SETTINGS_SECTIONS, hubPath: USER_HUB_PATH, hubTitle: USER_HUB_TITLE },
  ],
  console: {
    prefix: CONSOLE_PREFIX,
    sections: ADMIN_SECTIONS,
    // This app's label since #94; the package default is "Back to library".
    back: { label: 'Back to Home', path: '/' },
  },
  homePath: '/',
};

/**
 * PLATFORM-ADOPTION-SHIM(upstream platform shell): the packaged bottom bar has no
 * way to leave pinned destinations off it, so the bar is handed a filtered copy.
 * Goes when `ShellBottomNav` honours `pinned` (or takes a destination filter);
 * then mount it with `KVOX_NAVIGATION` and delete this constant.
 *
 * The phone bar's navigation: {@link KVOX_NAVIGATION} without the pinned
 * destinations (Settings and Console), so the bar is Home · Transcripts · Notes
 * · Knowledge, Knowledge only while connected knowledge is on, and never carries
 * a "More" tab.
 */
export const KVOX_BOTTOM_BAR_NAVIGATION: ShellNavigation<DestinationKey> = {
  ...KVOX_NAVIGATION,
  destinations: BOTTOM_BAR_DESTINATIONS,
};
