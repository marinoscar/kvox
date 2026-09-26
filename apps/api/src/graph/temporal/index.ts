// =============================================================================
// The temporal engine's public surface (issue #353, epic #344)
// =============================================================================
//
// One import path for the proposal builder (#365), the commit (#366),
// retrieval (#370), the brief (#372) and the write services (#355), so the
// closing, out-of-order and overlap rules exist exactly once.
//
// ⚠ EVERYTHING RE-EXPORTED HERE IS PURE: no Prisma, no Nest, no clock read.
// `purity.spec.ts` enforces it for every non-spec file in this folder.
// =============================================================================

export * from './types';
export * from './valid-range';
export * from './as-of';
export * from './plan-temporal-insert';
export * from './commitments-to-review';
export * from './temporal-rule';
