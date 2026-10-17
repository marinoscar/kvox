import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['./test/setup.ts'],
    // MUI DataGrid-free suites, but the axe passes are slow on a loaded runner.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
