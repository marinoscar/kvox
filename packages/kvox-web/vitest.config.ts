import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['./test/setup.ts'],
    // Times render in the display zone, which falls back to the device's: pin the
    // device to UTC so a suite reads the same on every machine. A test that is
    // about zones names one (`setPreferredTimeZone`, or a `timeZone` argument).
    env: { TZ: 'UTC' },
    // MUI DataGrid-free suites, but the axe passes are slow on a loaded runner.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
