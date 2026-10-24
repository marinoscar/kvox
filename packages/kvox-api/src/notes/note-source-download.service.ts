/**
 * `GET /api/notes/:id/source` — the original file an imported note was made from
 * (issue #732).
 *
 * ⚠ 404 NEVER 403, and every "nothing to hand back" is the same 404: a note that is not the
 * caller's, a note that does not exist, a version that does not exist, a note with no source
 * object and a source object that is gone or not ready. The caller cannot tell them apart.
 *
 * ⚠ VERSIONS DO NOT RECORD THEIR OWN SOURCE. `note_versions` has no object column: the
 * note row's `sourceObjectId` is switched to the newest import's file in the same update that
 * commits the version (`NoteVersionWriter`). `?version=<n>` therefore only has to NAME A
 * VERSION THAT EXISTS; the file served is the one the note currently points at.
 */

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { NoteSourceDownload } from '@marinoscar/kvox-contract/notes';

import { KVOX_PRISMA } from '../ports/index.js';
import { NoteAccessService } from './access/note-access.service.js';
import type { KvoxNotesDb } from './data/notes-db.js';
import { NoteObjectsService } from './note-objects.service.js';
import type { NotesActor } from './notes-actor.js';

/** How long the signed download URL lives, in seconds (15 minutes, as note exports). */
export const NOTE_SOURCE_DOWNLOAD_TTL_SECONDS = 15 * 60;

/**
 * Makes an uploaded file name safe as an attachment name: control characters and
 * path/reserved characters replaced, whitespace collapsed, bounded to 200 characters
 * with the extension kept. Falls back to `source`.
 *
 * @stability experimental
 */
export function noteSourceFilename(name: string | null | undefined): string {
  const cleaned = (name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["*/:<>?\\|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= 200) return cleaned.replace(/[. ]+$/, '') || 'source';

  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';

  return `${cleaned.slice(0, 200 - extension.length).trimEnd()}${extension}`;
}

/**
 * Signs a download for a note's source document.
 *
 * @stability experimental
 */
@Injectable()
export class NoteSourceDownloadService {
  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxNotesDb,
    private readonly access: NoteAccessService,
    private readonly objects: NoteObjectsService,
  ) {}

  /**
   * The signed download of the note's source file.
   *
   * @param id - the note.
   * @param user - the caller; only the owner passes `access.require`.
   * @param version - a version number that must exist; defaults to the current version.
   */
  async download(id: string, user: NotesActor, version?: number): Promise<NoteSourceDownload> {
    const { note } = await this.access.require(user.id, id, 'view', user.permissions);

    if (version !== undefined && version !== note.currentVersion) {
      const row = await this.prisma.noteVersion.findUnique({
        where: { noteId_version: { noteId: note.id, version } },
        select: { id: true },
      });

      if (!row) throw new NotFoundException('Note version not found');
    }

    if (note.sourceType !== 'document' || !note.sourceObjectId) {
      throw new NotFoundException('This note has no source document');
    }

    const info = await this.objects.describe(note.sourceObjectId);

    if (!info) throw new NotFoundException('The source document is no longer available');

    const filename = noteSourceFilename(info.name);
    const signed = await this.objects.signedUrlFor(
      note.sourceObjectId,
      NOTE_SOURCE_DOWNLOAD_TTL_SECONDS,
      filename,
    );

    if (!signed) throw new NotFoundException('The source document is no longer available');

    return {
      url: signed.url,
      filename,
      mimeType: signed.object.mimeType,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }
}
