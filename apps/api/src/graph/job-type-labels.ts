// Display labels for the connected-knowledge graph's job types (issue #460).
//
// Declared beside the module that owns the types and REGISTERED from
// `src/kvox.manifest.ts`, so the base `jobs/` folder names no domain job type.
// Keys are permanent `Job.type` values; an unlabelled type still renders as
// itself (see `jobs/job-type-label.ts`).

export const GRAPH_JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  // Connected knowledge (#357, epic #344). One label for both scopes — a
  // forgotten person and a Danger Zone graph wipe are the same operation
  // (deleting graph rows) at two sizes, and the operator needs the noun.
  'kg.purge': 'Knowledge graph deletion',
  // Connected knowledge (epic #344). `kg.speaker_link` (#356) is the
  // speaker-naming write into the owner's graph.
  'kg.speaker_link': 'Link named speakers to people',
  // `kg.extract` (#363): one structured-output call per note that proposes
  // graph rows for review, on the note owner's own AI key.
  'kg.extract': 'Knowledge graph extraction',
  // #364: the bulk duplicate re-scan (its only output is a proposal to review)
  // and profile embeddings for resolution's vector arm, both on the owner's key.
  'kg.resolve': 'Knowledge graph resolution',
  'kg.embed': 'Knowledge graph embeddings',
  // #371, epic #347: the whole-graph overview snapshot (clusters + positions).
  'kg.graph_layout': 'Knowledge graph layout',
  // #372 — the rolling per-entity summary the entity brief shows; spends the
  // owner's own AI key, like `note.generate`.
  'kg.entity_digest': 'Knowledge graph entity digest',
  // #384 — reshapes one user's graph rows after an ontology bump that renames
  // or retags something; no AI key involved.
  'kg.migrate': 'Knowledge graph migration',
  // #386, epic #349 — an RDF export of one owner's graph (and its daily expiry sweep).
  'kg.export': 'Knowledge graph export',
  // #387, epic #349 — an uploaded RDF file validated against SHACL and turned
  // into a reviewable proposal; resolution may use the owner's own AI key.
  'kg.import': 'Knowledge graph import',
};
