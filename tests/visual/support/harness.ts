import { expect, type Page } from '@playwright/test';

/**
 * Shared helper for building a URL into the visual harness
 * (`apps/web/visual/main.tsx`) from a spec.
 *
 * Every spec goes through this rather than hand-building `?route=&perms=`
 * strings, so the query-param contract only has one place to change if
 * `main.tsx`'s param names ever do.
 */
export interface HarnessOptions {
  /** Initial router entry, e.g. `/admin/settings`. Default `/`. */
  route?: string;
  /** Becomes `user.permissions`. Default: the harness's own broad admin set. */
  perms?: string[];
  /** Written to `localStorage.theme_mode` before mount. Default `dark`. */
  theme?: 'light' | 'dark';
  /** Becomes `user.roles`. Default `['admin']`. */
  roles?: string[];
}

/**
 * Build the path+query to pass to `page.goto()`. Relative, so it composes
 * with `use.baseURL` in `playwright.config.ts` exactly like a bare route
 * string would.
 */
export function harnessUrl(options: HarnessOptions = {}): string {
  const params = new URLSearchParams();
  if (options.route) params.set('route', options.route);
  if (options.perms) params.set('perms', options.perms.join(','));
  if (options.theme) params.set('theme', options.theme);
  if (options.roles) params.set('roles', options.roles.join(','));
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

/** `users:read`-only — used by the hub-permissions spec. */
export const USERS_READ_ONLY_PERMS = ['users:read'];

/**
 * Block until the application's Inter webfont has actually loaded, and assert
 * that it did — issue #111.
 *
 * WHY EVERY SPEC CALLS THIS BEFORE ITS SCREENSHOT
 * ---------------------------------------------------------------------------
 * The harness no longer ships its own font. It loads `/fonts/inter.css` —
 * the SAME stylesheet `apps/web/index.html` loads, served out of
 * `apps/web/public` (see `apps/web/visual/vite.config.ts`'s `publicDir`) — so
 * these baselines measure the app's real font-loading path rather than a
 * test-only imitation of it. That stylesheet uses `font-display: swap`,
 * because that is what the application should ship: text must never be
 * invisible while a font is in flight.
 *
 * `swap` is the right production behaviour and the wrong screenshot
 * behaviour. It means there is a real (if brief) window in which text is laid
 * out in the fallback face and then reflows when Inter arrives, and
 * `page.goto()`'s default `load` wait does NOT wait for webfonts. Nothing
 * would usually go wrong — the woff2 comes off a loopback dev server in
 * roughly no time, and `toHaveScreenshot()` re-shoots until two consecutive
 * frames agree — but "usually" is not a property a pixel baseline suite is
 * allowed to have. Awaiting the font explicitly removes the race outright
 * instead of relying on it losing.
 *
 * The `expect` below is not ceremony either. It is the assertion that keeps
 * #111 fixed: if the app's @font-face, the stylesheet <link>, the font file,
 * or the harness's `publicDir` wiring is ever broken, this fails immediately
 * with an obvious message — rather than every spec silently re-baselining
 * itself against the container's Liberation Sans fallback, which is precisely
 * the failure #111 describes and which produced a false-negative
 * (zero-pixel-diff) non-vacuity result for the #105 caption bug.
 */
export async function waitForInter(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // `document.fonts.ready` alone is NOT sufficient: it resolves once font
    // loading has settled, and a face nothing has requested yet counts as
    // settled. `load()` forces the request for the faces the theme actually
    // uses. One variable file covers the whole 100-900 range, so these all
    // resolve to the same FontFace — they are listed separately anyway so a
    // future switch to static cuts cannot quietly go unawaited.
    await Promise.all([
      document.fonts.load('400 1em Inter'), // body text
      document.fonts.load('500 1em Inter'), // buttons / medium UI
      document.fonts.load('600 1em Inter'), // h1-h6, per src/theme/index.ts
      document.fonts.load('700 1em Inter'), // bold
    ]);
    await document.fonts.ready;
  });

  // Assert against the FontFace SET, deliberately NOT `document.fonts.check()`.
  //
  // `check('16px Inter')` looks like the obvious assertion and is worthless
  // here: it answers "can this be rendered?", and a family with no @font-face
  // at all is treated as a system font that is trivially "available", so it
  // returns TRUE precisely in the broken case this guard exists to detect.
  // Verified, not assumed — deleting `apps/web/public/fonts/inter.css` and
  // re-running this suite left `check()` returning true while the screenshots
  // diffed by 11,589 pixels.
  //
  // The FontFace set cannot be fooled that way: an entry appears only because
  // a real @font-face rule was parsed, and `status` is 'loaded' only once the
  // woff2 has actually been fetched and decoded.
  const interFaces = await page.evaluate(() =>
    [...document.fonts]
      .filter((f) => f.family.replace(/['"]/g, '') === 'Inter')
      .map((f) => ({ status: f.status, weight: f.weight })),
  );

  expect(
    interFaces,
    "Exactly one Inter @font-face must be registered. Zero means the app's font " +
      'stylesheet (apps/web/public/fonts/inter.css) failed to load — check the <link> in ' +
      "apps/web/visual/index.html and `publicDir` in apps/web/visual/vite.config.ts. More " +
      'than one means a second copy of the declaration has crept back in, which is exactly ' +
      'what #111 removed.',
  ).toHaveLength(1);

  expect(interFaces[0].status, 'The Inter woff2 must be fetched and decoded before screenshotting (#111)').toBe(
    'loaded',
  );

  // The variable weight range must survive too: collapsed to a single weight,
  // the browser would synthesise 500/600/700 by smearing the 400 outlines,
  // shifting the very glyph metrics the #105 caption-truncation specs measure.
  expect(interFaces[0].weight, 'Inter must stay a 100-900 variable face (#111)').toBe('100 900');
}
