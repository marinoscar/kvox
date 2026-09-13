import { defineConfig, type Plugin, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { APP_NAME, THEME_COLOR } from '@app/shared';
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
  optimizeDeps: { include: ['@app/shared'] },
  server: {
    port: 5173,
    host: true,
    // The dev VPS proxies appbase.dev.marin.cr to this server; without this
    // entry Vite 5+'s Host header check rejects the request and every page
    // load is blocked.
    allowedHosts: ['appbase.dev.marin.cr', 'localhost', '.localhost'],
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
