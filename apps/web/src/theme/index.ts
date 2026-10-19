/**
 * This app's two MUI themes, which are the brand themes of
 * `@marinoscar/kvox-web/brand` (issue #628).
 *
 * The palette, the component overrides and the assembly on top of the packaged
 * shell's base (`createShellTheme`) moved into the package so every other host
 * (the desktop app) paints the same look; the only definition of the tokens is there. This file keeps the
 * names the app has always imported (`lightTheme`, `darkTheme`) so no call site
 * changes.
 *
 * The viewer's choice (`light | dark | system`) is held by the shell's
 * `ShellRoot` in `App.tsx`, under the `localStorage` key this app has always used
 * (`theme_mode`), so nobody's saved choice resets.
 */

export {
  kvoxDarkTheme as darkTheme,
  kvoxLightTheme as lightTheme,
} from '@marinoscar/kvox-web/brand';
