import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vite config for the visual regression harness (issue #107) ONLY.
 *
 * Separate from `apps/web/vite.config.ts` on purpose: this dev server exists
 * solely so `tests/visual`'s Playwright project has something to point a
 * browser at, and it must never be reachable from — or confused with —
 * `apps/web`'s real dev/build config. `root: here` makes `apps/web/visual/`
 * its own document root (`index.html` lives right beside this file), so
 * nothing here touches `apps/web/index.html`, `apps/web/src/main.tsx`, or the
 * production build (`npm run build` in `apps/web` uses the OTHER config and
 * never imports anything under `visual/`).
 */
export default defineConfig({
  root: here,
  // Serve `apps/web/public` — the REAL application's static asset directory —
  // as this harness's public dir, overriding Vite's `<root>/public` default
  // (which would be `visual/public`, a directory that does not and must not
  // exist).
  //
  // This is what makes `/fonts/inter.css` and the `/fonts/Inter-latin-variable.woff2`
  // it references resolve here at exactly the same URLs the application serves
  // them at in dev and in `dist/` (issue #111). Before #111 the harness kept
  // its own copy of the font under `visual/assets/fonts/` and declared its own
  // @font-face inline in `index.html`; that made the pixel baselines a
  // measurement of the HARNESS's font loading rather than the app's, so the
  // app could have lost Inter entirely without a single spec noticing. Sharing
  // the app's public dir is what removes that blind spot — there is now
  // exactly one font file and one @font-face in the repository, and this suite
  // exercises them.
  //
  // Note this only widens what is SERVED, not what is bundled: this config is
  // never used by `npm run build` (that uses `apps/web/vite.config.ts`), so
  // nothing under `visual/` can reach the production output.
  publicDir: path.resolve(here, '..', 'public'),
  // DELIBERATELY NO `VitePWA` (issue #218), and this is not an oversight to be
  // tidied up later. `apps/web/vite.config.ts` registers a service worker with
  // `devOptions.enabled`, which would mean this harness's dev server installs
  // one too — and a service worker is precisely the wrong thing to have
  // underneath a pixel-diff suite. It caches and then SERVES the app shell, so
  // a screenshot could be taken against the previous run's assets rather than
  // the ones the spec just changed; and its activation races the first
  // navigation, so whether a given run is controlled by it at screenshot time
  // is a timing question. Either turns `maxDiffPixels: 4` into a coin flip.
  //
  // Nothing needs disabling to achieve this — the plugin lives only in the
  // OTHER config, and configs do not inherit. The note exists so that "the
  // harness is missing the PWA plugin" is never read as a bug.
  plugins: [react()],
  // Required for the same reason as in `apps/web/vite.config.ts`, and this is
  // the config where its absence actually shows: `@app/shared` is CommonJS
  // arriving as a workspace symlink, which Vite treats as source and therefore
  // does not pre-bundle, so the browser gets `exports.APP_NAME = ...` as raw
  // ESM and every component importing it dies with "does not provide an export
  // named 'APP_NAME'".
  //
  // The AppBar's wordmark reads that constant (issue #164), so without this
  // line the harness renders a blank page and all eleven pixel specs fail on a
  // missing element rather than on a diff — which is what makes the real cause
  // easy to misread as a baseline problem.
  optimizeDeps: { include: ['@app/shared'] },
  server: {
    port: 5183,
    strictPort: true,
    // Bind every interface, not just the IPv6 loopback Vite defaults to.
    // Playwright's `webServer.url` health check (and every spec's
    // `page.goto`) hits `127.0.0.1` (IPv4) — see `tests/visual/playwright.config.ts`
    // — which a default `localhost`-only bind does not always answer on.
    host: true,
    // Deliberately NO `/api` proxy. `apps/web/vite.config.ts` proxies `/api`
    // to `http://localhost:3000` for real dev use; nothing listens on that
    // port here, and proxying to a dead target is exactly the kind of thing
    // that hangs or slow-retries instead of failing fast. Every `/api` fetch
    // this harness's components make is expected to fail (or resolve
    // non-JSON) quickly against Vite's own dev server instead — see the long
    // comment in `main.tsx` for why that is safe and deterministic for every
    // component this harness screenshots.
  },
});
