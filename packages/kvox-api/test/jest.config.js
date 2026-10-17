// =============================================================================
// Jest projects of @marinoscar/kvox-api (issue #492, epic #491)
// =============================================================================
//
// Two projects, the shape every slice reuses:
//
//   unit  `src/**/*.spec.ts` and `test/**/*.spec.ts` except `*.db.spec.ts`.
//         No database, no network; the default for `npm test`.
//   db    `test/**/*.db.spec.ts`, against a real PostgreSQL 16 with pgvector
//         through the test host (`test/host/`, prepared by
//         `npm run test:host:prepare -w @marinoscar/kvox-api`). Run in band: the
//         specs share one server and each makes its own database.
//
// `npm test` and `npm run test:run` select `unit`; `npm run test:db` selects `db`.
// =============================================================================

const path = require('node:path');

const shared = {
  // Absolute: inline projects resolve a relative rootDir against the working directory.
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
        // TS151002: ts-jest suggests isolatedModules for NodeNext. It cannot be
        // on here: it conflicts with emitDecoratorMetadata (TS1272), which the
        // Nest providers need. The package is "type": "commonjs", so NodeNext
        // resolves unambiguously.
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
  testEnvironment: 'node',
  testTimeout: 30000,
};

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      ...shared,
      displayName: 'unit',
      roots: ['<rootDir>/src/', '<rootDir>/test/'],
      testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
      testPathIgnorePatterns: ['/node_modules/', '\\.db\\.spec\\.ts$', '/test/host/'],
    },
    {
      ...shared,
      displayName: 'db',
      // Its own tsconfig: the specs import the host's generated client, which a
      // bare checkout does not have (see `test/host/tsconfig.json`).
      transform: {
        '^.+\\.ts$': [
          'ts-jest',
          { tsconfig: '<rootDir>/test/host/tsconfig.json', diagnostics: { ignoreCodes: [151002] } },
        ],
      },
      roots: ['<rootDir>/test/'],
      testMatch: ['<rootDir>/test/**/*.db.spec.ts'],
      testPathIgnorePatterns: ['/node_modules/', '/test/host/'],
      // A database is created and migrated per spec file.
      testTimeout: 120000,
    },
  ],
};
