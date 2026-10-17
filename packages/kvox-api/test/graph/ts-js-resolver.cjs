'use strict';

// =============================================================================
// Resolves `./x.js` to `./x.ts` for a plain Node child that runs package sources
// (issue #496, epic #491)
// =============================================================================
//
// The slices import each other with the `.js` extension NodeNext requires, and Jest maps it back
// to the `.ts` file. A child `node -r ts-node/register` process (the layout benchmark and the
// time-zone probe: the two specs that must run OUTSIDE Jest's vm context) has no such mapping,
// so preload this file before ts-node.
// =============================================================================

const Module = require('node:module');

const resolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolve(request, parent, ...rest) {
  if (/^\.\.?\//.test(request) && request.endsWith('.js')) {
    try {
      return resolveFilename.call(this, `${request.slice(0, -3)}.ts`, parent, ...rest);
    } catch {
      // fall through to the request as written
    }
  }

  return resolveFilename.call(this, request, parent, ...rest);
};
