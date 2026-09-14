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
// frequently different modules: the upload listener enqueues `transcription
// .submit`, the poll handler enqueues `transcription.ingest`, the cron enqueues
// `transcripts.housekeeping`. Importing a handler class purely to read its
// `type` would drag a provider — and its whole constructor graph — into a file
// that only needed a string.
//
// `media.audio.transcode` is declared here too even though ISSUE #26 OWNS THE
// HANDLER. This issue's upload listener has to be able to name the type in
// order to enqueue it, and the name has to be the same one #26 registers. A
// constant both sides import is the only arrangement where that cannot drift;
// see `TRANSCODE_JOB_TYPE`'s own note on the guard that keeps the enqueue inert
// until the handler exists.
// =============================================================================

/**
 * Convert whatever was uploaded into a small, seekable playback rendition.
 *
 * ⚠ NOT REGISTERED BY THIS ISSUE. Issue #26 implements the handler; #25 only
 * needs the name so the upload listener can enqueue it. Every enqueue site in
 * this module checks `JobHandlerRegistry.get(TRANSCODE_JOB_TYPE)` first, so a
 * deployment running #25 without #26 queues nothing rather than queueing a row
 * no worker can ever claim — which would sit `pending` forever and show up in
 * the admin job list as a permanent backlog of one.
 */
export const TRANSCODE_JOB_TYPE = 'media.audio.transcode';

/** Hand the audio to the provider and record the handle it returns. */
export const TRANSCRIPTION_SUBMIT_JOB_TYPE = 'transcription.submit';

/** Ask the provider whether it is done; re-enqueue itself until it is. */
export const TRANSCRIPTION_POLL_JOB_TYPE = 'transcription.poll';

/** Copy the finished result into this application's own tables. */
export const TRANSCRIPTION_INGEST_JOB_TYPE = 'transcription.ingest';

/**
 * Take a point-in-time copy of a version's materialized state.
 *
 * ⚠ NOT REGISTERED BY THIS ISSUE either — issue #27 owns it, and the ingest
 * handler guards its enqueue the same way the upload listener guards the
 * transcode one.
 */
export const TRANSCRIPT_SNAPSHOT_JOB_TYPE = 'transcript.snapshot';

/** Remove every byte and every row a deleted transcript ever owned. */
export const TRANSCRIPT_PURGE_JOB_TYPE = 'transcript.purge';

/** The ten-minute reconciliation sweep. Enqueued by a `@Cron`, never run by one. */
export const TRANSCRIPTS_HOUSEKEEPING_JOB_TYPE = 'transcripts.housekeeping';

/**
 * The shared provider-throttle bucket for every job type that talks to the
 * transcription provider.
 *
 * ⚠ ONE KEY FOR THREE TYPES, ON PURPOSE. Submit, poll and ingest all
 * authenticate as the same account against the same vendor, so they share one
 * rate-limit bucket on the vendor's side. A 429 discovered by `poll` is
 * evidence that `submit` and `ingest` will be throttled too, and registering
 * one key for all three is what lets `ProviderThrottleService` act on that
 * evidence instead of rediscovering it once per type.
 */
export const TRANSCRIPTION_THROTTLE_KEY = 'transcription-provider';

/**
 * `Job.subject_type` for every transcript-scoped job in this module.
 *
 * A plain string, matching the column: `jobs.subject_type` has no foreign key
 * and no enum precisely so a fork's own subjects need no schema change. The
 * one type that does NOT use it is `media.audio.transcode`, which is enqueued
 * with `subjectType: 'storage_object'` so it reuses the node data plane's
 * existing `resolveStorageObjectInput` unchanged (spec §1.5.1).
 */
export const TRANSCRIPT_SUBJECT_TYPE = 'transcript';

/**
 * `storage_objects.managed_by` for every object a transcript owns.
 *
 * Set at `initUpload` for the original and on every object this module creates
 * afterwards. It is what makes those rows invisible to `GET /api/storage
 * /objects` and undeletable through the generic `DELETE` (spec §9.3), and what
 * `ObjectsService.deleteManagedObject` requires to be named back to it before
 * it will remove one.
 */
export const TRANSCRIPTS_MANAGED_BY = 'transcripts';
