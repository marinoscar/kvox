import { Inject, Injectable } from '@nestjs/common';

import { KVOX_PRISMA } from '../../ports/index.js';
import type { KvoxNotesDb, NoteLibraryRow } from '../data/notes-db.js';

/** What a note's library says about graph extraction. @stability experimental */
export interface NoteLibraryPolicyView {
  /** The library the note's file belongs to. */
  libraryId: string;
  /** Extract graph proposals automatically. */
  autoExtract: boolean;
  /** Commit them without review. */
  autoCommit: boolean;
}

/**
 * The library policy of a note, for the graph slice. A note has a policy only when a
 * library file produced it; any other note answers `null` and keeps the user's defaults.
 *
 * @stability experimental
 */
@Injectable()
export class NoteLibraryPolicy {
  constructor(@Inject(KVOX_PRISMA) private readonly prisma: KvoxNotesDb) {}

  /**
   * @param noteId - the note.
   * @returns the policy of the library whose file became the note, or `null`.
   */
  async forNote(noteId: string): Promise<NoteLibraryPolicyView | null> {
    const file = await this.prisma.noteLibraryFile.findFirst({
      where: { noteId },
      include: { library: { select: { id: true, autoExtract: true, autoCommit: true } } },
    });
    const library = (
      file as { library?: Pick<NoteLibraryRow, 'id' | 'autoExtract' | 'autoCommit'> } | null
    )?.library;

    return library
      ? { libraryId: library.id, autoExtract: library.autoExtract, autoCommit: library.autoCommit }
      : null;
  }
}
