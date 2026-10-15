// =============================================================================
// Notes' and note templates' user-data hooks (issue #80; split out by issue #460)
// =============================================================================
//
// The counts, the byte total (including the extracted-text sidecar rule that
// needs `NOTES_MANAGED_BY` and `readExtractedObjectId`) and the `note.purge` /
// template fan-out for the `notes` and `noteTemplates` categories. The
// declarations are `notes.user-data.ts`, which is kept light for the manifest;
// this class is provided by `NotesModule` under `NOTES_USER_DATA_HOOKS`.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { KvoxManagedObjectsService } from '../kvox-objects/kvox-managed-objects.service';
import { SEARCH_DOC_NOTE } from '../search/indexing/job-types';
import { SearchIndexService } from '../search/indexing/search-index.service';
import {
  auditUserData,
  describe,
  enqueuePurges,
  USER_DATA_PURGE_BATCH,
  USER_DATA_PURGE_MAX_BATCHES,
} from '../user-data/user-data.support';
import { NOTE_PURGE_JOB_TYPE, NOTE_SUBJECT_TYPE, NOTES_MANAGED_BY } from './job-types';
import { NoteTemplatesService } from './note-templates.service';
import { NotesService } from './notes.service';
import { readExtractedObjectId } from './source-metadata';

@Injectable()
export class NotesUserDataHooks {
  private readonly logger = new Logger(NotesUserDataHooks.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notes: NotesService,
    private readonly templates: NoteTemplatesService,
    private readonly searchIndex: SearchIndexService,
    private readonly managedObjects: KvoxManagedObjectsService,
  ) {}

  // ===========================================================================
  // The `notes` category
  // ===========================================================================

  /** `notes` in `GET /api/user-data/summary`. */
  async summarizeNotes(userId: string): Promise<{ count: number; bytes: string }> {
    const [count, bytes] = await Promise.all([
      this.prisma.note.count({ where: { ownerId: userId, deletedAt: null } }),
      this.noteBytes(userId),
    ]);

    return { count, bytes };
  }

  /**
   * Bytes of every storage object the caller's live notes own.
   *
   * Two reachability rules, not one, and the second is the reason this method
   * is not a single `aggregate` call like the transcripts' byte total:
   *
   *   • the uploaded SOURCE DOCUMENT and every rendered EXPORT hang off real
   *     foreign keys, so a relation filter finds them;
   *   • the EXTRACTED-TEXT object `note.source.extract` writes beside a source
   *     document hangs off `storage_objects.metadata.extractedObjectId` (#51's
   *     `source-metadata.ts`), which is JSONB with no foreign key and therefore
   *     no relation to filter on.
   *
   * Leaving the sidecar out would understate the figure by exactly the text of
   * every PDF the user ever uploaded — small per note, and wrong in a dialog
   * whose entire job is to tell the truth about what is about to go. So its ids
   * are collected first and folded into the same `OR`, which keeps the
   * de-duplication property the single aggregate has.
   */
  private async noteBytes(userId: string): Promise<string> {
    const owned = { ownerId: userId, deletedAt: null };

    const sources = await this.prisma.note.findMany({
      where: { ...owned, sourceObjectId: { not: null } },
      select: { sourceObject: { select: { metadata: true } } },
    });

    const candidateIds = sources
      .map((row) => readExtractedObjectId(row.sourceObject?.metadata))
      .filter((id): id is string => id !== null);

    // Only objects the notes module owns count.
    const owners = await this.managedObjects.managedBy(candidateIds);
    const extractedIds = candidateIds.filter((id) => owners.get(id) === NOTES_MANAGED_BY);

    const bytes = await this.managedObjects.sumSize({
      OR: [
        { notesAsSourceObject: { some: owned } },
        { noteExportFiles: { some: { note: owned } } },
        // ⚠ GUARDED, because an empty `in` list is `WHERE id IN ()` — which
        // Prisma renders as a clause matching nothing, but which sits inside
        // an `OR` where a mistake would instead match everything. Omitting
        // the branch entirely is unambiguous.
        ...(extractedIds.length > 0 ? [{ id: { in: extractedIds } }] : []),
      ],
    });

    return bytes.toString();
  }

  /** The destructive step: the notes, then their semantic-index rows. */
  async purgeNotes(userId: string): Promise<void> {
    await this.deleteNotes(userId);
    await this.forgetFromSearchIndex(userId);
  }

  // ===========================================================================
  // Step 2 — notes
  // ===========================================================================

  /**
   * Soft-delete every live note this user owns and hand each to `note.purge`.
   *
   * ⚠ `status: 'generating'` IS NOT EXCLUDED — see the handler's header force
   * section. A generation still running against a note that has just become
   * `deleting` finishes or fails against a row `note.purge` then removes;
   * `note.generate` is `maxAttempts: 1`, so there is no retry to outlive the
   * purge, and `notes.housekeeping` re-queues any note left in `deleting`
   * without a live purge job. The alternative — skipping generating notes —
   * leaves the user with notes they asked to be rid of and no indication why.
   */
  private async deleteNotes(userId: string): Promise<void> {
    let deleted = 0;

    for (let batch = 0; batch < USER_DATA_PURGE_MAX_BATCHES; batch += 1) {
      const rows = await this.prisma.note.findMany({
        where: { ownerId: userId, deletedAt: null },
        select: { id: true },
        take: USER_DATA_PURGE_BATCH,
      });

      if (rows.length === 0) {
        if (deleted > 0) {
          await auditUserData(this.prisma, userId, 'user_data:notes_deleted', {
            count: deleted,
          });
        }

        this.logger.log(`User ${userId}: ${deleted} note(s) soft-deleted and queued for purge`);

        return;
      }

      const ids = rows.map((row) => row.id);

      // ⚠ BEFORE THE SOFT DELETE, NOT AFTER. `notes.source_note_id` is
      // `Restrict`, so `note.purge` cannot remove the row while a derived note
      // points at it — and the derived note may well be one of the rows in a
      // LATER batch, whose own purge is equally blocked. Clearing first turns
      // a mutual deadlock between two purge jobs into two ordinary deletes.
      //
      // No `ownerId` filter: a note derived from one of these may belong to
      // somebody the transcript was shared with. It keeps its text and loses
      // the link — see the handler's header.
      await this.prisma.note.updateMany({
        where: { sourceNoteId: { in: ids } },
        data: { sourceNoteId: null },
      });

      await this.prisma.note.updateMany({
        where: { id: { in: ids } },
        data: { status: 'deleting', deletedAt: new Date() },
      });

      await enqueuePurges(this.prisma, ids, NOTE_PURGE_JOB_TYPE, NOTE_SUBJECT_TYPE, (id) =>
        this.notes.enqueuePurge(id),
      );

      deleted += ids.length;
    }

    throw new Error(
      `Bulk note deletion for user ${userId} did not converge after ` +
        `${USER_DATA_PURGE_MAX_BATCHES} batches`,
    );
  }

  /**
   * Drop every `search_chunks` / `search_index_state` row for this user's
   * notes (#188, epic #165).
   *
   * ⚠ THIS IS NOT REDUNDANT WITH THE FAN-OUT ABOVE, and the reason is the same
   * one that makes every other step of the purge belt-and-braces about the
   * `Restrict` keys. `deleteNotes` soft-deletes each document and QUEUES a
   * per-item `note.purge`, and that handler calls `SearchIndexService.forget`
   * itself — so on the happy path this call finds nothing left to do. But those
   * jobs run LATER, and a job can exhaust its attempts. A user who pressed a
   * button that said their notes would be destroyed must not be left with the
   * TEXT of those notes sitting in `search_chunks` because a purge job three
   * hops away gave up quietly. Every document of this kind owned by this user
   * is on its way out, so deleting all of their index rows now is the same set
   * reached sooner, not a guess.
   *
   * ⚠ IT DELETES ROWS RATHER THAN FANNING OUT, which is the one place the
   * purge's usual "never reimplement byte deletion here" rule does not apply:
   * there are no bytes. A chunk is a row of text and a vector in this database,
   * with no object storage behind it and no provider copy to revoke — the whole
   * reason `transcript.purge` may not be shortcut is that it deletes
   * multi-gigabyte objects whose only remaining reference is the row this
   * handler would otherwise destroy first. Nothing of that shape exists here.
   *
   * ⚠ NOT CALLED FOR THE `files` SCOPE. An uploaded file is not a searchable
   * document in this epic — only transcripts and notes are chunked — so there
   * is nothing of its owner's in these tables to remove, and a sweep by owner
   * alone would delete the index rows of documents the user did NOT ask to
   * delete.
   *
   * Never throws into the purge: the documents are already soft-deleted and
   * queued, and failing a destructive job part-way because a cleanup read lost
   * a race would leave the user with a `failed` row and no idea which half ran.
   * A leftover index row is a storage cost the per-item purge still covers.
   */
  private async forgetFromSearchIndex(userId: string): Promise<void> {
    try {
      const forgotten = await this.searchIndex.forgetOwnerDocuments(userId, SEARCH_DOC_NOTE);

      if (forgotten > 0) {
        this.logger.log(
          `User ${userId}: ${forgotten} ${SEARCH_DOC_NOTE}(s) removed from the semantic index`,
        );
      }
    } catch (error) {
      this.logger.error(
        `User ${userId}: could not clear the semantic index for ${SEARCH_DOC_NOTE}s: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ===========================================================================
  // The `noteTemplates` category
  // ===========================================================================

  /** `noteTemplates` in `GET /api/user-data/summary`. */
  async summarizeNoteTemplates(userId: string): Promise<{ count: number }> {
    // `ownerId: userId`, never `ownerId: null` as well: a built-in template
    // belongs to the deployment, is in every account's catalogue, and no
    // permission any role holds can delete one. Counting them here would
    // promise a deletion this application will refuse.
    const count = await this.prisma.noteTemplate.count({ where: { ownerId: userId } });

    return { count };
  }

  // ===========================================================================
  // Step 4 — note templates
  // ===========================================================================

  /**
   * Delete the user's OWN custom templates, through the path that already knows
   * when a template must be archived instead.
   *
   * ⚠ REACHED BY `content` AND `everything` ONLY. The narrow `notes` scope
   * deliberately does not come here — a template is reusable configuration with
   * its own settings destination, not note content, and "Delete notes" silently
   * emptying a page the user did not open is the surprise a Danger Zone can
   * least afford. The category's `content: true` (below) carries the full
   * argument.
   *
   * ⚠ BUILT-INS ARE UNREACHABLE HERE BY CONSTRUCTION: the query filters on
   * `ownerId: userId`, and a built-in has `ownerId IS NULL`. It is not that
   * `NoteTemplatesService.remove` would refuse them (it would, with a 403) —
   * they are never selected, so no request to delete one is ever made.
   *
   * ⚠ SOME TEMPLATES WILL BE ARCHIVED RATHER THAN DELETED, AND THAT IS
   * CORRECT-BUT-TEMPORARY. `remove` archives while any note still names the
   * template, and step 2's notes are at that moment soft-deleted rather than
   * gone — their purge jobs are still queued. So a run that deletes notes and
   * templates together leaves the templates archived (invisible in the normal
   * catalogue, still the user's rows). A later run — this handler is
   * re-entrant, and `POST /api/user-data/deletions` is the button — finds the
   * notes actually gone and deletes them. Deleting them regardless was
   * rejected: it would put a second, contradictory answer to "may this template
   * go?" in this file, and the one in `note-templates.service.ts` exists so a
   * note never loses the record of what produced it.
   */
  async purgeNoteTemplates(userId: string): Promise<void> {
    let removed = 0;
    let archived = 0;
    const skipped = new Set<string>();

    for (let batch = 0; batch < USER_DATA_PURGE_MAX_BATCHES; batch += 1) {
      const rows = await this.prisma.noteTemplate.findMany({
        where: {
          ownerId: userId,
          ...(skipped.size > 0 ? { id: { notIn: [...skipped] } } : {}),
        },
        select: { id: true },
        take: USER_DATA_PURGE_BATCH,
      });

      if (rows.length === 0) {
        if (removed > 0 || archived > 0) {
          await auditUserData(this.prisma, userId, 'user_data:note_templates_deleted', {
            deleted: removed,
            archived,
          });
        }

        this.logger.log(
          `User ${userId}: ${removed} note template(s) deleted, ${archived} archived`,
        );

        return;
      }

      for (const row of rows) {
        try {
          const outcome = await this.templates.remove(userId, row.id);

          if (outcome.outcome === 'archived') {
            // ⚠ RECORDED AS SKIPPED so the next page moves past it. An
            // archived row still matches `ownerId: userId`, so without this
            // the query returns the same page forever and the batch bound
            // below would be the only thing stopping the loop.
            skipped.add(row.id);
            archived += 1;
          } else {
            removed += 1;
          }
        } catch (error) {
          // One damaged template must not stop the rest — the same posture
          // `notes.housekeeping` takes towards a single bad row. It is
          // recorded and skipped, and the user can run the deletion again.
          skipped.add(row.id);

          this.logger.warn(
            `Could not remove note template ${row.id} for user ${userId}: ${describe(error)}`,
          );
        }
      }
    }

    throw new Error(
      `Bulk note template deletion for user ${userId} did not converge after ` +
        `${USER_DATA_PURGE_MAX_BATCHES} batches`,
    );
  }
}
