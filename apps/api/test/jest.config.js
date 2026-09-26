/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    // .ts only. Matching .js too made ts-jest warn whenever a test requires a
    // plain CommonJS script (src/common/database-url.spec.ts requires
    // scripts/prisma-env.js to hold the two connection-string builders
    // together), and `allowJs` cannot be turned on to satisfy it because this
    // project sets `declaration: true`, which conflicts with it. Those scripts
    // are already CommonJS and need no transform.
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        // TS151002: ts-jest warns that the NodeNext ("hybrid") module kind
        // wants isolatedModules. It does not apply here: apps/api has no
        // "type": "module", so NodeNext resolves unambiguously to CommonJS.
        // isolatedModules cannot be enabled anyway - it conflicts with
        // emitDecoratorMetadata, which NestJS requires (TS1272).
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/**/*.dto.ts',
    '!src/main.ts',
    '!src/**/*.spec.ts',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  globalTeardown: '<rootDir>/test/teardown.ts',
  testTimeout: 30000,
  // Recycle a worker between test files once its heap passes 1 GB. Many
  // suites compile the whole AppModule (createTestApp), and ts-jest's module
  // registry is never released inside a worker, so a long-lived worker's heap
  // only grows: once the graph grew with the Ask modules (epic #348), CI
  // workers began dying mid-run with "Jest worker ran out of memory" on
  // whichever suite happened to land last (ask-tools.module.spec.ts once,
  // test-app-scheduler.spec.ts the next time). Restarting a worker costs a
  // cold module cache for the next file; crashing costs the whole run.
  workerIdleMemoryLimit: '1GB',
  verbose: true,
};
