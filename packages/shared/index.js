// =============================================================================
// Application identity — the one constant a fork renames  (issue #162, epic #161)
// =============================================================================
//
// This repository is a TEMPLATE. Somebody clones it, calls their product
// something else, and every user-visible string carrying the old name is now
// wrong. Before this package existed the name was written out independently in
// three places that could not see each other:
//
//   - `apps/api/src/email/templates/layout.ts`  (its own `APP_NAME`)
//   - `apps/cli/src/branding.ts`                (its own `CLI_DISPLAY_NAME`)
//   - `apps/web`                                (raw literals, no constant)
//
// ...and they had already drifted to three different strings. Renaming meant
// grepping three packages and hoping. Now it is ONE FIELD in `identity.json`
// beside this file -- or, better, `node scripts/rename.mjs`, which also carries
// the identity strings that cannot be read at runtime. See docs/RENAMING.md.
//
// -----------------------------------------------------------------------------
// WHY THIS PACKAGE IS PLAIN JAVASCRIPT WITH A HAND-WRITTEN .d.ts
// -----------------------------------------------------------------------------
//
// Because a build step here would have to satisfy three different build
// systems before anything could even typecheck, and every one of them would
// have to be taught about it:
//
//   - `apps/api` compiles with `tsc -p tsconfig.build.json` under
//     `rootDir: ./src`. Importing TypeScript SOURCE from outside that root
//     widens it, and tsc then emits `dist/src/main.js` — which no longer
//     matches `start:prod`'s `node dist/main`. The build stays green and the
//     container breaks.
//   - `apps/api`'s Jest config has no `moduleNameMapper` and the default
//     `transformIgnorePatterns` (`/node_modules/`). A workspace symlink
//     resolving to `.ts` would not be transformed, and every API suite would
//     die at import time.
//   - CI (`.github/workflows/ci.yml`) runs `npm ci` and goes straight to
//     typecheck. Nothing builds a fourth workspace first, so a package that
//     needed compiling would have to add a step to four separate jobs.
//
// Committed `.js` + `.d.ts` sidesteps all of it: there is nothing to build, so
// there is no build to order, no `prepare` script, no `dist/` for
// `.dockerignore` to swallow, and no CI change at all.
//
// -----------------------------------------------------------------------------
// WHY CommonJS SPECIFICALLY
// -----------------------------------------------------------------------------
//
// It is the one module format all three consumers resolve without special
// configuration:
//
//   - `apps/api` is NodeNext WITHOUT `"type": "module"`, i.e. CommonJS, and it
//     runs under ts-jest. Jest's module registry does not reliably support
//     `require()` of an ESM package, so an ESM-only package here would pass
//     `tsc` and fail every API test.
//   - `apps/cli` is real ESM. Node reads named exports out of a CommonJS
//     module via cjs-module-lexer, and `exports.APP_NAME = ...` below is
//     exactly the assignment form that lexer detects.
//   - `apps/web` is Vite, which pre-bundles a CommonJS dependency as a matter
//     of routine.
//
// =============================================================================

// -----------------------------------------------------------------------------
// WHY THE VALUES LIVE IN identity.json AND NOT IN THIS FILE
// -----------------------------------------------------------------------------
//
// Two reasons, both practical:
//
//   - `apps/web/scripts/generate-icons.py` is Python. It paints THEME_COLOR and
//     BACKGROUND_COLOR into committed PNGs and cannot parse JavaScript, so
//     before this manifest existed it carried its OWN copy of both hex values
//     with nothing keeping the two in sync. JSON is the one format every
//     consumer here can read.
//   - `scripts/rename.mjs` rewrites these values. This file is 200 lines of
//     dense prose with the values buried in the middle of it; a regex codemod
//     over it is a codemod that will one day eat a comment. `JSON.parse` ->
//     mutate -> `JSON.stringify` cannot.
//
// It sits INSIDE this package rather than at the repository root because all
// three Dockerfiles copy an enumerated list of root files plus `packages/shared`
// as a whole directory (`COPY packages/shared ./packages/shared/`). A root-level
// manifest would be absent from every image, and since the api and cli
// production stages are `COPY --from=deps /app ./`, the images would BUILD GREEN
// and die at container boot with `Cannot find module`. No CI job builds images
// and `smoke` boots from the workspace checkout, so nothing would catch it.
//
// =============================================================================

const identity = require('./identity.json');

/**
 * The application's display name.
 *
 * ▲ THIS IS A REBRAND POINT: `productName` in `identity.json`. There is no
 * second copy. Prefer `node scripts/rename.mjs --name "..."`, which changes it
 * together with the identity strings no runtime read can reach.
 *
 * Every user-visible surface derives from it rather than restating it — see
 * README.md in this folder for the current consumer list. Two of them append a
 * suffix (`${APP_NAME} API`, `${APP_NAME} CLI`) instead of holding a second
 * literal, so the suffix survives a rename and the name does not have to.
 *
 * ONE THING TO KNOW BEFORE YOU CHANGE IT: the app name is rendered into the
 * visual-regression baselines under `tests/visual/specs/**\/*-snapshots/`, and
 * that suite runs at `maxDiffPixels: 4`. Changing this string is a real pixel
 * change, so the baselines must be regenerated in the pinned container — see
 * this folder's README for the exact command.
 */
exports.APP_NAME = identity.productName;

/**
 * The brand's primary colour, as a CSS hex string.
 *
 * ▲ THIS IS A REBRAND POINT: `themeColor` in `identity.json`. It lives here
 * rather than in the MUI theme because
 * two kinds of consumer need it and only one of them can import a theme:
 *
 *   - `apps/web/src/theme/light.ts` reads it as `palette.primary.main`, so it
 *     is every button, link and focus ring in the running application.
 *   - The installed-app surfaces live OUTSIDE React and never execute theme
 *     code: the web app manifest's `theme_color` (the OS chrome drawn around an
 *     installed PWA) and the committed icon PNGs under
 *     `apps/web/public/icons/`.
 *
 * ONE THING TO KNOW BEFORE YOU CHANGE IT: the icons are generated PIXELS, not a
 * value read at runtime, so editing this line does not restyle them — they will
 * keep the old colour until you re-run
 * `python3 apps/web/scripts/generate-icons.py`. See this folder's README.
 *
 * Keep the value a 6-digit `#rrggbb` literal. A manifest's `theme_color` is
 * parsed by the platform rather than by a CSS engine, and the 3-digit shorthand
 * and `rgb()` forms are not reliably accepted there.
 */
exports.THEME_COLOR = identity.themeColor;

/**
 * The colour painted behind the application before it has rendered anything.
 *
 * ▲ THIS IS A REBRAND POINT: `backgroundColor` in `identity.json`. It is the
 * web app manifest's `background_color`:
 * the splash screen an installed PWA shows while it launches, and the ground
 * under the document during first paint.
 *
 * It is deliberately a SINGLE value and not theme-aware. The manifest is static
 * JSON that the platform reads before any JavaScript of ours runs, so there is
 * nothing at that moment that could ask which mode the user prefers. White is
 * the light theme's `background.paper` — the surface the first real paint lands
 * on — which makes the handover from splash to app invisible in the default
 * case rather than in neither.
 */
exports.BACKGROUND_COLOR = identity.backgroundColor;

/**
 * What `APP_SLUG` degrades to when `APP_NAME` slugifies to nothing (all
 * punctuation, all non-Latin script, empty).
 *
 * Deliberately generic and carrying no product name, and deliberately the same
 * literal `apps/api/src/jobs/job-temp.ts` falls back to — see `slugify` below.
 */
const NEUTRAL_SLUG = 'app';

/**
 * A display name to a filename- and identifier-safe slug
 * (`'Some Name'` -> `'some-name'`).
 *
 * This rule is a COPY, byte for byte, of the one in
 * `apps/api/src/jobs/job-temp.ts` and `apps/api/src/db-backup/db-backup-storage.ts`.
 * Those two are NOT refactored to import `APP_SLUG` from here, and that is
 * deliberate: each carries a long in-file argument that deriving the prefix
 * from the app name is the point, because two applications built from this
 * template on one host must get different temp-file and backup-key prefixes
 * automatically. Collapsing them onto this export is a safe follow-up, but it
 * touches a janitor sweep pattern and a live object-storage key prefix, so it
 * does not belong in the same change as a rename tool.
 */
function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug.length > 0 ? slug : NEUTRAL_SLUG;
}

/**
 * `APP_NAME` reduced to a lowercase hyphenated token: `'Some Name'` -> `'some-name'`.
 *
 * For the places that need the name in a context where spaces and capitals are
 * wrong — today that is the OpenTelemetry service name (`${APP_SLUG}-api`),
 * which lands in every span and every log line.
 *
 * NOT stored in `identity.json`. A stored slug would be a second source of
 * truth that could silently disagree with the prefix the temp-file janitor
 * actually sweeps for; derived, it cannot.
 */
exports.APP_SLUG = slugify(exports.APP_NAME);

/**
 * The GitHub repository this template is published from, as `owner/name`.
 *
 * ▲ THIS IS A REBRAND POINT: `repoSlug` in `identity.json`.
 *
 * It is a SEPARATE fact from `APP_NAME` and not derived from it: the product
 * and the repository it lives in are named independently, and a fork routinely
 * changes one without the other. It is here rather than hardcoded at its call
 * sites because it leaks into the PUBLISHED OpenAPI document, where a stale
 * value points a fork's API consumers at somebody else's repository.
 */
exports.REPO_SLUG = identity.repoSlug;

/**
 * The repository's canonical HTTPS URL.
 *
 * Derived rather than stored so that the slug and the URL cannot drift, and so
 * that `identity.json` keeps one fact rather than two spellings of it.
 *
 * Note what this deliberately does NOT cover: `install.sh` builds the same URL
 * and cannot read this, because it is fetched and run via `curl | bash` BEFORE
 * the repository exists on disk. That one is a codemod target in
 * `scripts/rename.mjs`, permanently. See docs/RENAMING.md.
 */
exports.REPO_URL = `https://github.com/${exports.REPO_SLUG}`;
