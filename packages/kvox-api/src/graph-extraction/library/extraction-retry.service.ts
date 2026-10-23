import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { GraphActor, KvoxGraphDb } from '../../graph/index.js';
import { KVOX_PRISMA } from '../../ports/index.js';
import { GraphExtractionService } from '../extraction/graph-extraction.service.js';
import { extractionStateOf, type ExtractionProposalFact } from './extraction-state.js';

/** The most notes one retry queues. */
export const RETRY_EXTRACTIONS_CAP = 500;

/**
 * Re-queues graph extraction for the notes of one import batch whose latest attempt at the current
 * version failed, or that were never extracted (#716). A person asked, so the auto-extract switches
 * are skipped; the graph switch, `graph:write` and a resolvable model still apply.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class ExtractionRetryService {
  private readonly logger = new Logger(ExtractionRetryService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly extraction: GraphExtractionService,
  ) {}

  /**
   * @param actor - the signed-in owner.
   * @param batchId - the import batch.
   * @returns how many notes were queued.
   * @throws NotFoundException when the batch is missing or not the caller's.
   */
  async retry(actor: GraphActor, batchId: string): Promise<{ requeued: number }> {
    const batch = await this.prisma.noteImportBatch.findFirst({ where: { id: batchId, ownerId: actor.id }, select: { id: true } });
    if (!batch) throw new NotFoundException('No such import batch, or not yours.');

    const items = await this.prisma.noteImportBatchItem.findMany({
      where: { batchId, noteId: { not: null } },
      select: { noteId: true },
    });
    const noteIds = [...new Set(items.flatMap((i) => (i.noteId ? [i.noteId] : [])))];
    if (noteIds.length === 0) return { requeued: 0 };

    const [notes, files, proposals] = await Promise.all([
      this.prisma.note.findMany({
        where: { id: { in: noteIds }, ownerId: actor.id, deletedAt: null, status: 'ready' },
        select: { id: true, currentVersion: true },
      }),
      this.prisma.noteLibraryFile.findMany({ where: { noteId: { in: noteIds } }, select: { noteId: true, extractedVersion: true } }),
      this.prisma.kgProposal.findMany({
        where: { ownerId: actor.id, kind: 'extraction', noteId: { in: noteIds } },
        select: { noteId: true, noteVersion: true, status: true },
      }),
    ]);
    const extracted = new Map<string, number | null>();
    for (const f of files as Array<{ noteId: string | null; extractedVersion: number | null }>) {
      if (f.noteId) extracted.set(f.noteId, f.extractedVersion);
    }
    const byNote = new Map<string, ExtractionProposalFact[]>();
    for (const p of proposals as Array<{ noteId: string | null; noteVersion: number | null; status: string }>) {
      if (!p.noteId) continue;
      byNote.set(p.noteId, [...(byNote.get(p.noteId) ?? []), { noteVersion: p.noteVersion, status: p.status }]);
    }

    let requeued = 0;
    for (const note of notes as Array<{ id: string; currentVersion: number }>) {
      if (requeued >= RETRY_EXTRACTIONS_CAP) break;
      const state = extractionStateOf(
        { currentVersion: note.currentVersion, extractedVersion: extracted.get(note.id) ?? null },
        byNote.get(note.id) ?? [],
      );
      if (state !== 'failed' && state !== 'pending') continue;
      try {
        if (await this.extraction.enqueueForReadyNote(note.id, actor.id, { bulk: true, origin: 'library', explicit: true })) requeued += 1;
      } catch (error) {
        this.logger.warn(`Could not re-queue the extraction of note ${note.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { requeued };
  }
}
