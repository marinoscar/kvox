# brand

The KVox look, once: the MUI theme, the colour tokens, the brand mark and the Inter font, for every host of `@marinoscar/kvox-web`.

## Purpose and scope

`apps/web` and KVox Desktop paint the same UI by consuming this slice instead of copying it (ADR-0001, packages first). It owns the colour tokens of both modes, their translation into MUI palettes, the component overrides (sentence-case buttons, the bordered shadowless dark card, the divider-driven AppBar, chips, the data-table and dialog rules), the two assembled themes, the identity values of `packages/shared/identity.json`, the inline-SVG `BrandMark` and `BrandLockup`, and the brand files (SVG, PNG, ICO, the Inter font). It owns no shell, navigation or route: that is the host's, or `@marinoscar/platform-web/shell`.

Status: filled (issue #628). Of all `kvox-web` slices it alone imports the platform, exactly `@marinoscar/platform-web/shell/headless` for `createShellTheme` (rule `host-neutral`, `HOST_NEUTRAL_SLICE_ALLOWED`), so `@marinoscar/platform-web` is a peer of this entry and of no other.

## Entry point

`@marinoscar/kvox-web/brand`: `createKvoxTheme`, `kvoxLightTheme`, `kvoxDarkTheme`, `kvoxTokens`, `kvoxLightPalette`, `kvoxDarkPalette`, `kvoxComponentOverrides`, `KVOX_BRAND`, `BrandMark`, `BrandLockup` and their types (`KvoxTokens`, `KvoxPaletteTokens`, `KvoxBrand`, `BrandMarkProps`, `BrandLockupProps`).

Files, as package exports (built into `dist/brand/assets` and `dist/brand/fonts`): `brand/assets/mark.svg`, `favicon.svg`, `favicon.ico`, `icon-192.png`, `icon-512.png`, `icon-1024.png`, `icon-maskable-192.png`, `icon-maskable-512.png`, `badge-96.png`, `apple-touch-icon-180.png`; `brand/fonts/inter.css` and `Inter-latin-variable.woff2`.

## Peer dependencies

`@mui/material`, `@marinoscar/platform-web` and `react` (with `react-dom`), the last required, the others optional peers of the package. No router, no icon package.

## Configuration

None at runtime. Build time: `packages/kvox-contract/src/brand/identity.generated.ts` is written from `packages/shared/identity.json` by `scripts/sync-brand-identity.mjs` (`npm run brand:sync`, checked by `brand:check`).

## Extension-point catalog

- `createKvoxTheme(mode, extend?)`: the host's own MUI options, merged over the KVox theme with `createTheme(theme, extend)`.
- `BrandMark` `sx` and `size`; `BrandLockup` `size` and `showName`.

Nothing is registered: the entry has no registry and no `@extensionPoint` symbol.
