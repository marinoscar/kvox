import { APP_NAME, THEME_COLOR, BACKGROUND_COLOR } from '@app/shared';

// =============================================================================
// The web app manifest  (issue #217, epic #215)
// =============================================================================
//
// WHY THIS FILE LIVES OUTSIDE `src/`
//
// It is CONFIG-SIDE code. `vite.config.ts` imports it; the React tree never
// does, and never should. `apps/web/tsconfig.json` scopes the application to
// `include: ["src"]`, so keeping the module here is what keeps it out of the
// app's compilation — and, more to the point, keeps `@app/shared` being read
// at BUILD time rather than shipped to a browser to be read at runtime. It is
// covered by `tsconfig.node.json` instead, alongside `vite.config.ts`, which
// is the tsconfig that already owns the build-tooling half of this package.
//
// WHY A FUNCTION RATHER THAN A CONST OBJECT
//
// So the emitter has one thing to call and issue #218 has one thing to hand to
// `VitePWA({ manifest })`. The shape below is the durable part of this change;
// the plugin that currently writes it to disk is not.
//
// WHAT MATTERS HERE AND IS NOT COSMETIC
//
//   - `display: 'standalone'` is the field iOS/iPadOS 16.4+ reads to decide
//     whether the site may be added to the Home Screen at all — and Safari
//     grants the Notifications API ONLY to a web app that has been. Without
//     this line the whole of epic #215 is unreachable on every iPhone and
//     iPad, which is a platform-wide capability gap rather than a styling nit.
//   - `id` is what the platform uses to decide whether a later visit is the
//     SAME installed app. Pinning it to `'/'` explicitly means `start_url` can
//     later change without the OS treating the result as a second, unrelated
//     installation of the same product.
//   - `start_url`'s `?source=pwa` is how an installed launch is told apart
//     from a browser-tab visit in analytics; it is inside `scope`, so it does
//     not affect navigation.
// =============================================================================

/** A single entry in the manifest's `icons` array. */
export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: 'any' | 'maskable' | 'monochrome';
}

/** The web app manifest, as it is serialised into `manifest.webmanifest`. */
export interface WebAppManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  orientation: 'any';
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

/**
 * Builds the web app manifest from `@app/shared`.
 *
 * Every branded value — the name, the OS chrome colour, the splash ground — is
 * read from that package rather than restated here, for exactly the reason
 * `vite.config.ts`'s `appName()` plugin gives: a fork renames the product in
 * one line, and a manifest holding its own copy of the name would quietly
 * disagree with the wordmark the running app renders.
 *
 * The icon paths point at files committed under `apps/web/public/icons/`
 * (issue #216), which Vite copies into `dist/` verbatim, so the `src` values
 * are correct in dev and in the production image without any rewriting.
 * `src/__tests__/pwa/manifest.test.ts` asserts each one still exists on disk —
 * a rename over in #216 would otherwise break installability silently.
 */
export function buildManifest(): WebAppManifest {
  return {
    id: '/',
    name: APP_NAME,
    short_name: APP_NAME,
    description: `${APP_NAME} — sign in to manage your account and settings.`,
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      { src: '/icons/badge-96.png', sizes: '96x96', type: 'image/png', purpose: 'monochrome' },
    ],
  };
}
