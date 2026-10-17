// =============================================================================
// The owner-level payload of `transcript.purge` and `note.purge` (issue #480; moved
// into the core by issue #493, epic #491)
// =============================================================================
//
// The platform's `user.data.purge` job deletes a user's rows by registry. For a
// model whose rows need module-specific teardown (a transcript's audio and
// exports, a note's source document) it does not delete them inline: the model's
// hint names a DELEGATE, a job the purge enqueues after its own rows commit.
// `Transcript` delegates to `transcript.purge` and `Note` to `note.purge`, with
//
//     { mode: 'owner', userId }
//
// as the payload. That is the additive variant of the two handlers' payload
// (`{ transcriptId }` / `{ noteId }` is unchanged): the handler soft-deletes
// every row the user owns and fans out to the per-item purge it already runs.
//
// Shared here, in the core, so the two domains do not each re-derive the same
// parser and the same two bounds. Total over garbage, like every payload reader
// in this repository: a payload this build cannot read names no user, and a
// handler answers that by returning, not by throwing until the queue gives up.
// =============================================================================

/**
 * The discriminator of the owner-level payload.
 *
 * @stability experimental
 */
export const OWNER_PURGE_MODE = 'owner';

/**
 * What the platform's delegate enqueue puts in the payload for one user.
 *
 * @stability experimental
 */
export interface OwnerPurgePayload {
  /** Always `owner`: the whole account, not one item. */
  readonly mode: typeof OWNER_PURGE_MODE;
  /** The user whose data is purged. */
  readonly userId: string;
}

/**
 * Rows soft-deleted and fanned out per page.
 *
 * @stability experimental
 */
export const OWNER_PURGE_BATCH = 200;

/**
 * A STOP, NOT A BUDGET: 5,000 pages of 200 is a million rows. A run that has not
 * converged by then is looping, and the right answer is a failed job a person
 * reads, not a worker slot held forever.
  *
  * @stability experimental
 */
export const OWNER_PURGE_MAX_BATCHES = 5_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The owner-level payload inside a job payload, or `null` for anything else
 * (including the per-item payload).
  *
  * @stability experimental
 */
export function readOwnerPurgePayload(payload: unknown): OwnerPurgePayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const record = payload as Record<string, unknown>;

  if (record.mode !== OWNER_PURGE_MODE) return null;
  if (typeof record.userId !== 'string' || !UUID_PATTERN.test(record.userId)) return null;

  return { mode: OWNER_PURGE_MODE, userId: record.userId };
}

/**
 * The error a non-converging owner purge throws.
 *
 * @stability experimental
 */
export function ownerPurgeDidNotConverge(what: string, userId: string): Error {
  return new Error(
    `Bulk ${what} deletion for user ${userId} did not converge after ` +
      `${OWNER_PURGE_MAX_BATCHES} batches`,
  );
}
