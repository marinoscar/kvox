import { defineConfig } from 'vitest/config';

// The test boots the whole application (a database, a Nest app on Fastify) in
// its own process and drives it over HTTP, so it needs generous timeouts and
// must never share the machine with a second copy of itself.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
