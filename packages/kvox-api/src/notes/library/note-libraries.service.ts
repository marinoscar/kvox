import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
  NOTE_IMPORT_ITEM_STAGES,
  NOTE_IMPORT_ITEM_STATUSES,
  normalizeLibraryPath,
  type CreateNoteImportBatchResponse,
  type NoteImportBatch,
  type NoteImportBatchItem,
  type NoteImportBatchItemsPage,
  type NoteImportBatchStatus,
  type NoteImportItemStage,
  type NoteImportItemStatus,
  type NoteLibrary,
  type NoteLibraryScanRequest,
  type NoteLibraryScanResponse,
  type UpdateNoteLibraryRequest,
} from '@marinoscar/kvox-contract/notes';

import { KVOX_PRISMA } from '../../ports/index.js';
import type {
  KvoxNotesDb,
  KvoxNotesDelegates,
  NoteImportBatchItemRow,
  NoteImportBatchRow,
  NoteLibraryFileRow,
  NoteLibraryRow,
  NoteProposalRef,
} from '../data/notes-db.js';
import type { NotesActor } from '../notes-actor.js';
import { diffLibraryManifest, type ExistingLibraryFile } from './note-library-diff.js';
import { deriveItemStage, pickProposal, recomputeBatchStatus } from './note-import-stage.js';

// =============================================================================
// NoteLibrariesService (issue #714, epic #708; docs/specs/notes.md §8.8)
// =============================================================================
//
// Libraries, the scan diff and the import batch views. Every read and write is scoped to
// the caller: a library or batch that is not theirs answers 404, never 403, like a note.
//
// UPLOADS ARE NOT HERE. The scan only answers which files to upload and records what went
// missing; the upload route (#715) creates the items and enqueues the job.
// =============================================================================

/** Message of the 404 for a library the caller does not own. */
export const NOTE_LIBRARY_NOT_FOUND_MESSAGE = 'Note library not found';
/** Message of the 404 for a batch the caller does not own. */
export const NOTE_IMPORT_BATCH_NOT_FOUND_MESSAGE = 'Import batch not found';

/** Ids per `IN (...)` statement, well under the driver's bind-parameter limit. */
const ID_CHUNK = 5000;

/** The most `approxInputTokens` an estimate reports. */
const MAX_APPROX_TOKENS = 1_000_000_000_000;

function chunks<T>(list: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function encodeItemCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function decodeItemCursor(cursor: string): string | null {
  try {
    const id = Buffer.from(cursor, 'base64url').toString('utf8');
    return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Libraries, scans and import batches.
 *
 * @stability experimental
 */
@Injectable()
export class NoteLibrariesService {
  constructor(@Inject(KVOX_PRISMA) private readonly prisma: KvoxNotesDb) {}

  // ---------------------------------------------------------------------------
  // Libraries
  // ---------------------------------------------------------------------------

  /** Creates a library. */
  async create(actor: NotesActor, name: string): Promise<NoteLibrary> {
    const row = await this.prisma.noteLibrary.create({ data: { ownerId: actor.id, name } });
    return this.toLibrary(row, new Map());
  }

  /** The caller's libraries, newest first, with file counts. */
  async list(actor: NotesActor): Promise<{ items: NoteLibrary[] }> {
    const rows = await this.prisma.noteLibrary.findMany({
      where: { ownerId: actor.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const counts = await this.fileCounts(rows.map((row) => row.id));

    return { items: rows.map((row) => this.toLibrary(row, counts)) };
  }

  /** One library of the caller's. @throws NotFoundException otherwise. */
  async get(actor: NotesActor, id: string): Promise<NoteLibrary> {
    const row = await this.owned(actor, id);
    return this.toLibrary(row, await this.fileCounts([row.id]));
  }

  /** Changes a library's name or policy. @throws NotFoundException when not the caller's. */
  async update(
    actor: NotesActor,
    id: string,
    patch: UpdateNoteLibraryRequest
  ): Promise<NoteLibrary> {
    await this.owned(actor, id);

    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.autoExtract !== undefined) data.autoExtract = patch.autoExtract;
    if (patch.autoCommit !== undefined) data.autoCommit = patch.autoCommit;

    const row = await this.prisma.noteLibrary.update({ where: { id }, data });
    return this.toLibrary(row, await this.fileCounts([id]));
  }

  /**
   * Deletes the library and its file rows. Notes stay; batches stay with `library_id`
   * set null by the foreign key.
   */
  async remove(actor: NotesActor, id: string): Promise<void> {
    await this.owned(actor, id);

    await this.prisma.$transaction(async (tx) => {
      await tx.noteLibraryFile.deleteMany({ where: { libraryId: id } });
      await tx.noteLibrary.delete({ where: { id } });
    });
  }

  // ---------------------------------------------------------------------------
  // Scan
  // ---------------------------------------------------------------------------

  /**
   * Diffs a manifest against the library, records the outcome and opens the batch the
   * uploads will belong to.
   */
  async scan(
    actor: NotesActor,
    id: string,
    request: NoteLibraryScanRequest
  ): Promise<NoteLibraryScanResponse> {
    await this.owned(actor, id);

    const complete = request.complete ?? true;
    const files = await this.prisma.noteLibraryFile.findMany({ where: { libraryId: id } });
    const existing: ExistingLibraryFile[] = files.map((file) => ({
      relativePath: file.relativePath,
      size: Number(file.size),
      mtimeMs: file.mtime.getTime(),
      contentHash: file.contentHash,
      status: file.status,
    }));
    const byPath = new Map<string, NoteLibraryFileRow>(
      files.map((file) => [file.relativePath, file])
    );

    const diff = diffLibraryManifest(existing, request.entries, { complete });

    // Sizes of the files to upload (the same last-wins normalisation as the diff).
    const sizeOf = new Map<string, number>();
    for (const entry of request.entries) {
      const path = normalizeLibraryPath(entry.path);
      if (path !== null) sizeOf.set(path, entry.size);
    }
    const bytes = diff.upload.reduce((sum, path) => sum + (sizeOf.get(path) ?? 0), 0);

    const idsOf = (paths: readonly string[]): string[] =>
      paths.flatMap((path) => {
        const file = byPath.get(path);
        return file ? [file.id] : [];
      });

    const now = new Date();
    const seenIds = [
      ...idsOf(diff.unchangedPaths),
      ...idsOf(diff.touched.map((t) => t.path)),
      ...idsOf(diff.upload),
      ...idsOf(diff.hashNeeded),
    ];
    const missingFiles = diff.missing.flatMap((path) => {
      const file = byPath.get(path);
      return file ? [file] : [];
    });
    const needsBatch = diff.upload.length > 0 || missingFiles.length > 0;

    const batchId = await this.prisma.$transaction(async (tx) => {
      for (const touched of diff.touched) {
        const file = byPath.get(touched.path);
        if (!file) continue;
        await tx.noteLibraryFile.update({
          where: { id: file.id },
          data: { size: BigInt(touched.size), mtime: new Date(touched.mtimeMs), lastSeenAt: now },
        });
      }

      // The touched rows were just stamped; the rest of the seen rows only need `lastSeenAt`.
      const touchedIds = new Set(idsOf(diff.touched.map((t) => t.path)));
      for (const part of chunks(seenIds.filter((fileId) => !touchedIds.has(fileId)))) {
        await tx.noteLibraryFile.updateMany({
          where: { id: { in: part } },
          data: { lastSeenAt: now },
        });
      }

      for (const part of chunks(missingFiles.map((file) => file.id))) {
        await tx.noteLibraryFile.updateMany({
          where: { id: { in: part } },
          data: { status: 'missing' },
        });
      }

      let createdBatchId: string | null = null;

      if (needsBatch) {
        const batch = await tx.noteImportBatch.create({
          data: {
            ownerId: actor.id,
            libraryId: id,
            status: diff.upload.length > 0 ? 'running' : 'completed',
            finishedAt: diff.upload.length > 0 ? null : now,
          },
        });
        createdBatchId = batch.id;

        if (missingFiles.length > 0) {
          await tx.noteImportBatchItem.createMany({
            data: missingFiles.map((file) => ({
              batchId: batch.id,
              fileId: file.id,
              filename: basename(file.relativePath),
              path: file.relativePath,
              action: 'missing',
              status: 'missing',
              noteId: file.noteId,
            })),
          });
        }
      }

      await tx.noteLibrary.update({ where: { id }, data: { lastScanAt: now } });

      return createdBatchId;
    });

    return {
      batchId,
      upload: diff.upload,
      hashNeeded: diff.hashNeeded,
      missing: diff.missing,
      unchanged: diff.unchanged,
      estimate: {
        files: diff.upload.length,
        bytes,
        approxInputTokens: Math.min(Math.ceil(bytes / 4), MAX_APPROX_TOKENS),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Batches
  // ---------------------------------------------------------------------------

  /** Opens an ad-hoc batch (a drop of files that belong to no library). */
  async createAdHocBatch(actor: NotesActor): Promise<CreateNoteImportBatchResponse> {
    const batch = await this.prisma.noteImportBatch.create({
      data: { ownerId: actor.id, status: 'running' },
    });
    return { batchId: batch.id };
  }

  /** The caller's recent batches, newest first. */
  async listBatches(
    actor: NotesActor,
    query: { libraryId?: string | undefined; limit: number }
  ): Promise<{ items: NoteImportBatch[] }> {
    const rows = await this.prisma.noteImportBatch.findMany({
      where: { ownerId: actor.id, ...(query.libraryId ? { libraryId: query.libraryId } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });

    return { items: await this.toBatches(rows) };
  }

  /** One batch with its counts. @throws NotFoundException when not the caller's. */
  async getBatch(actor: NotesActor, id: string): Promise<NoteImportBatch> {
    const row = await this.ownedBatch(actor, id);
    const [batch] = await this.toBatches([row]);
    return batch!;
  }

  /** A page of a batch's items, oldest first. */
  async listItems(
    actor: NotesActor,
    id: string,
    query: { status?: NoteImportItemStatus | undefined; cursor?: string | undefined; limit: number }
  ): Promise<NoteImportBatchItemsPage> {
    await this.ownedBatch(actor, id);

    const after = query.cursor ? decodeItemCursor(query.cursor) : null;
    const rows = await this.prisma.noteImportBatchItem.findMany({
      where: { batchId: id, ...(query.status ? { status: query.status } : {}) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });

    const page = rows.slice(0, query.limit);
    const proposals = await this.proposalsFor(page);

    return {
      items: page.map((row) => this.toItem(row, proposals)),
      nextCursor: rows.length > query.limit ? encodeItemCursor(page[page.length - 1]!.id) : null,
    };
  }

  /**
   * Recomputes a batch's status from its items and stores it (`finishedAt` once it settles).
   * Called by the import job (#715) after an item settles.
   *
   * @param batchId - the batch.
   * @param db - the client or a transaction client; defaults to the slice's.
   * @returns the status now stored, or `null` when the batch is gone.
   */
  async refreshBatchStatus(
    batchId: string,
    db: Pick<KvoxNotesDelegates, 'noteImportBatch' | 'noteImportBatchItem'> = this.prisma
  ): Promise<NoteImportBatchStatus | null> {
    const batch = await db.noteImportBatch.findUnique({ where: { id: batchId } });
    if (!batch) return null;

    const groups = await db.noteImportBatchItem.groupBy({
      by: ['status'],
      where: { batchId },
      _count: { _all: true },
    });
    const counts: Partial<Record<NoteImportItemStatus, number>> = {};
    for (const group of groups) counts[group.status as NoteImportItemStatus] = group._count._all;

    const next = recomputeBatchStatus(batch.status, counts);

    if (next !== batch.status) {
      await db.noteImportBatch.update({
        where: { id: batchId },
        data: { status: next, finishedAt: next === 'running' ? null : new Date() },
      });
    }

    return next;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async owned(actor: NotesActor, id: string): Promise<NoteLibraryRow> {
    const row = await this.prisma.noteLibrary.findFirst({ where: { id, ownerId: actor.id } });
    if (!row) throw new NotFoundException(NOTE_LIBRARY_NOT_FOUND_MESSAGE);
    return row;
  }

  private async ownedBatch(actor: NotesActor, id: string): Promise<NoteImportBatchRow> {
    const row = await this.prisma.noteImportBatch.findFirst({ where: { id, ownerId: actor.id } });
    if (!row) throw new NotFoundException(NOTE_IMPORT_BATCH_NOT_FOUND_MESSAGE);
    return row;
  }

  private async fileCounts(
    libraryIds: readonly string[]
  ): Promise<Map<string, Record<string, number>>> {
    const out = new Map<string, Record<string, number>>();
    if (libraryIds.length === 0) return out;

    const groups = await this.prisma.noteLibraryFile.groupBy({
      by: ['libraryId', 'status'],
      where: { libraryId: { in: [...libraryIds] } },
      _count: { _all: true },
    });
    for (const group of groups) {
      const entry = out.get(group.libraryId) ?? {};
      entry[group.status] = group._count._all;
      out.set(group.libraryId, entry);
    }

    return out;
  }

  private toLibrary(row: NoteLibraryRow, counts: Map<string, Record<string, number>>): NoteLibrary {
    const by = counts.get(row.id) ?? {};
    const n = (status: string): number => by[status] ?? 0;

    return {
      id: row.id,
      name: row.name,
      autoExtract: row.autoExtract,
      autoCommit: row.autoCommit,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastScanAt: row.lastScanAt ? row.lastScanAt.toISOString() : null,
      counts: {
        total: Object.values(by).reduce((sum, count) => sum + count, 0),
        imported: n('imported'),
        failed: n('failed'),
        missing: n('missing'),
        diverged: n('diverged'),
        unsupported: n('unsupported'),
        pending: n('pending') + n('importing'),
      },
    };
  }

  /** Proposals for the items' notes, grouped by note id (one query). */
  private async proposalsFor(
    items: readonly NoteImportBatchItemRow[]
  ): Promise<Map<string, NoteProposalRef[]>> {
    const noteIds = [
      ...new Set(
        items.flatMap((item) => (item.status === 'imported' && item.noteId ? [item.noteId] : []))
      ),
    ];
    const out = new Map<string, NoteProposalRef[]>();

    for (const part of chunks(noteIds)) {
      const rows = await this.prisma.kgProposal.findMany({
        where: { noteId: { in: part } },
        select: { id: true, noteId: true, noteVersion: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      for (const row of rows) {
        if (!row.noteId) continue;
        const list = out.get(row.noteId) ?? [];
        list.push(row);
        out.set(row.noteId, list);
      }
    }

    return out;
  }

  private toItem(
    row: NoteImportBatchItemRow,
    proposals: Map<string, NoteProposalRef[]>
  ): NoteImportBatchItem {
    const proposal =
      row.status === 'imported' && row.noteId
        ? pickProposal(proposals.get(row.noteId) ?? [], row.noteVersion)
        : null;

    return {
      id: row.id,
      filename: row.filename,
      path: row.path,
      action: row.action,
      status: row.status,
      stage: deriveItemStage(row.status, proposal?.status ?? null),
      failureReason: row.status === 'failed' ? row.failureReason : null,
      failureMessage: null,
      noteId: row.noteId,
      noteVersion: row.noteVersion,
      proposalId: proposal?.id ?? null,
      proposalStatus: proposal?.status ?? null,
      diverged: row.diverged,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async toBatches(rows: readonly NoteImportBatchRow[]): Promise<NoteImportBatch[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);

    const groups = await this.prisma.noteImportBatchItem.groupBy({
      by: ['batchId', 'status'],
      where: { batchId: { in: ids } },
      _count: { _all: true },
    });
    const counts = new Map<string, Record<NoteImportItemStatus, number>>();
    for (const group of groups) {
      const entry = counts.get(group.batchId) ?? zeroCounts(NOTE_IMPORT_ITEM_STATUSES);
      entry[group.status as NoteImportItemStatus] = group._count._all;
      counts.set(group.batchId, entry);
    }

    // Stages: every status maps to one stage except `imported`, which needs the proposal.
    const imported = await this.prisma.noteImportBatchItem.findMany({
      where: { batchId: { in: ids }, status: 'imported' },
      select: { batchId: true, status: true, noteId: true, noteVersion: true },
    });
    const proposals = await this.proposalsFor(imported as NoteImportBatchItemRow[]);
    const stages = new Map<string, Record<NoteImportItemStage, number>>();
    const stagesOf = (batchId: string): Record<NoteImportItemStage, number> => {
      let entry = stages.get(batchId);
      if (!entry) {
        entry = zeroCounts(NOTE_IMPORT_ITEM_STAGES);
        stages.set(batchId, entry);
      }
      return entry;
    };

    for (const row of rows) {
      const by = counts.get(row.id);
      if (!by) continue;
      for (const status of NOTE_IMPORT_ITEM_STATUSES) {
        if (status !== 'imported') stagesOf(row.id)[deriveItemStage(status, null)] += by[status];
      }
    }
    for (const item of imported) {
      const proposal = item.noteId
        ? pickProposal(proposals.get(item.noteId) ?? [], item.noteVersion)
        : null;
      stagesOf(item.batchId)[deriveItemStage('imported', proposal?.status ?? null)] += 1;
    }

    return rows.map((row) => ({
      id: row.id,
      libraryId: row.libraryId,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      counts: counts.get(row.id) ?? zeroCounts(NOTE_IMPORT_ITEM_STATUSES),
      stageCounts: stages.get(row.id) ?? zeroCounts(NOTE_IMPORT_ITEM_STAGES),
    }));
  }
}
