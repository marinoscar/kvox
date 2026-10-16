// =============================================================================
// The storage-object module's queue vocabulary (issue #480)
// =============================================================================
//
// One job type, and the subject type it is queued under. They live in their own
// file for the reason `notes/job-types.ts` and `transcripts/job-types.ts` state:
// the user-data manifest that names the delegate and the handler that registers
// it must spell the string the same way, and `Job.type` is a plain text column
// that no schema checks.
// =============================================================================

/**
 * Delete the plain uploads one user owns: the storage objects they uploaded that
 * NO module manages (no row in `kvox_object_ownership`).
 *
 * ⚠ PERMANENT once a job of this type exists. It is the delegate of the
 * `StorageObject` model in `platform/user-data/user-data.manifest.ts`, which the
 * platform's `user.data.purge` enqueues for the `files` category.
 */
export const FILES_PURGE_UNMANAGED_JOB_TYPE = 'files.purge_unmanaged';
