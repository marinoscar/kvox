'use strict';

// Loads an ESM-only package (`rdf-validate-shacl`, `rdf-ext`) from the
// CommonJS test suite (#385).
//
// Plain JavaScript ON PURPOSE. ts-jest compiles `import()` in a .ts file to
// `require()`, which cannot load an ESM-only package; this file is not
// transformed (jest.config.js transforms .ts only), so its `import()` reaches
// Jest's own dynamic-import hook for the CURRENT test file — which needs the
// `--experimental-vm-modules` flag `scripts/jest.js` starts Node with. A
// `new Function('return import(x)')` looks equivalent and is not: it binds to
// whichever test environment the worker created first, and fails once that
// environment has been torn down.
module.exports = { esmImport: (specifier) => import(specifier) };
