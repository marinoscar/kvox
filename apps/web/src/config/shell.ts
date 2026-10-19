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
 * ONE NAVIGATION. The rail, the avatar menu and the drill-down read
 * {@link KVOX_NAVIGATION}. The phone bar's twin (the same value without the pinned
 * destinations: this app's rule since #106 is that a pinned destination is a mode
 * and never a peer on the bar) is derived by `KvoxAppShell`
 * (`@marinoscar/kvox-web/shell`, issue #629), so this file builds no second value.
 * It is declared here, at module scope, because the shell keys on its identity.
 */

import type { ShellNavigation } from '@marinoscar/platform-web/shell/headless';
import { ADMIN_HUB_PATH, ADMIN_HUB_TITLE, ADMIN_SECTIONS } from './adminSections';
import { DESTINATIONS, DESTINATION_ROUTES } from './destinations';
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
