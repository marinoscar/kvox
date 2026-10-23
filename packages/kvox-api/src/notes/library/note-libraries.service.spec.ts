import { NotFoundException } from '@nestjs/common';

import type { KvoxNotesDb } from '../data/notes-db.js';
import { NoteLibrariesService } from './note-libraries.service.js';
import { NoteLibraryPolicy } from './note-library-policy.js';

const ACTOR = { id: 'user-1', permissions: ['notes:read', 'notes:write'] };
const LIB = '11111111-1111-4111-8111-111111111111';
const HASH = 'c'.repeat(64);

function fn() {
  return jest.fn();
}

function build() {
  const noteLibrary = { findFirst: fn(), findMany: fn(), create: fn(), update: fn(), delete: fn() };
  const noteLibraryFile = {
    findMany: fn(),
    findFirst: fn(),
    update: fn(),
    updateMany: fn(),
    deleteMany: fn(),
    groupBy: fn(),
  };
  const noteImportBatch = {
    findFirst: fn(),
    findMany: fn(),
    findUnique: fn(),
    create: fn(),
    update: fn(),
  };
  const noteImportBatchItem = { findMany: fn(), createMany: fn(), groupBy: fn() };
  const kgProposal = { findMany: fn() };
  const db = {
    noteLibrary,
    noteLibraryFile,
    noteImportBatch,
    noteImportBatchItem,
    kgProposal,
  } as Record<string, unknown>;
  db.$transaction = async (callback: (tx: unknown) => unknown) => callback(db);

  return {
    service: new NoteLibrariesService(db as unknown as KvoxNotesDb),
    policy: new NoteLibraryPolicy(db as unknown as KvoxNotesDb),
    noteLibrary,
    noteLibraryFile,
    noteImportBatch,
    noteImportBatchItem,
    kgProposal,
  };
}

function fileRow(id: string, path: string, over: Record<string, unknown> = {}) {
  return {
    id,
    libraryId: LIB,
    relativePath: path,
    size: 10n,
    mtime: new Date(1000),
    contentHash: HASH,
    noteId: `note-${id}`,
    status: 'imported',
    ...over,
  };
}

describe('NoteLibrariesService', () => {
  it('answers 404 for a library the caller does not own', async () => {
    const { service, noteLibrary } = build();
    noteLibrary.findFirst.mockResolvedValue(null);

    await expect(service.get(ACTOR, LIB)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.scan(ACTOR, LIB, { entries: [] })).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(noteLibrary.findFirst).toHaveBeenCalledWith({ where: { id: LIB, ownerId: ACTOR.id } });
  });

  it('lists libraries with counts grouped by status', async () => {
    const { service, noteLibrary, noteLibraryFile } = build();
    const now = new Date();
    noteLibrary.findMany.mockResolvedValue([
      {
        id: LIB,
        ownerId: ACTOR.id,
        name: 'Docs',
        autoExtract: true,
        autoCommit: false,
        lastScanAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    noteLibraryFile.groupBy.mockResolvedValue([
      { libraryId: LIB, status: 'imported', _count: { _all: 3 } },
      { libraryId: LIB, status: 'failed', _count: { _all: 1 } },
      { libraryId: LIB, status: 'importing', _count: { _all: 2 } },
    ]);

    const { items } = await service.list(ACTOR);

    expect(items[0]!.counts).toEqual({
      total: 6,
      imported: 3,
      failed: 1,
      missing: 0,
      diverged: 0,
      unsupported: 0,
      pending: 2,
    });
  });

  it('scan: touches, stamps unchanged, marks missing and opens a running batch', async () => {
    const { service, noteLibrary, noteLibraryFile, noteImportBatch, noteImportBatchItem } = build();
    noteLibrary.findFirst.mockResolvedValue({ id: LIB, ownerId: ACTOR.id });
    noteLibraryFile.findMany.mockResolvedValue([
      fileRow('f-same', 'same.md'),
      fileRow('f-touch', 'touch.md'),
      fileRow('f-gone', 'dir/gone.md'),
    ]);
    noteImportBatch.create.mockResolvedValue({ id: 'batch-1' });

    const result = await service.scan(ACTOR, LIB, {
      complete: true,
      entries: [
        { path: 'same.md', size: 10, mtime: 1000 },
        { path: 'touch.md', size: 10, mtime: 5000, sha256: HASH },
        { path: 'new.md', size: 400, mtime: 1 },
      ],
    });

    expect(result).toEqual({
      batchId: 'batch-1',
      upload: ['new.md'],
      hashNeeded: [],
      missing: ['dir/gone.md'],
      unchanged: 1,
      estimate: { files: 1, bytes: 400, approxInputTokens: 100 },
    });
    expect(noteLibraryFile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'f-touch' },
        data: expect.objectContaining({ size: 10n }),
      })
    );
    expect(noteLibraryFile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['f-same'] } } })
    );
    expect(noteLibraryFile.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['f-gone'] } },
      data: { status: 'missing' },
    });
    expect(noteImportBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ libraryId: LIB, status: 'running', finishedAt: null }),
    });
    expect(noteImportBatchItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          batchId: 'batch-1',
          fileId: 'f-gone',
          filename: 'gone.md',
          action: 'missing',
          status: 'missing',
          noteId: 'note-f-gone',
        }),
      ],
    });
    expect(noteLibrary.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: LIB } })
    );
  });

  it('scan: creates no batch when nothing is to upload or missing', async () => {
    const { service, noteLibrary, noteLibraryFile, noteImportBatch } = build();
    noteLibrary.findFirst.mockResolvedValue({ id: LIB });
    noteLibraryFile.findMany.mockResolvedValue([fileRow('f1', 'a.md')]);

    const result = await service.scan(ACTOR, LIB, {
      entries: [{ path: 'a.md', size: 10, mtime: 1000 }],
    });

    expect(result.batchId).toBeNull();
    expect(noteImportBatch.create).not.toHaveBeenCalled();
  });

  it('scan: a batch with only missing files is completed at once', async () => {
    const { service, noteLibrary, noteLibraryFile, noteImportBatch } = build();
    noteLibrary.findFirst.mockResolvedValue({ id: LIB });
    noteLibraryFile.findMany.mockResolvedValue([fileRow('f1', 'a.md')]);
    noteImportBatch.create.mockResolvedValue({ id: 'b2' });

    const result = await service.scan(ACTOR, LIB, { entries: [] });

    expect(result.batchId).toBe('b2');
    expect(noteImportBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'completed', finishedAt: expect.any(Date) }),
    });
  });

  it('batch detail derives stage counts from the proposals of imported items', async () => {
    const { service, noteImportBatch, noteImportBatchItem, kgProposal } = build();
    const now = new Date();
    noteImportBatch.findFirst.mockResolvedValue({
      id: 'b1',
      ownerId: ACTOR.id,
      libraryId: null,
      status: 'running',
      createdAt: now,
      finishedAt: null,
    });
    noteImportBatchItem.groupBy.mockResolvedValue([
      { batchId: 'b1', status: 'imported', _count: { _all: 2 } },
      { batchId: 'b1', status: 'queued', _count: { _all: 1 } },
      { batchId: 'b1', status: 'failed', _count: { _all: 1 } },
    ]);
    noteImportBatchItem.findMany.mockResolvedValue([
      { batchId: 'b1', status: 'imported', noteId: 'n1', noteVersion: 1 },
      { batchId: 'b1', status: 'imported', noteId: 'n2', noteVersion: 1 },
    ]);
    kgProposal.findMany.mockResolvedValue([
      { id: 'p1', noteId: 'n1', noteVersion: 1, status: 'committed', createdAt: now },
    ]);

    const batch = await service.getBatch(ACTOR, 'b1');

    expect(batch.counts).toMatchObject({ imported: 2, queued: 1, failed: 1, importing: 0 });
    expect(batch.stageCounts).toMatchObject({ in_graph: 1, parsed: 1, uploaded: 1, failed: 1 });
  });

  it('items page: cursor pagination and per-item proposal', async () => {
    const { service, noteImportBatch, noteImportBatchItem, kgProposal } = build();
    const now = new Date();
    noteImportBatch.findFirst.mockResolvedValue({ id: 'b1' });
    const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    noteImportBatchItem.findMany.mockResolvedValue(
      ids.map((id) => ({
        id,
        batchId: 'b1',
        filename: 'x.md',
        path: 'x.md',
        action: 'new',
        status: 'imported',
        noteId: 'n1',
        noteVersion: 1,
        diverged: false,
        failureReason: null,
        updatedAt: now,
      }))
    );
    kgProposal.findMany.mockResolvedValue([
      { id: 'p1', noteId: 'n1', noteVersion: 1, status: 'draft', createdAt: now },
    ]);

    const page = await service.listItems(ACTOR, 'b1', { limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      stage: 'extracted',
      proposalId: 'p1',
      proposalStatus: 'draft',
    });
    expect(page.nextCursor).not.toBeNull();

    await service.listItems(ACTOR, 'b1', { limit: 1, cursor: page.nextCursor! });
    expect(noteImportBatchItem.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: { id: ids[0] }, skip: 1 })
    );
  });

  it('refreshBatchStatus settles a batch with no queued items', async () => {
    const { service, noteImportBatch, noteImportBatchItem } = build();
    noteImportBatch.findUnique.mockResolvedValue({ id: 'b1', status: 'running' });
    noteImportBatchItem.groupBy.mockResolvedValue([
      { status: 'imported', _count: { _all: 2 } },
      { status: 'failed', _count: { _all: 1 } },
    ]);

    await expect(service.refreshBatchStatus('b1')).resolves.toBe('completed_with_errors');
    expect(noteImportBatch.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { status: 'completed_with_errors', finishedAt: expect.any(Date) },
    });
  });

  it('delete removes the file rows and the library', async () => {
    const { service, noteLibrary, noteLibraryFile } = build();
    noteLibrary.findFirst.mockResolvedValue({ id: LIB });

    await service.remove(ACTOR, LIB);

    expect(noteLibraryFile.deleteMany).toHaveBeenCalledWith({ where: { libraryId: LIB } });
    expect(noteLibrary.delete).toHaveBeenCalledWith({ where: { id: LIB } });
  });
});

describe('NoteLibraryPolicy', () => {
  it('reads the policy through the file that became the note', async () => {
    const { policy, noteLibraryFile } = build();
    noteLibraryFile.findFirst.mockResolvedValue({
      library: { id: LIB, autoExtract: true, autoCommit: false },
    });

    await expect(policy.forNote('n1')).resolves.toEqual({
      libraryId: LIB,
      autoExtract: true,
      autoCommit: false,
    });

    noteLibraryFile.findFirst.mockResolvedValue(null);
    await expect(policy.forNote('n2')).resolves.toBeNull();
  });
});
