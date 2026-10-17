// =============================================================================
// The correction core's public surface (issue #27, epic #19)
// =============================================================================
//
// One import path for issues #28 (export), #29 (sharing) and #31 (the
// correction UI's server half), so that a consumer never has to know whether
// `applyOps` lives beside `realignWords` or two files away from it.
//
// ⚠ EVERYTHING RE-EXPORTED HERE IS PURE. Nothing in this directory imports
// `PrismaService`, `@nestjs/common` or a Prisma model type; `materialize()` —
// the one operation that genuinely needs a database — deliberately lives
// OUTSIDE it, in `../transcript-materialize.service.ts`, so that this barrel
// cannot become the file through which a reducer acquires a row.
// =============================================================================

export * from './editing-state.js';
export * from './find-matcher.js';
export * from './ops.js';
export * from './ordinals.js';
export * from './reducers.js';
export * from './state-diff.js';
export * from './snapshot-policy.js';
export * from './speaker-identity.js';
export * from './summary.js';
export * from './word-alignment.js';
