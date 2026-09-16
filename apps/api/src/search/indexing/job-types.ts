// =============================================================================
// The semantic-index job type (issue #188, epic #165 — Semantic Search)
// =============================================================================
//
// ONE TYPE, and the strings below are what both sides of it import. Everything
// `notes/job-types.ts` and `transcripts/job-types.ts` say about why the strings
// live in their own module applies word for word: the ENQUEUEING side (the
// transcript ingest handler, the note generation commit, two correction paths)
// and the EXECUTING side (`search-index.handler.ts`) are different files in
// different modules, and importing a handler class purely to read its `type`
// would drag a provider and its whole constructor graph into a file that only
// needed a string.
//
// ⚠ `'search.index'` IS PERMANENT. `Job.type` is a plain text column with no
// enum behind it — that is exactly what makes a new handler cost zero
// migrations, and exactly what makes a RENAME cost a data migration over every
// row already queued, running, or sitting in the job history under the old
// name.
//
// -----------------------------------------------------------------------------
// ⚠ THERE IS DELIBERATELY NO `search.housekeeping` CRON, AND THERE MUST NOT BE
// -----------------------------------------------------------------------------
//
// A timer that re-indexes stale documents is a writer that spends users' money
// on a schedule.
//
// That sentence is the whole rule, and it is worth spelling out because the
// omission looks like an oversight against every other pipeline in this
// repository. `transcripts.housekeeping`, `notes.housekeeping`, `db.backup
// .sweep` and `nodes.fleet.sweep` all exist, all run on a ten-minute `@Cron`,
// and all reconcile rows nobody asked them to reconcile — which is correct
// there, because the work they do is deleting expired rows and marking silent
// nodes offline. It costs disk and a little CPU inside this deployment.
//
// Indexing does not. Every chunk this job embeds is a request against THE
// DOCUMENT OWNER'S OWN vendor account (docs/specs/notes.md §9 — this epic
// inherits strict bring-your-own-key unchanged), so a sweep that decides on its
// own that a corpus "looks stale" bills a person who pressed no button, at an
// hour they are asleep, for an amount nothing in the UI predicted. The two
// obvious triggers are both traps:
//
//   • "re-index documents whose `content_fingerprint` is null" — which is every
//     document belonging to every user who has never configured a key, forever,
//     because the skip is permanent until they configure one;
//   • "re-index documents indexed under an older model" — which is the entire
//     corpus, the morning after somebody changes the embedding model, all at
//     once, on N users' accounts.
//
// So indexing is enqueued at EXPLICIT, NAMED CONTENT EVENTS and nowhere else:
// a transcript ingested, a note generated, a correction committed. Each one is
// a moment a person did something to a document, and each one is a place where
// the cost is proportional to the change they made. A deployment that genuinely
// wants a backfill should get an admin-triggered one — a button somebody
// presses, having read what it will do — not a timer.
//
// `apps/api/test/jobs/cron-enqueue-only.spec.ts` polices the neighbouring rule
// (a `@Cron` may only enqueue). Nothing polices this one, because the thing it
// forbids is a file that does not exist; this header is the guard.
// =============================================================================

/**
 * Chunk one document, embed the chunks whose text actually moved, and record
 * per-document why it is or is not semantically searchable.
 *
 * Server-only permanently and `maxAttempts: 3` — see the handler's header for
 * both arguments, the second of which is the deliberate INVERSE of
 * `note.generate`'s.
 */
export const SEARCH_INDEX_JOB_TYPE = 'search.index';

/**
 * `search_chunks.document_type` / `search_index_state.document_type` for a
 * transcript.
 *
 * ⚠ ALSO THE JOB'S `subject_type`, deliberately the same string. `jobs
 * .subject_type` is plain text with no foreign key and no enum precisely so a
 * fork's own subjects need no schema change, and it already carries
 * `'transcript'` for every job in the transcript pipeline
 * (`TRANSCRIPT_SUBJECT_TYPE`). Using a different spelling here would mean the
 * admin job list showed two subject types for one kind of row.
 */
export const SEARCH_DOC_TRANSCRIPT = 'transcript';

/** `document_type` (and `subject_type`) for a note. See above. */
export const SEARCH_DOC_NOTE = 'note';

/**
 * The document kinds this build can index.
 *
 * A UNION OF TWO STRING LITERALS RATHER THAN A PRISMA ENUM, matching the
 * columns: `search_chunks.document_type` is plain `text` with no foreign key in
 * either direction, because the set of searchable document types is open-ended
 * and code-owned (see the `SearchChunk` model's own comment, and `Job
 * .subjectType`, which sets the precedent). A fork adding a third kind widens
 * this union and teaches `SearchIndexHandler.loadDocument` to read it; it
 * writes no migration.
 */
export type SearchDocumentType = typeof SEARCH_DOC_TRANSCRIPT | typeof SEARCH_DOC_NOTE;

/** Every value {@link SearchDocumentType} admits, for runtime validation. */
export const SEARCH_DOCUMENT_TYPES: readonly SearchDocumentType[] = [
  SEARCH_DOC_TRANSCRIPT,
  SEARCH_DOC_NOTE,
];

/**
 * What travels in a `search.index` job's payload.
 *
 * TWO IDENTIFIERS AND NOTHING ELSE, per `handlers/README.md`'s rule: the job
 * may run minutes after it was queued, so every fact about the document —
 * its owner, its title, its text, its current version — is re-read at run time
 * rather than carried in a payload that has gone stale. Carrying the text here
 * would additionally mean a copy of somebody's private conversation sitting in
 * a JSONB column the admin job list can be pointed at.
 */
export interface SearchIndexJobPayload {
  documentType: SearchDocumentType;
  documentId: string;
}

/** Narrows an opaque job payload to {@link SearchIndexJobPayload}, or `null`. */
export function readSearchIndexPayload(payload: unknown): SearchIndexJobPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;

  const { documentType, documentId } = payload as Record<string, unknown>;

  if (typeof documentId !== 'string' || documentId.length === 0) return null;

  if (
    typeof documentType !== 'string' ||
    !SEARCH_DOCUMENT_TYPES.includes(documentType as SearchDocumentType)
  ) {
    return null;
  }

  return { documentType: documentType as SearchDocumentType, documentId };
}

// -----------------------------------------------------------------------------
// `search_index_state.reason` — the diagnostic strings this handler writes
// -----------------------------------------------------------------------------
//
// PLAIN TEXT IN THE DATABASE AND DELIBERATELY NOT AN ENUM (see the
// `SearchIndexState` model comment): this column is a diagnostic string for a
// human debugging a document that is not searchable, and it will grow new
// values as new failure modes are discovered. The constants below exist so the
// handler and its tests cannot disagree about the spelling, not to close the
// set.

/**
 * The owner has configured no AI provider key, so there is nothing to embed
 * with. A SKIP, NOT A FAILURE — and the most common non-indexed state on any
 * deployment, because it is the state of every document belonging to every user
 * on the day the feature ships.
 */
export const SEARCH_REASON_KEY_MISSING = 'ai_key_missing';

/** The provider refused the owner's key (401/403). A skip; see the handler. */
export const SEARCH_REASON_KEY_INVALID = 'ai_key_invalid';

/**
 * This deployment has AI switched off, has chosen no provider, or names one
 * this build does not implement. A skip: an administrator's decision, not a
 * fact about the document.
 */
export const SEARCH_REASON_NOT_CONFIGURED = 'ai_not_configured';

/**
 * The active provider is a perfectly good chat provider that declares no
 * `embedding` capability — an OpenAI-compatible gateway proxying only
 * `/chat/completions` is the worked example in
 * `ai-provider.interface.ts`'s EMBEDDINGS section. A skip, and a permanent one
 * until an administrator changes providers.
 */
export const SEARCH_REASON_EMBEDDING_UNSUPPORTED = 'embedding_unsupported';

/**
 * A vector arrived at a width `vector(1536)` cannot store.
 *
 * ⚠ THE ONE `failed` REASON, AND THE ONLY ONE THAT ALSO THROWS. Every other
 * outcome above is a fact about the deployment or the user's own account, which
 * this job succeeded at determining. This one is a BUG: `AiProviderRegistry
 * .register` refuses a provider declaring any other width at boot, and
 * `OpenAiProvider.embed` refuses a response of any other width before returning
 * — so a mismatch reaching this handler means one of those two guards has been
 * removed or bypassed, and it must be visible in `Job.lastError` rather than
 * recorded quietly on the document and returned as success.
 */
export const SEARCH_REASON_DIMENSION_MISMATCH = 'dimension_mismatch';
