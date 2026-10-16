/** @type {import('jest').Config} */
module.exports = {
  rootDir: '..',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  testRegex: '.*\\.spec\\.ts$',
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
        // Nest providers of Epic 6 need. The package is "type": "commonjs", so
        // NodeNext resolves unambiguously.
        diagnostics: { ignoreCodes: [151002] },
      },
    ],
  },
  testEnvironment: 'node',
  testTimeout: 30000,
};
