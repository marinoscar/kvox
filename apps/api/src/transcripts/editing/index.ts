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

export * from './editing-state';
export * from './find-matcher';
export * from './ops';
export * from './ordinals';
export * from './reducers';
export * from './state-diff';
export * from './snapshot-policy';
export * from './summary';
export * from './word-alignment';
