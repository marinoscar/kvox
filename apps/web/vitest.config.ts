import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    env: {
      VITE_API_BASE_URL: 'http://localhost:3000/api',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules',
        'src/__tests__',
        '**/*.d.ts',
        '**/*.config.*',
        'src/main.tsx',
        // `src/sw.ts` (issue #218) is a ServiceWorkerGlobalScope module: it
        // calls `clientsClaim()` and registers fetch routes at import time, so
        // jsdom cannot even load it, let alone execute it. Left in, `all`
        // coverage would report it as permanently 0% and drag the thresholds
        // down for a file no test can legitimately reach. What IS checkable
        // about it — that the build emits `sw.js` at root scope and precaches
        // nothing under `/api` — is asserted in
        // `src/__tests__/pwa/service-worker.test.ts` against build output.
        'src/sw.ts',
      ],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
      },
    },
    // Raised from 10s for the DataTable suites. Their slowest cases legitimately
    // take ~5.5s locally: each renders a full MUI X DataGrid (or card list)
    // under the jsdom layout stubs, and the conformance suite additionally runs
    // an axe-core pass across two renderers x two themes. 10s left under 2x
    // headroom, which is the shape of a suite that is green locally and flakes
    // on a loaded CI runner. The cost of the higher ceiling is only that a
    // genuinely hung test takes longer to be declared dead.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      // `virtual:pwa-register/react` (issue #219) is synthesised by `VitePWA()`
      // at build time and does not exist on disk. This config deliberately does
      // not run that plugin — a unit test should not depend on a Workbox build
      // — so without this alias the import in
      // `src/components/pwa/UpdatePrompt.tsx` fails to resolve and takes every
      // suite that renders `<App />` with it. The double is a real hook; see
      // its file header for why it is an alias rather than a `vi.mock()`.
      'virtual:pwa-register/react': resolve(__dirname, './src/__tests__/mocks/pwa-register.ts'),
    },
  },
});
