// =============================================================================
// The temporal engine's public surface (issue #353, epic #344)
// =============================================================================
//
// One import path for #355 (`toPgRange`/`fromPgRange`), #365
// (`planTemporalInsert`), #370 (`isValidAt`, held to its SQL by a parity test)
// and #372. docs/specs/ontology.md §5.4.
//
// ⚠ EVERYTHING RE-EXPORTED HERE IS PURE: no database, no framework, no clock.
// Ranges are half-open `[from, to)`, `null` = unbounded, instants are UTC.
// =============================================================================

export * from './types';
export * from './valid-range';
export * from './as-of';
export * from './plan-temporal-insert';
export * from './commitments-to-review';
