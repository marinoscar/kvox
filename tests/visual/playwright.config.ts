import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Pixel-based visual regression tests — issue #107.
 *
 * A SIBLING of `../e2e`, not a replacement or an extension of it. `../e2e`
 * drives the real Docker Compose stack (`localhost:3535`) for full-stack
 * behavioural coverage; this project boots nothing but a Vite dev server over
 * the harness in `apps/web/visual` (see that folder's `main.tsx` for what it
 * fakes and why) and takes screenshots of the real React components it
 * mounts. `../e2e/playwright.config.ts` and `../e2e/package.json` are
 * untouched by this file and must stay that way.
 *
 * WHY A SEPARATE PROJECT, NOT A THIRD `../e2e` PROJECT ENTRY
 * -------------------------------------------------------------------------
 * Pixel baselines are sensitive to the exact browser BUILD, not just the
 * Playwright API version — a Chromium point release can shift font hinting
 * or anti-aliasing by a pixel and invalidate every baseline. `../e2e` pins
 * `@playwright/test` with a caret (`^1.40.0`) because it only asserts DOM
 * state and never fails on that kind of drift. This project pins EXACTLY
 * `1.62.1` (see `package.json`) and baselines are only ever regenerated
 * inside `mcr.microsoft.com/playwright:v1.62.1-noble` (see the repo root
 * CLAUDE.md / CI `visual` job) — a caret here would silently break that
 * contract the next time `npm install` picks a newer patch.
 *
 * All paths below are resolved from THIS FILE's own location rather than
 * `process.cwd()`, so `npx playwright test --config=tests/visual/playwright.config.ts`
 * behaves identically whether it is run from the repo root (the documented
 * invocation) or from inside `tests/visual` itself.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// `apps/web`'s own `node_modules` is a symlink back into the main checkout
// (see the repo root CLAUDE.md worktree conventions); Vite itself is hoisted
// to the repo root's `node_modules` by the `apps/*` npm workspace, which is
// why it is resolved from there rather than from `apps/web/node_modules`.
const viteBinJs = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const harnessViteConfig = path.join(repoRoot, 'apps', 'web', 'visual', 'vite.config.ts');

const PORT = 5183;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries, deliberately, unlike `../e2e`'s `CI ? 2 : 0`. A retry that
  // "passes" on a pixel-diff test is exactly the kind of flake this suite
  // exists to make impossible to hide — a real diff should fail once, loudly,
  // with the HTML report's image attached, not get silently swallowed by a
  // second attempt.
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }]],
  expect: {
    toHaveScreenshot: {
      // Frozen CSS animations/transitions (MUI's ripple, the rail's width
      // transition, `CircularProgress`'s spin) so a screenshot never lands
      // mid-animation.
      animations: 'disabled',
      // TIGHTENED from the issue's 0.01 starting point, and deliberately not
      // ratio-based — see the long note below.
      //
      // Two consecutive containerised runs against a stable baseline came back
      // BYTE-IDENTICAL (0 differing pixels), confirmed repeatedly while
      // building this suite, in this exact pinned container. There is no
      // rendering noise floor to leave headroom for here.
      //
      // `maxDiffPixelRatio` alone cannot do this suite's job: several specs
      // scope their screenshot to the `nav` rail element, which is mostly
      // background — a 56×836px collapsed rail has only a few hundred
      // "ink" pixels (icon strokes, caption glyphs) against a sea of uniform
      // background, so moving or resizing a whole row changes only a few
      // hundred pixels out of ~47,000. That is comfortably under a 1% ratio
      // (or even a 0.1% one) even though it is exactly the class of
      // regression this suite exists to catch — verified empirically:
      // reverting bug #105 part 1 (Console inline instead of pinned) against
      // a 1%, and separately a sub-1%, ratio still passed silently.
      // `maxDiffPixels` is an ABSOLUTE count instead, so it does not dilute
      // with a screenshot's blank space.
      maxDiffPixels: 4,
      // Also lowered from Playwright's own default (0.2) — a SEPARATE knob
      // from the two above: this is pixelmatch's per-PIXEL colour-distance
      // sensitivity, not a count of how many differing pixels are tolerated.
      // Necessary for bug #105 part 2 specifically: the `.Mui-selected` rail
      // row's background is a 16%-opacity light-blue tint over this app's
      // near-black dark theme — perceptually subtle. Verified empirically
      // that the padding regression's ~2px shift of that tint's edge produces
      // ZERO pixels pixelmatch counts as different at its own default
      // threshold (0.1) or Playwright's (0.2), even though the underlying
      // RGB delta is large and unmistakable (confirmed by sampling raw pixel
      // bytes) — pixelmatch's YIQ perceptual-distance metric alone judges
      // that specific dark-on-dark transition as "close enough" at those
      // thresholds. 0.05 was the loosest value that still caught it in
      // testing (143 of ~150 affected pixels register; 0.1 registers none).
      threshold: 0.05,
    },
  },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Boots the harness's own Vite dev server (`apps/web/visual/vite.config.ts`)
  // — never the app's real one, and never the Docker Compose stack `../e2e`
  // needs. `reuseExistingServer` is false in CI so a stale server from a
  // previous job can never be mistaken for a fresh one; locally it reuses one
  // you already have running (e.g. via `npm run test:update`) if the port
  // matches.
  webServer: {
    command: `node "${viteBinJs}" --config "${harnessViteConfig}"`,
    cwd: repoRoot,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
