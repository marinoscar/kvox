import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { KVOX_PRISMA } from '../ports/index.js';
import type { KvoxNotesDb, KvoxNotesTx, NoteRow as Note } from './data/notes-db.js';
import { NOTE_CONFLICT_REASONS } from './dto/note.dto.js';
import type { NoteBodyFormat } from './dto/note-template.dto.js';

/**
 * What {@link NoteVersionWriter.commit} takes.
 *
 * @stability experimental
 * @internal
 */
export interface NoteVersionCommitInput {
  /** The note to move to its next version. */
  noteId: string;
  /** The `currentVersion` the caller last saw; the update claims the row only while it still matches. */
  baseVersion: number;
  /** The note's status as the caller saw it. `failed` becomes `ready` (a human body ends the failure). */
  noteStatus?: string;
  body: string;
  /** Written to BOTH the note and the new version row, together (#337). */
  bodyFormat: NoteBodyFormat;
  /** A title that rides along; sets `titleSource: 'user'`. Omit to leave title and provenance alone. */
  title?: string;
  kind: 'edit' | 'restore';
  /** A real author id, always: `null` means the AI on a version row. */
  authorId: string;
  summary?: string | null;
  restoredFromVersion?: number;
  clientBatchId?: string | null;
  /** When set, the note's `sourceType` becomes `document` and `sourceObjectId` switches in the same update. */
  sourceObjectId?: string;
}

/**
 * Writes a note's next version: the optimistic claim on `current_version` and the
 * `note_versions` row, together. Extracted from `NotesService.commitVersion` (#712)
 * so other writers (the library import job) share the one definition.
 *
 * Search indexing, events and audit stay with the caller, after the commit.
 *
 * @stability experimental
 * @internal
 */
@Injectable()
export class NoteVersionWriter {
  constructor(@Inject(KVOX_PRISMA) private readonly prisma: KvoxNotesDb) {}

  /**
   * Commits one version.
   *
   * @param input - the version to write.
   * @param tx - an open transaction to run inside; without one this opens its own.
   * @returns the note as the commit left it.
   * @throws ConflictException (`STALE_BASE_VERSION`) when `baseVersion` is no longer current.
   */
  async commit(input: NoteVersionCommitInput, tx?: KvoxNotesTx): Promise<Note> {
    if (tx) return this.run(tx, input);

    return this.prisma.$transaction((own) => this.run(own, input));
  }

  private async run(tx: KvoxNotesTx, input: NoteVersionCommitInput): Promise<Note> {
    const nextVersion = input.baseVersion + 1;

    const claimed = await tx.note.updateMany({
      where: {
        id: input.noteId,
        currentVersion: input.baseVersion,
        deletedAt: null,
      },
      data: {
        currentVersion: nextVersion,
        body: input.body,
        bodyFormat: input.bodyFormat,
        // ⚠ `titleSource` MOVES ONLY WITH THE TITLE. A body-only save (and a
        // restore, which supplies none) must leave the provenance exactly as
        // it was — otherwise every edit would quietly claim the user named a
        // note the AI or the template named, and the titling path would stop
        // renaming notes nobody ever titled.
        ...(input.title !== undefined
          ? { title: input.title, titleSource: 'user' as const }
          : {}),
        // A note whose body a human just wrote is no longer `failed`: the
        // failure was the generation's, and there is content now.
        ...(input.noteStatus === 'failed' ? { status: 'ready' as const, failureReason: null } : {}),
        ...(input.sourceObjectId !== undefined
          ? { sourceType: 'document' as const, sourceObjectId: input.sourceObjectId }
          : {}),
      },
    });

    if (claimed.count === 0) {
      const currentVersion =
        (await tx.note.findUnique({ where: { id: input.noteId } }))?.currentVersion ??
        input.baseVersion;

      throw new ConflictException({
        message:
          `This note is at version ${currentVersion}; you were editing version ${input.baseVersion}. ` +
          'Reload to see the current text, then re-apply your change.',
        details: { reason: NOTE_CONFLICT_REASONS.STALE_BASE_VERSION, currentVersion },
      });
    }

    await tx.noteVersion.create({
      data: {
        noteId: input.noteId,
        version: nextVersion,
        kind: input.kind,
        body: input.body,
        bodyFormat: input.bodyFormat,
        summary: input.summary ?? null,
        // ⚠ A REAL AUTHOR ID HERE, ALWAYS. `null` means the AI (spec §4.5) —
        // a convention, not a missing value — so a human edit recorded with a
        // null author would claim the model wrote it.
        authorId: input.authorId,
        restoredFromVersion: input.restoredFromVersion ?? null,
        clientBatchId: input.clientBatchId ?? null,
      },
    });

    const updated = await tx.note.findUnique({ where: { id: input.noteId } });

    // Unreachable — the guarded update above already proved the row is there.
    if (!updated) throw new NotFoundException('Note not found');

    return updated;
  }
}
