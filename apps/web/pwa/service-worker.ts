import type { VitePWAOptions } from 'vite-plugin-pwa';
import { buildManifest } from './manifest';

// =============================================================================
// vite-plugin-pwa options  (issue #218, epic #215)
// =============================================================================
//
// WHY THIS FILE LIVES OUTSIDE `src/`, AND WHY IT IS A FUNCTION
//
// The same two reasons `pwa/manifest.ts` gives, and this file follows that
// precedent deliberately rather than inventing a second arrangement. It is
// CONFIG-SIDE code — `vite.config.ts` imports it, the React tree never does —
// so it belongs under `tsconfig.node.json`'s `include` alongside the config it
// serves, not inside the application's `src`. And returning the options from a
// function rather than exporting a frozen object gives the test suite one
// thing to call, which is what makes the invariants below ASSERTABLE instead
// of merely commented. `src/__tests__/pwa/service-worker.test.ts` is the
// counterpart to `manifest.test.ts`.
//
// Note this module names `src/sw.ts` as a string (`srcDir` + `filename`) and
// never imports it. It must not: `sw.ts` is compiled against
// `tsconfig.worker.json` with no DOM lib, and it executes `clientsClaim()` at
// import time.
//
// -----------------------------------------------------------------------------
// WHY `injectManifest` AND NOT `generateSW`
// -----------------------------------------------------------------------------
//
// `generateSW` writes the whole service worker from this config, so there is no
// file in which to put a `push`, `notificationclick` or `pushsubscriptionchange`
// handler — and on Android Chrome those handlers, living in a service worker,
// are the ONLY way a notification can ever be shown (`new Notification()`
// throws there). A strategy that cannot host them cannot deliver epic #215 at
// all on that platform.
//
// Its escape hatch, `importScripts`, is worse than it looks: it splits
// ownership of one worker across two files — a generated one that owns the
// Workbox runtime config and a hand-written one that owns the push logic.
// Neither can see the other, so the routing rules drift away from the push
// handlers silently, and the first symptom of that drift is a notification that
// does not arrive, on a device the developer does not have.
//
// `injectManifest` keeps one worker in one reviewable file (`src/sw.ts`) and
// only substitutes the generated precache list into it. See that file's header
// for the two constraints it must never violate (never call the API, never
// cache anything under `/api`).
//
// -----------------------------------------------------------------------------
// THIS ALSO OWNS THE WEB MANIFEST
// -----------------------------------------------------------------------------
//
// `VitePWA({ manifest })` emits `manifest.webmanifest` into `dist/` AND serves
// it from the dev server with `Content-Type: application/manifest+json`, which
// is exactly the two jobs the hand-rolled `webManifest()` emitter in
// `vite.config.ts` did before #218 — so that plugin was deleted and its work
// handed here. `buildManifest()` itself is untouched from #217: the manifest is
// still DERIVED from `@app/shared`, so a renamed fork still gets a correctly
// labelled installed app.
//
// One behavioural difference worth knowing: the plugin's dev middleware matches
// the request URL EXACTLY, where the removed emitter stripped a query string
// first. No browser appends one to a `<link rel="manifest">` href, so this has
// no practical effect — but a hand-typed `/manifest.webmanifest?foo` in dev
// will 404 where it used to work.
// =============================================================================

/**
 * Builds the `vite-plugin-pwa` options for the application build.
 *
 * `registerType: 'prompt'` means a new worker installs and then WAITS rather
 * than activating under a user mid-session — whose already-loaded page would
 * otherwise start requesting asset filenames the new revision has rotated away.
 * The handover is a `SKIP_WAITING` message the page posts once the user agrees;
 * `src/sw.ts` already listens for it.
 *
 * `injectRegister: null` because THE REACT TREE NOW OWNS REGISTRATION (issue
 * #219). `src/components/pwa/UpdatePrompt.tsx` calls `useRegisterSW` from
 * `virtual:pwa-register/react`, which registers the worker and exposes its
 * `needRefresh` state to the UI that acts on it. The previous
 * `injectRegister: 'auto'` was the placeholder that issue replaced: it injected
 * a plain `registerSW.js` into `index.html`, which registered the worker but
 * had no way to tell anyone an update was waiting — so under `prompt` the
 * update sat there unnoticed until every tab of the origin closed.
 *
 * It must stay `null` rather than reverting to `'auto'`: with both, the worker
 * is registered twice — once from a script tag the React tree cannot observe —
 * and the hook's state no longer describes the registration the user is
 * actually on.
 */
export function buildServiceWorkerOptions(): Partial<VitePWAOptions> {
  return {
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.ts',
    registerType: 'prompt',
    // Registration lives in `src/components/pwa/UpdatePrompt.tsx` — see above.
    injectRegister: null,
    manifest: buildManifest(),
    injectManifest: {
      // The app shell, and only the app shell.
      //
      // Every pattern here is matched against `dist/`, which is built entirely
      // from `apps/web` and contains nothing whatsoever from the API — that is
      // a separate service that nginx merely mounts at the same origin. So no
      // pattern can reach an authenticated response even by accident, which is
      // the property `src/sw.ts`'s security note relies on. Keep it that way:
      // adding `json` here would be harmless today and a data leak the moment
      // anything under `/api` were ever served from this directory.
      //
      // `woff2` is deliberate rather than incidental: `src/theme/index.ts`
      // names Inter first, so an offline shell without the font renders in the
      // Arial/DejaVu fallback — visibly a different application, which is a
      // poor advertisement for the feature. `png`/`svg`/`ico` cover the icons
      // `index.html` and the manifest reference. (The manifest itself is added
      // to the precache by the plugin, so it needs no pattern.)
      globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
    },
    devOptions: {
      // Exercise the worker against `npm run dev`. Without this, the only way
      // to discover whether `sw.ts` even parses is a production build, and
      // DevTools' Application panel — the one practical way to inspect
      // precache contents, scope and the update handshake — has nothing to show
      // against the server anyone actually develops on.
      enabled: true,
      // `module`, not `classic`: in dev the worker is served as untranspiled
      // ESM with its `workbox-*` imports intact, which a classic worker cannot
      // load. The production build bundles it, so this is a dev-only concern.
      type: 'module',
      // In dev the injection point becomes `[{ url: 'index.html' }]` rather
      // than a real precache list. Without this line it becomes `[]`, and
      // `createHandlerBoundToURL('/index.html')` in `sw.ts` throws
      // `non-precached-url` on activation — so the worker dies in dev only, for
      // a reason that looks nothing like the config line that caused it.
      navigateFallback: 'index.html',
    },
  };
}
