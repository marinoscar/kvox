/**
 * The two KVox MUI themes (issue #628; assembled in the web app since #484,
 * epic #478): the packaged shell's base (`createShellTheme`: Inter, 600-weight
 * headings, an 8px radius) with the KVox palette and component overrides on top.
 *
 * `palette` is the token-driven palette (`light.ts` / `dark.ts`, read from
 * `tokens.ts`, whose light `primary.main` is `KVOX_BRAND.themeColor`, the
 * rebrand codemod's contract). It is merged one level deep over the shell's, so
 * every hand-picked tint here wins and nothing of the shell's default palette
 * survives. `extend` swaps the shell's three component overrides for the full
 * KVox set (`components.ts`: the tonal dark surfaces, the divider-driven AppBar
 * border, the data-table and dialog rules), so a host paints exactly as the web
 * app does.
 *
 * The viewer's choice (`light | dark | system`) is held by the shell's
 * `ShellRoot`, not here: this file builds the two themes and nothing else.
 */

import { createShellTheme } from '@marinoscar/platform-web/shell/headless';
import type { ShellThemeOptions } from '@marinoscar/platform-web/shell/headless';
import { createTheme } from '@mui/material/styles';
import type { Theme, ThemeOptions } from '@mui/material/styles';
import { componentOverrides } from './components.js';
import { darkPalette } from './dark.js';
import { lightPalette } from './light.js';

/** The theme the shell hands `extend`: the package's own `Theme` type. */
type ShellTheme = Parameters<NonNullable<ShellThemeOptions['extend']>>[0];

function withAppComponents(mode: 'light' | 'dark'): (theme: ShellTheme) => ShellTheme {
  // Cast: the overrides are typed against this package's `Theme`; the platform
  // package types its own copy of the same interface. The values are plain MUI
  // style rules.
  return (theme) => ({ ...theme, components: componentOverrides(mode) as ShellTheme['components'] });
}

/**
 * The KVox theme for `mode`: the shell base, the KVox palette and the KVox
 * component overrides.
 *
 * @param mode - `light` or `dark`.
 * @param extend - optional MUI theme options merged over the result with
 *   `createTheme(theme, extend)`, for a host's own tokens.
 * @returns a new MUI theme. Build it once per mode and keep it at module level.
 *
 * @example
 * ```tsx
 * const theme = createKvoxTheme('dark');
 * <ThemeProvider theme={theme}><BrandLockup /></ThemeProvider>
 * ```
 *
 * @stability experimental
 */
export function createKvoxTheme(mode: 'light' | 'dark', extend?: ThemeOptions): Theme {
  const base = createShellTheme(mode, {
    palette: mode === 'light' ? lightPalette : darkPalette,
    extend: withAppComponents(mode),
  });
  return extend ? createTheme(base, extend) : base;
}

/**
 * The KVox light theme, built once.
 *
 * @stability experimental
 */
export const kvoxLightTheme: Theme = createKvoxTheme('light');

/**
 * The KVox dark theme, built once.
 *
 * @stability experimental
 */
export const kvoxDarkTheme: Theme = createKvoxTheme('dark');
