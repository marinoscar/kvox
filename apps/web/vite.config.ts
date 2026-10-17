import { defineConfig, type Plugin, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { APP_NAME, APP_SLUG, THEME_COLOR } from '@app/shared';
import { appVersionDefine } from './app-version.js';
import { buildServiceWorkerOptions } from './pwa/service-worker';

/**
 * Substitutes `%APP_NAME%` and `%THEME_COLOR%` in `index.html` with the
 * matching constants from `@app/shared` (issue #164, epic #161; the colour
 * token added by issue #217, epic #215).
 *
 * `index.html` is static markup: it carries the <title>, the description meta
 * and the `theme-color` meta, and it cannot import TypeScript, so it is the
 * one user-visible surface that could not simply reference the shared
 * constants. The two obvious ways to bridge that gap are both worse than a
 * four-line plugin:
 *
 *   - An env var (`VITE_APP_NAME`), which Vite would interpolate into `%...%`
 *     for free. Rejected: it makes the deployment environment a SECOND source
 *     of truth for the name. `@app/shared` exists precisely so a fork renames
 *     the product in one line; a build that also has to set an env var can
 *     silently disagree with the wordmark the React tree renders.
 *   - Setting `document.title` at runtime from `main.tsx`. Rejected: the
 *     document parses and paints with whatever the literal HTML said before
 *     any script runs, so the user gets a visible flash of the placeholder in
 *     the browser tab.
 *
 * A build-time transform has neither problem: one source of truth, resolved
 * before the HTML is ever served, so nothing at runtime is involved at all.
 * It applies in dev too (`transformIndexHtml` runs on every served request),
 * so the placeholder is never observable anywhere.
 *
 * `%THEME_COLOR%` is here for the same single-source-of-truth reason and one
 * additional one: a hardcoded hex in the <meta> would be a THIRD copy of the
 * brand colour, and the two copies that already derive it — the MUI palette's
 * `primary.main` and the manifest's `theme_color` below — are the surfaces a
 * user sees it next to. A mismatch shows up as browser chrome painted in the
 * old brand colour directly above the app painted in the new one.
 *
 * `order: 'pre'` so this runs ahead of Vite's own built-in `%ENV_VAR%` HTML
 * replacement, which would otherwise be looking at the same tokens.
 */
function appName(): Plugin {
  return {
    name: 'app-name-html',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html.replaceAll('%APP_NAME%', APP_NAME).replaceAll('%THEME_COLOR%', THEME_COLOR),
    },
  };
}

/**
 * The service worker and the web app manifest (issue #218, epic #215).
 *
 * The options live in `pwa/service-worker.ts`, next to `pwa/manifest.ts` and
 * for the same two reasons that file gives: they are config-side code the
 * React tree must never import, and a function is something the test suite can
 * call. Read that file for why this build uses `injectManifest` rather than
 * `generateSW` (short version: `generateSW` has nowhere to put the `push` and
 * `notificationclick` handlers that are the ONLY way to show a notification on
 * Android Chrome), and why `injectRegister: 'auto'` is a placeholder that
 * issue #219 removes.
 *
 * This replaced the hand-rolled `webManifest()` emitter #217 shipped as
 * scaffolding — `VitePWA({ manifest })` both emits `manifest.webmanifest` into
 * `dist/` and serves it in dev, which were that plugin's only two jobs.
 */
function pwa(): PluginOption {
  return VitePWA(buildServiceWorkerOptions());
}

export default defineConfig({
  plugins: [react(), appName(), pwa()],
  // `apps/web/package.json`'s version, baked in at build time (issue #296).
  // See `build/app-version.ts` for why this is a define rather than an API
  // call, and why `vitest.config.ts` has to spread the same thing.
  define: appVersionDefine(),
  // `@app/shared` is CommonJS, and it reaches us as an npm WORKSPACE SYMLINK.
  // Vite treats a linked package as project source rather than as a dependency,
  // so it skips dep pre-bundling for it and serves `index.js` to the browser as
  // raw ESM — where `exports.APP_NAME = ...` provides no named export and the
  // module throws "does not provide an export named 'APP_NAME'", taking the
  // whole app down with a blank page.
  //
  // Listing it here forces the pre-bundle that an unlinked CommonJS dependency
  // would have got automatically, which is what converts it to ESM.
  //
  // This only bites in DEV. The production build (Rollup's commonjs plugin) and
  // the Vitest suites (their own CJS interop) both handle the same file without
  // help, which is precisely why the failure surfaces in the dev-server-backed
  // visual harness and nowhere else. See `visual/vite.config.ts`, which needs
  // the same line for the same reason.
  //
  // The `@app/shared/ontology` subpath (issue #350) is the same package and
  // the same trap: compiled CommonJS (`exports.ONTOLOGY_VERSION = ...`) behind
  // the workspace symlink. Pre-bundling is per ENTRY, not per package, so the
  // subpath needs its own line — listing `@app/shared` alone does not cover it.
  //
  // `@marinoscar/kvox-contract` (issue #488) is linked from the workspace, so
  // Vite would not pre-bundle it on its own (a linked package is treated as
  // source), and `@app/shared/ontology` is now a CommonJS re-export of its
  // `./ontology` subpath. Listing the package and that subpath makes the
  // optimizer build both entries together, so the ontology is one instance.
  // Each entry is listed because pre-bundling is per entry, not per package.
  //
  // `@marinoscar/kvox-web` (issue #499, epic #498) is deliberately NOT listed. It
  // is a linked workspace package like the two above, but it is pure ESM
  // (`"type": "module"`, built by `tsc` to ESM), so the dev server can serve its
  // `dist/` as it is, which keeps ONE instance of the host context across the
  // `core/*` and `transcription/*` entries. Pre-bundling it entry by entry would
  // be the failure to avoid: if the optimizer ever gave `core/headless` and
  // `transcription/ui` separate copies of the core, the provider and the hooks
  // would hold different React contexts and every slice would throw
  // `KvoxHostMissingError`. If a dev-server import of the package ever fails,
  // list ALL its entries here together (one optimizer run shares the chunks)
  // rather than aliasing its source paths.
  optimizeDeps: {
    include: [
      '@app/shared',
      '@app/shared/ontology',
      '@marinoscar/kvox-contract',
      '@marinoscar/kvox-contract/ontology',
    ],
  },
  server: {
    port: 5173,
    host: true,
    // The dev VPS proxies `<app-slug>.dev.marin.cr` to this server; without
    // this entry Vite 5+'s Host header check rejects the request and every
    // page load is blocked.
    //
    // DERIVED FROM `APP_SLUG`, NOT WRITTEN OUT. The host is named after the
    // product, so spelling it literally here is exactly the regression
    // `apps/cli/src/template-identity.test.ts` exists to catch: a fork that
    // renames would keep proxying to a hostname this file no longer allows,
    // and the only symptom would be a blank dev page behind a Host-header
    // rejection. The domain suffix is infrastructure, not identity, so it
    // stays a literal.
    allowedHosts: [`${APP_SLUG}.dev.marin.cr`, 'localhost', '.localhost'],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
