// =============================================================================
// The transcript pipeline's job type strings (issue #25, epic #19)
// =============================================================================
//
// ⚠ THESE STRINGS ARE PERMANENT. `Job.type` is a plain text column with no
// enum behind it, which is exactly what makes a new handler cost zero
// migrations — and exactly what makes a RENAME cost a data migration over
// every row already queued, running, or sitting in the history table under the
// old name. `CLAUDE.md`'s "Adding a Job Type" says this in one line ("permanent
// once jobs of that type exist"); this file is where the pipeline's five names
// are written down once so that no handler, no enqueue site and no test can
// spell one differently from another.
//
// They live in their own module, rather than on each handler class, because
// the ENQUEUEING side and the EXECUTING side are usually different files and
// frequently different modules: the upload processor enqueues `transcription
// .submit`, the poll handler enqueues `transcription.ingest`, the cron enqueues
// `transcripts.housekeeping`. Importing a handler class purely to read its
// `type` would drag a provider — and its whole constructor graph — into a file
// that only needed a string.
//
// `media.audio.transcode` is declared here too even though ISSUE #26 OWNS THE
// HANDLER. This issue's upload processor has to be able to name the type in
// order to enqueue it, and the name has to be the same one #26 registers. A
// constant both sides import is the only arrangement where that cannot drift;
// see `TRANSCODE_JOB_TYPE`'s own note on the guard that keeps the enqueue inert
// until the handler exists.
// =============================================================================

/**
 * Convert whatever was uploaded into a small, seekable playback rendition.
 *
 * ⚠ NOT REGISTERED BY THIS ISSUE. Issue #26 implements the handler; #25 only
 * needs the name so the upload processor can enqueue it. Every enqueue site in
 * this module checks `JobHandlerRegistry.get(TRANSCODE_JOB_TYPE)` first, so a
 * deployment running #25 without #26 queues nothing rather than queueing a row
 * no worker can ever claim — which would sit `pending` forever and show up in
 * the admin job list as a permanent backlog of one.
  *
  * @stability experimental
 */
export const TRANSCODE_JOB_TYPE = 'media.audio.transcode';

/**
 * Hand the audio to the provider and record the handle it returns.
 *
 * @stability experimental
 */
export const TRANSCRIPTION_SUBMIT_JOB_TYPE = 'transcription.submit';

/**
 * Ask the provider whether it is done; re-enqueue itself until it is.
 *
 * @stability experimental
 */
export const TRANSCRIPTION_POLL_JOB_TYPE = 'transcription.poll';

/**
 * Copy the finished result into this application's own tables.
 *
 * @stability experimental
 */
export const TRANSCRIPTION_INGEST_JOB_TYPE = 'transcription.ingest';

/**
 * Take a point-in-time copy of a version's materialized state.
 *
 * ⚠ NOT REGISTERED BY THIS ISSUE either — issue #27 owns it, and the ingest
 * handler guards its enqueue the same way the upload processor guards the
 * transcode one.
  *
  * @stability experimental
 */
export const TRANSCRIPT_SNAPSHOT_JOB_TYPE = 'transcript.snapshot';

/**
 * Render one version of a transcript into one file, in one format.
 *
 * SERVER-ONLY IN v1, and spec §1.5.6 is explicit that this is NOT one of
 * CLAUDE.md rule 2's three exemptions: its input is a materialized snapshot, so
 * a node could be handed it with no database access at all. It stays here
 * because THE RENDERERS LIVE IN THE API — a second copy in `apps/cli` would
 * mean the same export request producing byte-for-byte different PDFs
 * depending on which codebase claimed the job. The handler carries the same
 * argument in full.
  *
  * @stability experimental
 */
export const TRANSCRIPT_EXPORT_JOB_TYPE = 'transcript.export';

/**
 * Propose corrections for mis-transcribed names (issues #328 and #330, epic
 * #326): phonetic retrieval, an optional AI discovery pass, and AI
 * adjudication, producing `transcript_name_suggestions` rows for the user to
 * accept or reject.
 *
 * SERVER-ONLY PERMANENTLY, for `note.generate`'s reason exactly: it spends the
 * requesting user's own AI key, and no vendor offers a job-scoped sub-key a
 * `nodeSecretBroker` could hand a node instead. `maxAttempts: 1` for the same
 * reason — see the handler.
  *
  * @stability experimental
 */
export const TRANSCRIPT_NAME_CHECK_JOB_TYPE = 'transcript.name_check';

/**
 * Remove every byte and every row a deleted transcript ever owned.
 *
 * @stability experimental
 */
export const TRANSCRIPT_PURGE_JOB_TYPE = 'transcript.purge';

/**
 * The ten-minute reconciliation sweep. Enqueued by a `@Cron`, never run by one.
 *
 * @stability experimental
 */
export const TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE = 'transcripts.housekeeping';

// The shared provider-throttle bucket of the transcription provider (one key for submit, poll
// and ingest, on purpose) moved to `@marinoscar/kvox-api/core` with the per-user AI key (issue
// #490). Re-exported so every existing importer keeps compiling.
export { TRANSCRIPTION_THROTTLE_KEY } from '../core/index.js';

/**
 * Every job type the slice registers, in registration order. PERMANENT: a queued
 * row names its handler by one of these strings, so none is ever renamed. The
 * conformance suite pins this list.
 *
 * @stability experimental
 */
export const TRANSCRIPT_JOB_TYPES: readonly string[] = [
  TRANSCODE_JOB_TYPE,
  TRANSCRIPTION_SUBMIT_JOB_TYPE,
  TRANSCRIPTION_POLL_JOB_TYPE,
  TRANSCRIPTION_INGEST_JOB_TYPE,
  TRANSCRIPT_SNAPSHOT_JOB_TYPE,
  TRANSCRIPT_EXPORT_JOB_TYPE,
  TRANSCRIPT_NAME_CHECK_JOB_TYPE,
  TRANSCRIPT_PURGE_JOB_TYPE,
  TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE,
];

/**
 * `Job.subject_type` for every transcript-scoped job in this module.
 *
 * A plain string, matching the column: `jobs.subject_type` has no foreign key
 * and no enum precisely so a fork's own subjects need no schema change. The
 * one type that does NOT use it is `media.audio.transcode`, which is enqueued
 * with `subjectType: 'storage_object'` so it reuses the node data plane's
 * existing `resolveStorageObjectInput` unchanged (spec §1.5.1).
  *
  * @stability experimental
 */
export const TRANSCRIPT_SUBJECT_TYPE = 'transcript';

/**
 * `storage_objects.managed_by` for every object a transcript owns.
 *
 * Set at `initUpload` for the original and on every object this module creates
 * afterwards. It is what makes those rows invisible to the generic storage list
 * (`GET /api/storage/objects`) and undeletable through the generic `DELETE`
 * (spec §9.3), and what the host's managed delete requires to be named back to
 * it before it will remove one.
  *
  * @stability experimental
 */
export const TRANSCRIPTS_MANAGED_BY = 'transcripts';

/**
 * The content types a transcript's source upload may have: any audio or video. The upload
 * route gates on it, and the upload hook asks the object store to report only these.
 *
 * @stability experimental
 */
export const TRANSCRIPT_SOURCE_CONTENT_TYPES: readonly string[] = ['audio/*', 'video/*'];
