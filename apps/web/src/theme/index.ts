/**
 * This app's two MUI themes (issue #484, epic #478): the packaged shell's base
 * (`createShellTheme`: Inter, 600-weight headings, an 8px radius) with this app's
 * palette and component overrides on top.
 *
 * `palette` is this app's token-driven palette (`light.ts` / `dark.ts`, read from
 * `tokens.ts`, whose light `primary.main` is `THEME_COLOR` from `@app/shared`, the
 * rebrand codemod's contract). It is merged one level deep over the shell's, so
 * every hand-picked tint here wins and nothing of the shell's default palette
 * survives. `extend` swaps the shell's three component overrides for this app's
 * full set (`components.ts`: the tonal dark surfaces, the divider-driven AppBar
 * border, the data-table and dialog rules), so the app paints exactly as it did
 * before the shell moved into the package.
 *
 * The viewer's choice (`light | dark | system`) is held by the shell's
 * `ShellRoot` in `App.tsx`, under the same `localStorage` key this app has always
 * used (`theme_mode`), so nobody's saved choice resets.
 */

import { createShellTheme } from '@marinoscar/platform-web/shell/headless';
import type { ShellThemeOptions } from '@marinoscar/platform-web/shell/headless';
import { componentOverrides } from './components';
import { darkPalette } from './dark';
import { lightPalette } from './light';

/** The theme the shell hands `extend`: the package's own `Theme` type. */
type ShellTheme = Parameters<NonNullable<ShellThemeOptions['extend']>>[0];

function withAppComponents(mode: 'light' | 'dark'): (theme: ShellTheme) => ShellTheme {
  // Cast: the overrides are typed against this app's `Theme`; the package types its
  // own copy of the same interface. The values are plain MUI style rules.
  return (theme) => ({ ...theme, components: componentOverrides(mode) as ShellTheme['components'] });
}

export const lightTheme = createShellTheme('light', {
  palette: lightPalette,
  extend: withAppComponents('light'),
});

export const darkTheme = createShellTheme('dark', {
  palette: darkPalette,
  extend: withAppComponents('dark'),
});
