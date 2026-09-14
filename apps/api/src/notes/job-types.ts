// =============================================================================
// The notes pipeline's job type strings (issue #49, epic #45)
// =============================================================================
//
// ⚠ THESE STRINGS ARE PERMANENT, for the reason `transcripts/job-types.ts`
// already states in full: `Job.type` is a plain text column with no enum behind
// it, which is exactly what makes a new handler cost zero migrations — and
// exactly what makes a RENAME cost a data migration over every row already
// queued, running, or sitting in the history under the old name.
//
// They live in their own module rather than on each handler class because the
// ENQUEUEING side and the EXECUTING side are different files and frequently
// different modules: `POST /api/notes` (#53) enqueues `note.generate`, the
// upload path (#51) enqueues `note.source.extract`, a `@Cron` enqueues
// `notes.housekeeping`. Importing a handler class purely to read its `type`
// would drag a provider — and its whole constructor graph — into a file that
// only needed a string.
//
// FOUR OF THE FIVE ARE DECLARED HERE WITHOUT A HANDLER, deliberately, and the
// same way `TRANSCODE_JOB_TYPE` was declared by #25 before #26 implemented it:
// a constant both sides import is the only arrangement where the enqueue and
// the registration cannot drift. Every enqueue site for one of those four must
// check `JobHandlerRegistry.get(TYPE)` first, so a build without the handler
// queues nothing rather than queueing a row no worker can ever claim — which
// would sit `pending` forever and show in the admin job list as a permanent
// backlog of one.
// =============================================================================

/**
 * Turn a template plus a source plus optional context into a note.
 *
 * The one type issue #49 registers. Server-only permanently (see the handler),
 * `maxAttempts: 1` deliberately, and the most expensive thing this application
 * does — on the user's own vendor account.
 */
export const NOTE_GENERATE_JOB_TYPE = 'note.generate';

/**
 * Pull plain text out of an uploaded PDF/TXT/MD source document.
 *
 * ⚠ NOT REGISTERED BY THIS ISSUE — issue #51 owns the handler. `note.generate`
 * reads the text it produces (spec §3.2, §4.7) and never parses a document
 * itself.
 */
export const NOTE_SOURCE_EXTRACT_JOB_TYPE = 'note.source.extract';

/**
 * Render one version of a note into one file, in one format.
 *
 * ⚠ NOT REGISTERED BY THIS ISSUE — issue #54 owns the handler, reusing #28's
 * exporter registry.
 */
export const NOTE_EXPORT_JOB_TYPE = 'note.export';

/** Remove every byte and every row a deleted note ever owned. ⚠ #53 owns it. */
export const NOTE_PURGE_JOB_TYPE = 'note.purge';

/** The reconciliation sweep (expired previews, expired exports). ⚠ #53 owns it. */
export const NOTES_HOUSEKEEPING_JOB_TYPE = 'notes.housekeeping';

/**
 * `Job.subject_type` for every note-scoped job in this module.
 *
 * A plain string, matching the column: `jobs.subject_type` has no foreign key
 * and no enum precisely so a fork's own subjects need no schema change.
 */
export const NOTE_SUBJECT_TYPE = 'note';

/**
 * `storage_objects.managed_by` for every object a note owns.
 *
 * The uploaded source document (#51) and the rendered exports (#54). It is what
 * makes those rows invisible to `GET /api/storage/objects` and undeletable
 * through the generic `DELETE`.
 */
export const NOTES_MANAGED_BY = 'notes';

/** Prefix of every per-user AI throttle key. See {@link aiProviderThrottleKey}. */
export const AI_PROVIDER_THROTTLE_PREFIX = 'ai-provider';

/**
 * The provider-throttle bucket one user's generations draw on.
 *
 * ⚠ ONE BUCKET PER USER — THE EXACT INVERSE OF `TRANSCRIPTION_THROTTLE_KEY`,
 * and the inversion is the whole point (docs/specs/notes.md §2.3). There, every
 * user's transcription authenticates as the SAME deployment-owned AssemblyAI
 * account against ONE vendor rate limit, so one shared key correctly protects
 * it and a 429 discovered by any handler is evidence about all three. Here,
 * every user brings THEIR OWN vendor account with THEIR OWN limit: a 429
 * against user A's key is evidence about user A and about nobody else, so
 * deferring on one shared key would let a single busy user throttle every other
 * user's notes — a relationship between the accounts that does not exist.
 *
 * `ProviderThrottleService` maps `Job.type` → key, so `note.generate` registers
 * this key per job, immediately before the provider call, rather than once at
 * `onModuleInit` the way a shared-bucket handler does. See the handler's own
 * note on what that does and does not buy.
 */
export function aiProviderThrottleKey(userId: string): string {
  return `${AI_PROVIDER_THROTTLE_PREFIX}:${userId}`;
}
