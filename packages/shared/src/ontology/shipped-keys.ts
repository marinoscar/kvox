// =============================================================================
// SHIPPED_KEYS — the append-only ledger of every ontology key that has ever
// shipped (docs/specs/ontology.md §17.1, §17.4).
//
// NEVER DELETE A LINE FROM THIS LIST. A key is permanent once rows exist:
// stored `type` strings and `props` keys name it. To retire a key, mark it
// `deprecated` in its domain module and leave its line here.
//
// Every new type (`Type`), relation (`RELATION`), attribute (`Type.attr`,
// including domain mixins) and relation prop (`RELATION.prop`) is appended
// here in the same change that declares it. The parity test fails both ways:
// a ledger key missing from the registry (something was removed) and a
// registry key missing from the ledger (the ledger was not updated).
// =============================================================================

export const SHIPPED_KEYS: readonly string[] = Object.freeze([
  // 1.0.0 — core
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
  // 1.0.0 — work
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
