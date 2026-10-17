import { Inject, Injectable } from '@nestjs/common';

import { OWNER_PURGE_MODE } from '../../core/index.js';
import { KVOX_JOBS, KVOX_PRISMA, type KvoxJobsPort } from '../../ports/index.js';
import type { KvoxNotesDb } from '../data/notes-db.js';
import { NOTE_PURGE_JOB_TYPE, NOTE_SUBJECT_TYPE } from '../job-types.js';

// =============================================================================
// NotesUserDataService (issue #80; the package form of issue #495, epic #491)
// =============================================================================
//
// What the host's "delete my data" feature (the Danger Zone) asks of the notes slice,
// in one place so no host re-derives it:
//
//   • `summary`            how much there is to delete (own notes and own custom templates);
//   • `enqueuePurgeAll`    the owner-level `note.purge` job - the HOST's registry delegates the
//                          `Note` model to it, and the handler soft-deletes every live note of
//                          the user and fans out to the per-note purge it already runs;
//   • `clearDerivedReferences`  the foreign-key clearing the owner-level purge needs: a note
//                          generated FROM another note restricts that note's deletion
//                          (`source_note_id` is `Restrict`), so when a whole account is
//                          deleted the pointers are cleared first.
//
// THE QUEUE RULE HOLDS: `enqueuePurgeAll` only enqueues; the deleting is the registered
// `note.purge` handler's. A user's own custom templates are removed by the host's registry
// (`keepWhenReferenced`) or one by one through `NoteTemplatesService.remove`, the path that
// already knows a template must be ARCHIVED rather than deleted while a note still names it.
// =============================================================================

/**
 * What the Danger Zone shows for notes.
 *
 * @stability experimental
 */
export interface NotesUserDataSummary {
  /** Live notes the user owns. */
  notes: number;
  /** Custom (non-built-in) templates the user owns. */
  templates: number;
}

/**
 * NotesUserDataService: the notes slice's side of the host's account-data deletion.
 *
 * @extensionPoint
 * @stability experimental
 */
@Injectable()
export class NotesUserDataService {
  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxNotesDb,
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
  ) {}

  /**
   * Counts what a deletion would remove.
   *
   * @param userId - the account.
   * @returns the live note count and the custom template count.
   */
  async summary(userId: string): Promise<NotesUserDataSummary> {
    const [notes, templates] = await Promise.all([
      this.prisma.note.count({ where: { ownerId: userId, deletedAt: null } }),
      this.prisma.noteTemplate.count({ where: { ownerId: userId } }),
    ]);

    return { notes, templates };
  }

  /**
   * Queues the owner-level purge of every note the user owns.
   *
   * @param userId - the account.
   * @returns the queued job's id.
   */
  async enqueuePurgeAll(userId: string): Promise<string> {
    const job = await this.jobs.enqueue({
      type: NOTE_PURGE_JOB_TYPE,
      reason: 'rerun',
      subjectType: NOTE_SUBJECT_TYPE,
      subjectId: `owner:${userId}`,
      payload: { mode: OWNER_PURGE_MODE, userId },
    });

    return job.id;
  }

  /**
   * Clears the `source_note_id` of every note derived from one of `noteIds`, so those notes
   * can be deleted while the notes that were generated from them are deleted in the same
   * sweep. Idempotent.
   *
   * @param noteIds - the notes about to be soft-deleted.
   * @returns how many derived notes were detached.
   */
  async clearDerivedReferences(noteIds: readonly string[]): Promise<number> {
    if (noteIds.length === 0) return 0;

    const cleared = await this.prisma.note.updateMany({
      where: { sourceNoteId: { in: [...noteIds] } },
      data: { sourceNoteId: null },
    });

    return cleared.count;
  }
}
