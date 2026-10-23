// =============================================================================
// kg.library_reconcile (#716, epic #708; ADR-0007)
// =============================================================================
//
// Library notes the graph has not read at their current version get an extraction again:
// a note edited in the product, an import that finished after `note_ready` was missed or
// declined, a model that was not configured at the time.
//
//   profile     { maxRuntimeMs: 2 min, maxAttempts: 2 }; it only ENQUEUES `kg.extract` jobs
//   server-only no nodeResultSchema, no persistNodeResult
//   subject     `user` / ownerId: one pending run per owner
//   payload     { ownerId, libraryId?, batchId? }
//   triggers    `kvox.notes.import_batch_settled` (a subscriber that only enqueues), the
//               retry action, and its own continuation when the cap was hit
//
// Selection (pure, `selectReconcileNotes`): the owner's library files whose note is `ready`
// with `current_version > coalesce(extracted_version, 0)`, whose library has `auto_extract`
// on, with no extraction in flight and no proposal already covering that version. Each is
// queued through `GraphExtractionService.enqueueForReadyNote(…, { bulk: true })`, which
// holds the gates: graph enabled, `graph:write`, the `autoExtract` preference, a resolvable
// model. At most 500 per run; a longer tail is a continuation run 30 s later.
//
// ⚠ Logs carry ids and counts only.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { KG_LIBRARY_RECONCILE_JOB_TYPE } from '../../graph/index.js';
import type { KvoxGraphDb } from '../../graph/index.js';
import { KVOX_JOBS, KVOX_PRISMA, type KvoxJob, type KvoxJobHandler, type KvoxJobProfile, type KvoxJobsPort } from '../../ports/index.js';
import { GraphExtractionService } from '../extraction/graph-extraction.service.js';
import { GraphReconcileEnqueuer } from '../library/graph-reconcile.enqueuer.js';
import { selectReconcileNotes, type ExtractionProposalFact } from '../library/extraction-state.js';

/** The most notes one run queues. */
export const KG_RECONCILE_CAP = 500;
/** Library files read per page. */
const PAGE = 1000;

const payloadSchema = z.object({
  ownerId: z.guid(),
  libraryId: z.guid().optional(),
  batchId: z.guid().optional(),
});
type ReconcilePayload = z.infer<typeof payloadSchema>;

/** Reads the payload; null when unreadable (the job is a no-op, never a failure loop). */
export function readKgLibraryReconcilePayload(payload: unknown): ReconcilePayload | null {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/**
 * KgLibraryReconcileHandler: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class KgLibraryReconcileHandler implements KvoxJobHandler, OnModuleInit {
  private readonly logger = new Logger(KgLibraryReconcileHandler.name);

  readonly type = KG_LIBRARY_RECONCILE_JOB_TYPE;
  readonly label = 'Extract new library notes into the graph';
  readonly profile: KvoxJobProfile = { maxRuntimeMs: 2 * 60_000, maxAttempts: 2 };

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly extraction: GraphExtractionService,
    private readonly enqueuer: GraphReconcileEnqueuer,
  ) {}

  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: KvoxJob): Promise<void> {
    const payload = readKgLibraryReconcilePayload(job.payload);
    if (!payload) {
      this.logger.warn(`${KG_LIBRARY_RECONCILE_JOB_TYPE} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }
    const { ownerId, libraryId, batchId } = payload;
    if (!(await this.extraction.canExtractFor(ownerId))) return;

    let queued = 0;
    let truncated = false;
    let cursor: string | null = null;
    for (;;) {
      const files: Array<{ id: string; noteId: string | null; extractedVersion: number | null }> =
        await this.prisma.noteLibraryFile.findMany({
          where: {
            noteId: { not: null },
            library: { ownerId, autoExtract: true, ...(libraryId ? { id: libraryId } : {}) },
            ...(batchId ? { batchItems: { some: { batchId } } } : {}),
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          select: { id: true, noteId: true, extractedVersion: true },
          orderBy: { id: 'asc' },
          take: PAGE,
        });
      if (files.length === 0) break;
      cursor = files[files.length - 1]!.id;

      const withNotes = files.flatMap((f) => (f.noteId ? [{ noteId: f.noteId, extractedVersion: f.extractedVersion }] : []));
      const noteIds = [...new Set(withNotes.map((f) => f.noteId))];
      const [notes, proposals] = await Promise.all([
        this.prisma.note.findMany({
          where: { id: { in: noteIds }, ownerId, deletedAt: null, status: 'ready' },
          select: { id: true, currentVersion: true },
        }),
        this.prisma.kgProposal.findMany({
          where: { ownerId, kind: 'extraction', noteId: { in: noteIds } },
          select: { noteId: true, noteVersion: true, status: true },
        }),
      ]);
      const versions = new Map<string, number>(notes.map((n: { id: string; currentVersion: number }) => [n.id, n.currentVersion]));
      const byNote = new Map<string, ExtractionProposalFact[]>();
      for (const p of proposals as Array<{ noteId: string | null; noteVersion: number | null; status: string }>) {
        if (!p.noteId) continue;
        const list = byNote.get(p.noteId) ?? [];
        list.push({ noteVersion: p.noteVersion, status: p.status });
        byNote.set(p.noteId, list);
      }

      const picked = selectReconcileNotes(withNotes, versions, byNote, KG_RECONCILE_CAP - queued);
      for (const noteId of picked.noteIds) {
        try {
          if (await this.extraction.enqueueForReadyNote(noteId, ownerId, { bulk: true, origin: 'library' })) queued += 1;
        } catch (error) {
          this.logger.warn(`Could not queue an extraction of note ${noteId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (picked.truncated) {
        truncated = true;
        break;
      }
      if (files.length < PAGE) break;
    }

    if (truncated) {
      await this.enqueuer.enqueue({ ownerId, ...(libraryId ? { libraryId } : {}), ...(batchId ? { batchId } : {}) }, { continuation: true });
    }
    this.logger.log(`${KG_LIBRARY_RECONCILE_JOB_TYPE} owner=${ownerId} queued=${queued} continued=${truncated}`);
  }
}
