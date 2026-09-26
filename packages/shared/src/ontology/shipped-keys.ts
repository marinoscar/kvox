// =============================================================================
// SHIPPED_KEYS -- the append-only ledger of every key that ever shipped
// =============================================================================
//
// NEVER DELETE A LINE FROM THIS FILE. NEVER RENAME ONE.
//
// A key is permanent once rows exist (docs/specs/ontology.md §17.1): renaming
// `WORKS_FOR` after relations of that type exist would orphan every stored
// row's `type` string. The retirement path is to DEPRECATE the definition
// (`deprecated: { since, reason }`), never to remove it.
//
// The parity test (apps/api/test/ontology/ontology-parity.spec.ts) checks
// both directions:
//   - every entry here still exists in the registry (deprecated is fine), so
//     deleting a type or attribute fails CI;
//   - every key in the registry appears here, so adding one without
//     recording it fails CI too, which is what keeps this ledger complete.
//
// Formats: `Type`, `RELATION`, `Type.attribute` (built-in or mixin),
// `RELATION.prop`. User-defined (`u_*`) attributes are data, not code, and
// never appear here.
// =============================================================================

export const SHIPPED_KEYS: readonly string[] = Object.freeze([
  // 1.0.0 -- core
  'Person',
  'Organization',
  'Organization.website',
  'Meeting',
  'Meeting.transcriptId',
  'Meeting.noteId',
  'Meeting.dateSource',
  'Meeting.topics',
  'Claim',
  'PersonFact',
  'ABOUT',
  'IDENTIFIED_AS',
  'SUPERSEDES',
  'MENTIONS',
  'SUPPORTED_BY',
  // 1.0.0 -- work
  'Project',
  'Project.status',
  'Project.startDate',
  'Project.endDate',
  'Commitment',
  'Decision',
  'Decision.rejectedOption',
  'Person.title',
  'WORKS_FOR',
  'HAS_ROLE',
  'HAS_ROLE.title',
  'REPORTS_TO',
  'ATTENDED',
  'DISCUSSED',
  'PART_OF',
  'ASSIGNED_TO',
  'OWED_TO',
  'CREATED_IN',
  'DECIDED_IN',
]);
