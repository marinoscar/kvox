// Display labels for the search module's job types (issue #460).
//
// Declared beside the module that owns the types and REGISTERED from
// `src/kvox.manifest.ts`, so the base `jobs/` folder names no domain job type.
// Keys are permanent `Job.type` values; an unlabelled type still renders as
// itself (see `jobs/job-type-label.ts`).

export const SEARCH_JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  // Semantic search (#188, epic #165). "Semantic indexing" rather than
  // "Search index": layer 1 of search is the generated `tsvector` columns,
  // which are maintained by Postgres itself and never appear in this list at
  // all — so an operator meeting this row needs the word that distinguishes
  // the EMBEDDING pass, which costs a document owner money, from the
  // full-text one, which costs nothing and has no job.
  'search.index': 'Semantic indexing',
};
