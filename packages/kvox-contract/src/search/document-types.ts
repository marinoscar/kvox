
/**
 * `search_chunks.document_type` / `search_index_state.document_type` for a
 * transcript.
 *
 * ⚠ ALSO THE JOB'S `subject_type`, deliberately the same string. `jobs.subject_type` is plain text with no foreign key and no enum precisely so a
 * fork's own subjects need no schema change, and it already carries
 * `'transcript'` for every job in the transcript pipeline
 * (`TRANSCRIPT_SUBJECT_TYPE`). Using a different spelling here would mean the
 * admin job list showed two subject types for one kind of row.
 *
 * @stability experimental
 */
export const SEARCH_DOC_TRANSCRIPT = 'transcript';

/**
 * `document_type` (and `subject_type`) for a note. See above.
 *
 * @stability experimental
 */
export const SEARCH_DOC_NOTE = 'note';

/**
 * The document kinds this build can index.
 *
 * A UNION OF TWO STRING LITERALS RATHER THAN A PRISMA ENUM, matching the
 * columns: `search_chunks.document_type` is plain `text` with no foreign key in
 * either direction, because the set of searchable document types is open-ended
 * and code-owned (see the `SearchChunk` model's own comment, and
 * `Job.subjectType`, which sets the precedent). A fork adding a third kind widens
 * this union and teaches `SearchIndexHandler.loadDocument` to read it; it
 * writes no migration.
 *
 * @stability experimental
 */
export type SearchDocumentType = typeof SEARCH_DOC_TRANSCRIPT | typeof SEARCH_DOC_NOTE;

/**
 * Every value {@link SearchDocumentType} admits, for runtime validation.
 *
 * @stability experimental
 */
export const SEARCH_DOCUMENT_TYPES: readonly SearchDocumentType[] = [
  SEARCH_DOC_TRANSCRIPT,
  SEARCH_DOC_NOTE,
];
