import manifest from './package.json' with { type: 'json' };

// =============================================================================
// The version baked into the bundle  (issue #296)
// =============================================================================
//
// WHY THIS IS A `define` AND NOT AN API CALL
//
// It reports WHAT THIS BUNDLE IS. A stale cached bundle serving old JavaScript
// against a freshly deployed API is exactly the failure a version line exists
// to expose, and a number fetched from the server would hide it — old client
// code would cheerfully print the new server's version. The two are only
// guaranteed equal because issue #295 makes `apps/api` and `apps/web` carry
// ONE shared product version, bumped in lockstep at deploy time; when they
// disagree, that disagreement is the bug and this is what surfaces it.
//
// It also costs no endpoint, no route, no controller and no permission — which
// matters, because `GET /api/admin/about` (the only other place the version
// appears) is gated on `system_settings:read`, seeded Admin-only. A Contributor
// or a Viewer could not read their own build number at all.
//
// WHY THIS FILE LIVES OUTSIDE `src/`
//
// The same reason `pwa/manifest.ts` does, and its header states it in full: it
// is CONFIG-SIDE code. `apps/web/tsconfig.json` scopes the application to
// `include: ["src"]`, so keeping it here is what stops the React tree importing
// it and reading `package.json` in a browser. It is covered by
// `tsconfig.node.json` instead, beside `vite.config.ts` and `pwa/`.
//
// ⚠ AT THE PACKAGE ROOT RATHER THAN IN A `build/` FOLDER, which is where it
// started: this repository's `.gitignore` ignores `build/`, so the obvious
// home for it is one git would never have committed.
//
// ⚠ BOTH CONFIGS NEED IT. `vite.config.ts` and `vitest.config.ts` are separate
// files that share nothing, so a `define` added to only the first leaves
// `__APP_VERSION__` undefined in every test that renders a component using it —
// a ReferenceError at run time, not a type error at build time. That is why
// this is a shared function rather than two literals.
//
// ⚠ AN IMPORT, NOT A `readFileSync` OFF `import.meta.url`. That was the first
// version of this file and it FAILED, for a reason worth recording: Vite loads
// a config by BUNDLING it to `node_modules/.vite-temp/<config>.timestamp-*.mjs`
// and importing that, so `import.meta.url` points at the temp directory and
// `new URL('../package.json', …)` resolved to `apps/package.json`, which does
// not exist. `__dirname` is no better — it is injected per loader and is absent
// under the native ESM loader Vite is moving to. An import has no runtime path
// resolution at all: the bundler inlines the JSON, so it is correct under every
// loader by construction.
// =============================================================================

/** This package's own version, read at config time. */
export function appVersion(): string {
  const version: unknown = manifest.version;

  if (typeof version !== 'string' || version === '') {
    // A build that cannot name itself is a build whose version line would lie.
    throw new Error('apps/web/package.json has no usable "version"');
  }
  return version;
}

/**
 * The `define` entry both configs spread.
 *
 * `JSON.stringify` is not decoration: `define` performs a RAW TEXTUAL
 * substitution, so the replacement has to be a JavaScript expression. Passing
 * the bare string would emit `1.2.3` into the source, which parses as a number
 * literal followed by nonsense.
 */
export function appVersionDefine(): Record<string, string> {
  return { __APP_VERSION__: JSON.stringify(appVersion()) };
}
