// =============================================================================
// When a version gets a snapshot (issue #27, epic #19, spec §4.3)
// =============================================================================
//
// A snapshot is a COMPACTION of replay work, never a second source of truth —
// the same relationship `job-queue.md` §7.6 describes for `JobStatsRollup`.
// Taking one changes how expensive it is to answer "what did this look like at
// version 40"; it never changes the answer.
//
// The policy, and why each half of it exists:
//
//   • **ALWAYS for version 1 and for every restore.** These are the two
//     versions a user is most likely to want to look at or return to, so
//     neither should cost a long replay. Version 1 is also the one version that
//     CANNOT be rebuilt from ops at all — it is what the provider said, not a
//     change to anything — so its snapshot is what makes history reachable
//     (see `transcript-materialize.service.ts`'s header).
//
//   • **Otherwise, after 50 versions OR 1 MB of ops since the last snapshot.**
//     A count trigger alone is defeated by a few enormous find & replace
//     batches; a byte trigger alone is defeated by a hundred one-op saves. Two
//     triggers, whichever comes first, bounds both shapes of editing.
//
// ⚠ NEVER INLINE IN A REQUEST (CLAUDE.md's "Every Long-Running Activity Is a
// Queue Job", rule 1). `POST /:id/operations` enqueues `transcript.snapshot`
// and returns as soon as its own transaction commits; gzipping a ten-hour
// transcript's segments and uploading them is not work to do while a user waits
// for their typo correction to save.
// =============================================================================

/** Versions since the last snapshot that trigger a new one. */
export const SNAPSHOT_VERSION_INTERVAL = 50;

/** Accumulated op bytes since the last snapshot that trigger a new one. */
export const SNAPSHOT_BYTES_INTERVAL = 1024 * 1024;

export interface SnapshotDecisionInput {
  /** The version that was just written. */
  version: number;
  /** Its kind. `ai_original` and `restore` always snapshot. */
  kind: 'ai_original' | 'edit' | 'restore';
  /** The newest version at or before `version` that already has a snapshot. */
  lastSnapshotVersion: number | null;
  /** `sum(octet_length(ops::text))` over every version after that one. */
  bytesSinceSnapshot: number;
}

/** Should `transcript.snapshot` be enqueued for this version? */
export function shouldSnapshot(input: SnapshotDecisionInput): boolean {
  if (input.version <= 1) return true;
  if (input.kind === 'restore') return true;
  if (input.lastSnapshotVersion === null) return true;

  return (
    input.version - input.lastSnapshotVersion >= SNAPSHOT_VERSION_INTERVAL ||
    input.bytesSinceSnapshot >= SNAPSHOT_BYTES_INTERVAL
  );
}
