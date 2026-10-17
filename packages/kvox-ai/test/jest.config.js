// =============================================================================
// Jest for @marinoscar/kvox-ai (issue #579)
// =============================================================================
//
// One project: `src/**/*.spec.ts` and `test/**/*.spec.ts`. No database, no
// network, no key. The specs moved here from `apps/api/src/ai-port/` with their
// files (the assertions are unchanged), so the runner is the one they were
// written for: Jest with ts-jest, as in `packages/kvox-api`.
// =============================================================================

const path = require('node:path');

/** @type {import('jest').Config} */
module.exports = {
  // Absolute: a relative rootDir would resolve against the working directory.
  rootDir: path.resolve(__dirname, '..'),
  moduleFileExtensions: ['js', 'json', 'ts'],
  // Sources import each other with the `.js` extension NodeNext requires;
  // Jest resolves the `.ts` file behind it.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        // TS151002: ts-jest suggests isolatedModules for NodeNext. The package
        // is "type": "commonjs", so NodeNext resolves unambiguously.
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 30000,
};
