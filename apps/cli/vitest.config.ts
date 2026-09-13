import { defineConfig } from 'vitest/config';

// =============================================================================
// Test setup for the CLI package (issue #140, epic #110)
// =============================================================================
//
// vitest rather than jest, matching apps/web. The deciding factor is ESM: this
// package is `"type": "module"` with NodeNext resolution, and jest's ESM
// support still needs --experimental-vm-modules plus a transform chain that
// rewrites the `.js` import specifiers NodeNext requires. vitest runs the
// source as modules with no such ceremony.
//
// `environment: 'node'` is explicit even though it is the default, because the
// one thing that must never happen in this package's tests is a jsdom global
// (`window`, `localStorage`, a browser `fetch`) making code pass in the test
// run that cannot work in a terminal.
// =============================================================================

export default defineConfig({
  test: {
    environment: 'node',
    // `.tsx` too: the ink screens (#145) are components, and a test file
    // for one is a .tsx. Without the glob covering it the suite would run
    // green while testing none of them.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Real tests arrive with the rest of epic #110; until then the suite must
    // not fail CI for being empty. The npm scripts pass --passWithNoTests.
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
  },
});
