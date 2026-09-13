# `@app/shared`

Constants that more than one app needs: the application's display name, and the
two brand colours the web app manifest and the MUI theme both have to agree on.

## Rebranding a fork

Edit **three lines** in [`index.js`](./index.js):

```js
exports.APP_NAME = 'Your Product Name';
exports.THEME_COLOR = '#7c3aed';
exports.BACKGROUND_COLOR = '#ffffff';
```

Then rebuild. For everything rendered at runtime that is the whole change —
every surface below derives from these constants rather than restating them, so
nothing else needs editing and nothing can be missed.

Three caveats, all real:

1. **Regenerate the visual baselines.** The app name is rendered into the
   pixel baselines under `tests/visual/specs/**/*-snapshots/`, and that suite
   runs at `maxDiffPixels: 4` — effectively zero tolerance. Baselines are only
   ever regenerated inside the pinned container (see
   `tests/visual/playwright.config.ts` for why a local browser is not
   acceptable):

   ```bash
   docker run --rm -it -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.62.1-noble \
     npx playwright test --config=tests/visual/playwright.config.ts --update-snapshots
   ```

   Seven of the eleven baselines are `fullPage` shots that include the AppBar
   wordmark; the rail-scoped and drill-down ones are unaffected.

2. **`THEME_COLOR` does not reach the icons on its own.** The files under
   `apps/web/public/icons/` are committed PIXELS, so editing the constant
   restyles the application and leaves every icon on the old colour. Re-run the
   generator — see [Brand icons](#brand-icons) below.

   This now reaches further than the installed-app icon. Since epic #215,
   `icon-192.png` and `badge-96.png` are also the icon and badge shown on
   every OS-level notification — hardcoded as literal paths (`PUSH_ICON` /
   `PUSH_BADGE` in `apps/web/src/sw.ts`, and the matching literals in
   `apps/web/src/services/browserNotifications.ts`'s `showAppNotification`),
   not read from the manifest's `icons` array at notification time. Skipping
   the regeneration step after a rebrand therefore leaves the *old* brand
   mark on every push notification and every Android/desktop OS toast, not
   just on the Home Screen icon — a more visible miss than it looks, since a
   notification is the one surface a user sees without the app open at all.

3. **The name is not the only identity string.** These are deliberately
   separate and are *not* derived from `APP_NAME`:
   - `CLI_NAME` (`appctl`) in `apps/cli/src/branding.ts` — the executable name,
     which also seeds the config directory and the env-var prefix. It has its
     own rationale documented in that file; a product called "Acme" may well
     still ship a binary called `appctl`.
   - The GitHub repository URLs in `apps/api/src/openapi/document.ts` and
     `description.ts` — those point at the actual repository, not the product.
   - Prose in `README.md`, `docs/`, and `scripts/dev.ps1`, which describes this
     template itself. Epic #161 scoped those out on purpose.

## Consumers

Keep this list current when you add one.

| Consumer | File | Renders as |
|---|---|---|
| Web wordmark (AppBar) | `apps/web/src/components/navigation/AppBar.tsx` | `APP_NAME` |
| Web page title + meta description | `apps/web/index.html` via the `%APP_NAME%` plugin in `apps/web/vite.config.ts` | `APP_NAME` |
| OpenAPI document title + contact name | `apps/api/src/openapi/document.ts` | `${APP_NAME} API` |
| OpenAPI description prose | `apps/api/src/openapi/description.ts` | `APP_NAME` |
| API reference page heading | `apps/api/src/openapi/docs-page.ts` | `${APP_NAME} API` |
| API reference page `<title>` | `apps/api/src/openapi/register-docs-routes.ts` | `${APP_NAME} API Reference` |
| Email wordmark, footer, and subject lines | `apps/api/src/email/templates/layout.ts` (re-exported to the five templates) | `APP_NAME` |
| CLI banner, `--help`, device name | `apps/cli/src/branding.ts` (`CLI_DISPLAY_NAME`) | `${APP_NAME} CLI` |
| Web theme, `palette.primary.main` (light) | `apps/web/src/theme/light.ts` | `THEME_COLOR` |
| Brand icons and favicon — generated pixels, not read at runtime | `apps/web/public/icons/*.png`, `apps/web/public/favicon.ico` via `apps/web/scripts/generate-icons.py` | `THEME_COLOR`, `BACKGROUND_COLOR` |
| Web app manifest (`name`, `short_name`, `description`, `theme_color`, `background_color`) | `apps/web/pwa/manifest.ts` | `APP_NAME`, `THEME_COLOR`, `BACKGROUND_COLOR` |

`background_color` above is `BACKGROUND_COLOR`'s only runtime consumer (issue
#217, epic #215) — it is read directly at build time, so unlike the icon
pixels below it needs no regeneration step: editing the constant and
rebuilding is the whole change for this one field.

## Brand icons

Everything under `apps/web/public/icons/`, plus `public/favicon.svg` and
`public/favicon.ico`. Issue #216 added them so that a notification can set an
`icon` and a `badge`, a manifest has something to point at, and iOS can install
the app to the Home Screen.

| File | Size | What reads it |
|---|---|---|
| `icons/source.svg` | vector | Nobody at runtime — the human-editable master |
| `icons/icon-192.png` | 192 | Manifest, `purpose: any`; also hardcoded as the `icon` on every push and service-worker notification (`sw.ts`, `browserNotifications.ts`) |
| `icons/icon-512.png` | 512 | Manifest, `purpose: any` |
| `icons/icon-maskable-192.png` | 192 | Manifest, `purpose: maskable` |
| `icons/icon-maskable-512.png` | 512 | Manifest, `purpose: maskable` |
| `icons/badge-96.png` | 96 | Android notification badge, `purpose: monochrome`; also hardcoded as the `badge` on every push and service-worker notification (`sw.ts`, `browserNotifications.ts`) |
| `icons/apple-touch-icon-180.png` | 180 | iOS Home Screen |
| `favicon.svg` | vector | Browser tab, modern browsers |
| `favicon.ico` | 16/32/48 | Browser tab, taskbar, Windows shortcut — fallback |

The three that are easy to get wrong, and are already correct here: the
maskable pair is full-bleed with its content inside the 80% safe circle
(launchers crop to their own shape), `badge-96.png` is a **transparent** canvas
with a white mark because Android uses only its alpha channel, and the iOS icon
has **no alpha channel at all** because iOS composites transparency to black.

### Regenerating them

```bash
python3 apps/web/scripts/generate-icons.py
```

Requires Python 3 and Pillow (`pip install --user 'Pillow>=10'`) and nothing
else. That dependency is deliberately **not** in any `package.json` and nothing
in `npm run build` calls the script: a fork must be able to rebrand without an
image toolchain in CI, which is why the PNGs are committed and regeneration is
a manual step. Run it after changing `THEME_COLOR`, and commit the result.

The script rewrites every raster from scratch and is idempotent. It does not
touch the two SVGs.

### Replacing the placeholder mark

`icons/source.svg` — three white bars on a rounded brand-coloured square — is
the human-editable source. Edit it in any vector editor to design a real logo.

The catch, stated plainly because it is the one thing about these files that
surprises people: **the generator does not rasterise that SVG.** Rendering an
SVG needs rsvg, cairosvg or a headless browser, i.e. exactly the toolchain
this template refuses to require, so `generate-icons.py` redraws the same
geometry in Pillow from the constants at its top. The vector and the raster
describe the mark twice and must be kept in step by hand — or, once you have a
real logo, replaced by exporting the PNGs from your design tool at the sizes in
the table above, keeping each file's alpha rules intact.

## If you consume this from a Vite app

Add the package to `optimizeDeps.include` in that app's Vite config:

```ts
optimizeDeps: { include: ['@app/shared'] },
```

This is **not** optional and it is not a performance tweak. The package is
CommonJS and arrives as an npm workspace symlink; Vite treats a linked package
as project source rather than as a dependency, so it skips dep pre-bundling and
serves `exports.APP_NAME = ...` to the browser as raw ESM. Every importer then
fails with `does not provide an export named 'APP_NAME'` and the page renders
blank.

The trap is what stays green while that is broken: `tsc --noEmit`, the whole
Vitest suite, and `vite build` all pass, because Rollup's commonjs plugin and
Vitest's interop each handle the file unaided. **Only the dev server breaks.**
`apps/web/vite.config.ts` and `apps/web/visual/vite.config.ts` both carry the
line for this reason — see #164.

## Why this package looks the way it does

It ships committed JavaScript and a hand-written `.d.ts`, with **no build
step**, and it is **CommonJS**. Neither is an accident — `apps/api`'s
`rootDir`, its Jest transform rules, `apps/cli`'s real-ESM runtime, and the
fact that CI never compiles a fourth workspace all constrain the choice. The
full reasoning is in the header comment of [`index.js`](./index.js); read it
before changing the packaging.

## Adding another constant

Export it from `index.js`, declare it in `index.d.ts`, and add a row to the
table above. Anything Node-only, Nest-only, or DOM-only does **not** belong
here — all three apps import this package, and one of them has no DOM while
another has no Node.
