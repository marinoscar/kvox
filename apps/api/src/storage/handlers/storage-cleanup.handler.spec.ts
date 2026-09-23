// =============================================================================
// Unit tests for the stale-upload sweep (issue #21)
// =============================================================================
//
// The bug these exist for: the sweep used to measure staleness from
// `created_at` against a hard-coded 24 hours, so a multi-GB recording uploaded
// from a phone across a day — paused on the train, resumed at home, 80% done —
// was aborted and DELETED on its first night. "When it started" says nothing
// about whether anybody is still pushing parts to it.
//
// So the two assertions that matter are: the query filters on `updatedAt`, and
// the window comes from configuration.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import type { Job } from '@prisma/client';

import { StorageCleanupHandler } from './storage-cleanup.handler';
import type { PrismaService } from '../../prisma/prisma.service';
import type { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { StorageProvider } from '../providers';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-09-14T12:00:00.000Z');

interface Candidate {
  id: string;
  storageKey: string;
  s3UploadId: string | null;
  updatedAt: Date;
}

function makeHandler(options: {
  candidates?: Candidate[];
  staleUploadHours?: number;
  abort?: jest.Mock;
  deleteRow?: jest.Mock;
}) {
  const findMany = jest.fn().mockResolvedValue(options.candidates ?? []);
  const deleteRow = options.deleteRow ?? jest.fn().mockResolvedValue({});

  const prisma = {
    storageObject: { findMany, delete: deleteRow },
  } as unknown as PrismaService;

  const abortMultipartUpload = options.abort ?? jest.fn().mockResolvedValue(undefined);
  const storageProvider = { abortMultipartUpload } as unknown as StorageProvider;

  const config = {
    get: jest.fn((key: string, fallback?: unknown) =>
      key === 'storage.staleUploadHours'
        ? (options.staleUploadHours ?? fallback)
        : fallback,
    ),
  } as unknown as ConfigService;

  const registry = { register: jest.fn() } as unknown as JobHandlerRegistry;

  const handler = new StorageCleanupHandler(
    registry,
    prisma,
    storageProvider,
    config,
  );

  return { handler, findMany, deleteRow, abortMultipartUpload, registry };
}

const stale = (hoursAgo: number, overrides: Partial<Candidate> = {}): Candidate => ({
  id: `obj-${hoursAgo}`,
  storageKey: `uploads/1/${hoursAgo}.m4a`,
  s3UploadId: `upload-${hoursAgo}`,
  updatedAt: new Date(NOW.getTime() - hoursAgo * HOUR),
  ...overrides,
});

describe('StorageCleanupHandler', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('registers itself on module init', () => {
    const { handler, registry } = makeHandler({});

    handler.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  // ⚠ THE CENTRAL ASSERTION. On `updatedAt`, not `createdAt`.
  it('selects candidates by last activity, not by when the upload started', async () => {
    const { handler, findMany } = makeHandler({ staleUploadHours: 72 });

    await handler.sweep();

    const where = findMany.mock.calls[0][0].where;

    expect(where.status).toEqual({ in: ['pending', 'uploading'] });
    expect(where.updatedAt).toEqual({ lt: new Date(NOW.getTime() - 72 * HOUR) });
    expect(where.createdAt).toBeUndefined();
  });

  // Issue #322: a managed object belongs to its module, whose `Restrict` FK
  // would reject the delete; that module reconciles its own uploads.
  it('never selects managed objects', async () => {
    const { handler, findMany } = makeHandler({ staleUploadHours: 72 });

    await handler.sweep();

    expect(findMany.mock.calls[0][0].where.managedBy).toBeNull();
  });

  it('defaults the window to 72 hours when nothing is configured', async () => {
    const { handler, findMany } = makeHandler({});

    await handler.sweep();

    expect(findMany.mock.calls[0][0].where.updatedAt).toEqual({
      lt: new Date(NOW.getTime() - 72 * HOUR),
    });
  });

  it('honours a shorter configured window', async () => {
    const { handler, findMany } = makeHandler({ staleUploadHours: 6 });

    await handler.sweep();

    expect(findMany.mock.calls[0][0].where.updatedAt).toEqual({
      lt: new Date(NOW.getTime() - 6 * HOUR),
    });
  });

  // An upload touched inside the window is not in the query's result set at
  // all — which is the whole mechanism, expressed as a test that would fail if
  // the predicate were ever loosened back to `createdAt`.
  it('leaves an upload touched inside the window alone, and removes an older one', async () => {
    const recent = stale(2); // touched two hours ago
    const abandoned = stale(100); // untouched for four days

    const findMany = jest.fn().mockImplementation(async (args: any) => {
      const cutoff: Date = args.where.updatedAt.lt;

      return [recent, abandoned].filter((row) => row.updatedAt < cutoff);
    });

    const { handler, deleteRow, abortMultipartUpload } = makeHandler({
      staleUploadHours: 72,
    });

    (handler as unknown as { prisma: { storageObject: { findMany: jest.Mock } } })
      .prisma.storageObject.findMany = findMany;

    const result = await handler.sweep();

    expect(result).toEqual({ removed: 1, failed: 0 });
    expect(deleteRow).toHaveBeenCalledTimes(1);
    expect(deleteRow).toHaveBeenCalledWith({ where: { id: abandoned.id } });
    expect(deleteRow).not.toHaveBeenCalledWith({ where: { id: recent.id } });

    // ⚠ AND ITS MULTIPART UPLOAD IS ABORTED. Uncompleted parts are billed
    // indefinitely and are invisible to ListObjects, so a deleted row with a
    // live upload behind it is a leak nothing can ever name again.
    expect(abortMultipartUpload).toHaveBeenCalledTimes(1);
    expect(abortMultipartUpload).toHaveBeenCalledWith(
      abandoned.storageKey,
      abandoned.s3UploadId,
    );
  });

  it('aborts before deleting, so a failed abort leaves a row to retry', async () => {
    const order: string[] = [];
    const abort = jest.fn().mockImplementation(async () => {
      order.push('abort');
    });
    const deleteRow = jest.fn().mockImplementation(async () => {
      order.push('delete');

      return {};
    });

    const { handler } = makeHandler({
      candidates: [stale(100)],
      abort,
      deleteRow,
    });

    await handler.sweep();

    expect(order).toEqual(['abort', 'delete']);
  });

  it('does not call abort for a simple upload with no multipart id', async () => {
    const { handler, abortMultipartUpload, deleteRow } = makeHandler({
      candidates: [stale(100, { s3UploadId: null })],
    });

    const result = await handler.sweep();

    expect(abortMultipartUpload).not.toHaveBeenCalled();
    expect(deleteRow).toHaveBeenCalledTimes(1);
    expect(result.removed).toBe(1);
  });

  it('counts one wedged upload without giving up on the rest', async () => {
    const abort = jest
      .fn()
      .mockRejectedValueOnce(new Error('wedged'))
      .mockResolvedValue(undefined);

    const { handler } = makeHandler({
      candidates: [stale(100), stale(101)],
      abort,
    });

    await expect(handler.sweep()).resolves.toEqual({ removed: 1, failed: 1 });
  });

  it('throws from process when every candidate failed, so the queue retries', async () => {
    const { handler } = makeHandler({
      candidates: [stale(100)],
      abort: jest.fn().mockRejectedValue(new Error('bucket unreachable')),
    });

    await expect(handler.process({ id: 'job-1' } as Job)).rejects.toThrow(
      /unreachable or misconfigured/,
    );
  });

  it('succeeds quietly when there is nothing to sweep', async () => {
    const { handler } = makeHandler({});

    await expect(handler.process({ id: 'job-1' } as Job)).resolves.toBeUndefined();
  });
});
