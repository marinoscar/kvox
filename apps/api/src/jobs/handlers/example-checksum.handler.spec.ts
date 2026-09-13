// =============================================================================
// ExampleChecksumHandler unit coverage (issue #269, epic #254)
// =============================================================================
//
// THE PROPERTY THIS SUITE PROTECTS IS "BOTH EXECUTORS LEAVE THE SAME ROW".
// A node-eligible handler has two execution paths — `process` on the API
// server, `persistNodeResult` after a node computed the answer — and each is
// naturally tested on its own, which is exactly how they drift. So the
// central assertion here is a comparison: run both, and diff the write.
//
// The rest is the contract's two halves, asserted as behaviour rather than as
// shape:
//
//   * `nodeResultSchema` is a TRUST BOUNDARY, so the interesting cases are the
//     near-misses a real fork would actually produce — an upper-case digest, a
//     truncated one, a prefixed one — not `undefined`.
//   * `persistNodeResult` is PERSIST-ONLY, so the assertion is that it never
//     touches the storage provider. That rule is what keeps a node's answer
//     from being decorative, and it is invisible in a test that only checks
//     the resulting row.
//   * The write is a MERGE, because `metadata` is a shared JSONB bag. A
//     replace would silently delete whatever the upload pipeline put there,
//     and nothing about the checksum would look wrong afterwards.
// =============================================================================

import { Job, StorageObject } from '@prisma/client';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../../test/mocks/storage-provider.mock';
import { PrismaService } from '../../prisma/prisma.service';
import type { StorageProvider } from '../../storage/providers/storage-provider.interface';
import { STORAGE_OBJECT_SUBJECT_TYPE } from '../../storage/storage-job-input';
import { JobHandlerRegistry } from '../job-handler.registry';
import { CHECKSUM_METADATA_KEY, ExampleChecksumHandler } from './example-checksum.handler';

describe('ExampleChecksumHandler', () => {
  const OBJECT_ID = 'object-1';
  const CONTENT = 'the quick brown fox';
  const EXPECTED_SHA = createHash('sha256').update(CONTENT).digest('hex');

  let prisma: MockPrismaService;
  let storage: jest.Mocked<StorageProvider>;
  let registry: JobHandlerRegistry;
  let handler: ExampleChecksumHandler;

  function makeJob(overrides: Partial<Job> = {}): Job {
    return {
      id: 'job-1',
      type: 'example.checksum',
      subjectType: STORAGE_OBJECT_SUBJECT_TYPE,
      subjectId: OBJECT_ID,
      ...overrides,
    } as Job;
  }

  function makeObject(overrides: Partial<StorageObject> = {}): StorageObject {
    return {
      id: OBJECT_ID,
      name: 'fox.txt',
      size: BigInt(CONTENT.length),
      mimeType: 'text/plain',
      storageKey: 'uploads/1/fox.txt',
      storageProvider: 's3',
      bucket: 'test-bucket',
      status: 'ready',
      s3UploadId: null,
      metadata: null,
      uploadedById: 'someone',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as StorageObject;
  }

  /** What went into `storageObject.update`'s `metadata`. */
  const writtenMetadata = (): Record<string, any> =>
    (prisma.storageObject.update as jest.Mock).mock.calls[0][0].data.metadata;

  beforeEach(() => {
    prisma = createMockPrismaService();
    storage = createMockStorageProvider();
    registry = new JobHandlerRegistry();

    (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(makeObject());
    (prisma.storageObject.update as jest.Mock).mockResolvedValue(makeObject());
    storage.download.mockResolvedValue(Readable.from([Buffer.from(CONTENT)]));

    handler = new ExampleChecksumHandler(
      registry,
      prisma as unknown as PrismaService,
      storage
    );
  });

  // ===========================================================================
  // The contract
  // ===========================================================================

  describe('the handler contract', () => {
    it('self-registers under its own type from `onModuleInit`', () => {
      handler.onModuleInit();

      expect(registry.get('example.checksum')).toBe(handler);
    });

    it('is NODE-ELIGIBLE — it carries both optional members, so the registry says so', () => {
      // The one source of truth for node eligibility is the presence of the
      // pair; `serverOnlyTypes()` is its derivation, and this is the type that
      // finally makes a node's claim able to return anything.
      handler.onModuleInit();

      expect(handler.nodeResultSchema).toBeDefined();
      expect(typeof handler.persistNodeResult).toBe('function');
      expect(registry.serverOnlyTypes()).not.toContain('example.checksum');
    });
  });

  // ===========================================================================
  // The server-side path
  // ===========================================================================

  describe('process (in-process worker)', () => {
    it('streams the input object and writes the digest and byte count', async () => {
      await handler.process(makeJob());

      expect(storage.download).toHaveBeenCalledWith('uploads/1/fox.txt');
      expect(writtenMetadata()[CHECKSUM_METADATA_KEY]).toMatchObject({
        algorithm: 'sha256',
        sha256: EXPECTED_SHA,
        bytes: CONTENT.length,
        computedBy: 'server',
      });
    });

    it('hashes across chunk boundaries', async () => {
      // The streaming property, asserted the only way it can be: the same
      // bytes delivered in pieces must produce the same digest as one buffer.
      // A handler that hashed only the first chunk would pass every test that
      // used a single-chunk stream.
      storage.download.mockResolvedValue(
        Readable.from(['the ', 'quick ', 'brown ', 'fox'].map((part) => Buffer.from(part)))
      );

      await handler.process(makeJob());

      expect(writtenMetadata()[CHECKSUM_METADATA_KEY].sha256).toBe(EXPECTED_SHA);
      expect(writtenMetadata()[CHECKSUM_METADATA_KEY].bytes).toBe(CONTENT.length);
    });

    it('throws — and writes nothing — when the input cannot be resolved', async () => {
      // Throw to fail: the worker turns this into `Job.lastError` plus the
      // attempt budget, and the message names the job rather than an empty
      // path. See `storage-job-input.ts`.
      (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(handler.process(makeJob())).rejects.toMatchObject({
        reason: 'input_object_not_found',
      });

      expect(storage.download).not.toHaveBeenCalled();
      expect(prisma.storageObject.update).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // The node-computed path
  // ===========================================================================

  describe('persistNodeResult (a node computed it)', () => {
    const result = { sha256: EXPECTED_SHA, bytes: CONTENT.length };

    it('writes the node’s answer, marked as the node’s', async () => {
      await handler.persistNodeResult(makeJob(), result);

      expect(writtenMetadata()[CHECKSUM_METADATA_KEY]).toMatchObject({
        sha256: EXPECTED_SHA,
        bytes: CONTENT.length,
        computedBy: 'node',
      });
    });

    it('PERSISTS ONLY — it never re-downloads or re-hashes', async () => {
      // The rule from `job-handler.interface.ts`: the moment the server
      // recomputes, the node's answer is decorative and the whole reason for
      // the node plane is gone. Invisible in the resulting row, so it is
      // asserted against the provider.
      await handler.persistNodeResult(makeJob(), result);

      expect(storage.download).not.toHaveBeenCalled();
      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it.each([
      ['an upper-case digest', { sha256: EXPECTED_SHA.toUpperCase(), bytes: 4 }],
      ['a prefixed digest', { sha256: `sha256:${EXPECTED_SHA}`, bytes: 4 }],
      ['a truncated digest', { sha256: EXPECTED_SHA.slice(0, 32), bytes: 4 }],
      ['an empty digest', { sha256: '', bytes: 4 }],
      ['a negative byte count', { sha256: EXPECTED_SHA, bytes: -1 }],
      ['a fractional byte count', { sha256: EXPECTED_SHA, bytes: 1.5 }],
      ['a missing byte count', { sha256: EXPECTED_SHA }],
      ['not an object at all', 'e3b0c442'],
    ])('re-parses and REFUSES %s, writing nothing', async (_label, malformed) => {
      // Every one of these is a plausible output of a fork's own node
      // implementation — a hash library that upper-cases, a helper that
      // prefixes the algorithm — and all of them store perfectly while
      // silently breaking the one operation a checksum exists for.
      await expect(handler.persistNodeResult(makeJob(), malformed)).rejects.toBeDefined();

      expect(prisma.storageObject.update).not.toHaveBeenCalled();
    });

    it('throws when the object vanished between the node’s download and its result', async () => {
      (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(handler.persistNodeResult(makeJob(), result)).rejects.toMatchObject({
        reason: 'input_object_not_found',
      });
    });
  });

  // ===========================================================================
  // The one write, shared
  // ===========================================================================

  describe('the shared write', () => {
    it('leaves the SAME row state whichever executor ran the job', async () => {
      // The property the two paths exist to preserve. Everything but the
      // provenance fields must match, or a job's stored result depends on who
      // claimed it — which nothing else in this repository would catch.
      await handler.process(makeJob());
      const server = writtenMetadata()[CHECKSUM_METADATA_KEY];

      (prisma.storageObject.update as jest.Mock).mockClear();
      await handler.persistNodeResult(makeJob(), {
        sha256: EXPECTED_SHA,
        bytes: CONTENT.length,
      });
      const node = writtenMetadata()[CHECKSUM_METADATA_KEY];

      expect({ ...node, computedAt: null, computedBy: null }).toEqual({
        ...server,
        computedAt: null,
        computedBy: null,
      });
      expect(server.computedBy).toBe('server');
      expect(node.computedBy).toBe('node');
    });

    it('MERGES into `metadata` rather than replacing it', async () => {
      // `metadata` is shared with the upload-processing pipeline and with
      // `PATCH /storage/objects/:id/metadata`. A replace would delete their
      // keys and nothing about the checksum would look wrong afterwards.
      (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
        makeObject({ metadata: { processedBy: 'example-metadata', pages: 3 } as never })
      );

      await handler.process(makeJob());

      expect(writtenMetadata()).toMatchObject({
        processedBy: 'example-metadata',
        pages: 3,
        [CHECKSUM_METADATA_KEY]: { sha256: EXPECTED_SHA },
      });
    });

    it.each([
      ['null', null],
      ['an array', [1, 2, 3]],
    ])('survives a metadata column holding %s', async (_label, metadata) => {
      // JSONB permits both, and neither is spreadable into an object. A
      // handler that assumed a plain object would crash on a row somebody
      // else wrote.
      (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
        makeObject({ metadata: metadata as never })
      );

      await handler.process(makeJob());

      expect(writtenMetadata()[CHECKSUM_METADATA_KEY].sha256).toBe(EXPECTED_SHA);
    });

    it('logs — and stores — the observed count when the row’s size disagrees', async () => {
      // The row's `size` is 0 until post-processing for a simple upload, so a
      // mismatch is usually a stale column rather than a wrong node. Persist
      // what was actually read; report the discrepancy for a human.
      const warn = jest.spyOn(handler['logger'], 'warn').mockImplementation(() => undefined);
      (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
        makeObject({ size: BigInt(999) })
      );

      await handler.process(makeJob());

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('999'));
      expect(writtenMetadata()[CHECKSUM_METADATA_KEY].bytes).toBe(CONTENT.length);
    });
  });
});
