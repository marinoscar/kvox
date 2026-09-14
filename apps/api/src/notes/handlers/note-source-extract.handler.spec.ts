// =============================================================================
// NoteSourceExtractHandler unit coverage (issue #51, epic #45)
// =============================================================================
//
// THE PROPERTY THIS SUITE PROTECTS IS "BOTH EXECUTORS LEAVE THE SAME ROW".
// A node-eligible handler has two execution paths — `process` on the API
// server, `persistNodeResult` after a node did the reading — and each is
// naturally tested on its own, which is exactly how they drift. So the central
// assertion here is a comparison: extract the SAME document both ways, and diff
// what was stored.
//
// The rest is the contract's halves, asserted as behaviour rather than shape:
//
//   * `nodeResultSchema` is a TRUST BOUNDARY, so the interesting cases are the
//     near-misses a real fork would produce — an empty success, a failure with
//     no reason, a reason this application has no sentence for — not
//     `undefined`.
//   * `persistNodeResult` is PERSIST-ONLY, so the assertion is that it never
//     downloads the source and never re-extracts. That rule is what keeps a
//     node's answer from being decorative.
//   * Permanent failures RETURN, they do not throw. A thrown encrypted-PDF
//     would burn the job's attempts rediscovering something already known, and
//     would reach the operator as an incident instead of reaching the user as
//     a sentence.
// =============================================================================

import type { Job, StorageObject } from '@prisma/client';
import { Readable } from 'node:stream';

import {
  bomTextFile,
  corruptPdf,
  encryptedPdf,
  multiPagePdf,
  scannedPdf,
  PDF_PAGE_ONE,
  PDF_PAGE_THREE,
} from '../../../test/fixtures/documents.fixture';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../../test/mocks/storage-provider.mock';
import type { StorageProvider } from '../../storage/providers/storage-provider.interface';
import { STORAGE_OBJECT_SUBJECT_TYPE } from '../../storage/storage-job-input';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { extractedTextStorageKey, EXTRACTION_METADATA_KEY } from '../source-metadata';
import { NoteSourceExtractHandler } from './note-source-extract.handler';

const OBJECT_ID = 'source-object-1';
const OWNER_ID = 'owner-1';
const JOB_ID = 'job-1';

describe('NoteSourceExtractHandler', () => {
  let prisma: MockPrismaService;
  let storage: jest.Mocked<StorageProvider>;
  let registry: JobHandlerRegistry;
  let objects: {
    put: jest.Mock;
    recordUploaded: jest.Mock;
  };
  let handler: NoteSourceExtractHandler;

  /** Whatever `put`/`recordUploaded` was asked to store, for the diff below. */
  let stored: { storageKey: string; text: string | null; via: 'put' | 'recordUploaded' } | null;

  function makeJob(overrides: Partial<Job> = {}): Job {
    return {
      id: JOB_ID,
      type: 'note.source.extract',
      subjectType: STORAGE_OBJECT_SUBJECT_TYPE,
      subjectId: OBJECT_ID,
      payload: { objectId: OBJECT_ID },
      ...overrides,
    } as Job;
  }

  function makeObject(overrides: Partial<StorageObject> = {}): StorageObject {
    return {
      id: OBJECT_ID,
      name: 'proposal.pdf',
      mimeType: 'application/pdf',
      storageKey: 'notes/sources/uploads/abc/source.pdf',
      uploadedById: OWNER_ID,
      managedBy: 'notes',
      metadata: null,
      size: BigInt(1024),
      ...overrides,
    } as StorageObject;
  }

  /** The metadata written onto the SOURCE object by the last update. */
  function writtenMetadata(): Record<string, unknown> {
    const calls = prisma.storageObject.update.mock.calls;

    expect(calls.length).toBeGreaterThan(0);

    return (calls[calls.length - 1][0] as { data: { metadata: Record<string, unknown> } }).data
      .metadata;
  }

  beforeEach(() => {
    prisma = createMockPrismaService();
    storage = createMockStorageProvider();
    registry = new JobHandlerRegistry();
    stored = null;

    objects = {
      put: jest.fn(async (input: { storageKey: string; body: Buffer }) => {
        stored = {
          storageKey: input.storageKey,
          text: input.body.toString('utf8'),
          via: 'put',
        };

        return { id: 'extracted-object-1' };
      }),
      recordUploaded: jest.fn(async (input: { storageKey: string }) => {
        stored = { storageKey: input.storageKey, text: null, via: 'recordUploaded' };

        return { id: 'extracted-object-1' };
      }),
    };

    handler = new NoteSourceExtractHandler(
      registry,
      prisma as never,
      objects as never,
      storage,
    );
  });

  // ===========================================================================
  // The two members that make this type node-eligible
  // ===========================================================================

  describe('node eligibility', () => {
    it('declares BOTH `nodeResultSchema` and `persistNodeResult`, never one', () => {
      // A schema with no persist function describes a payload nobody can store;
      // a persist function with no schema would trust an unvalidated remote
      // body. `JobHandlerRegistry` derives eligibility from the pair, so a
      // handler with exactly one is a type no node can ever claim.
      expect(handler.nodeResultSchema).toBeDefined();
      expect(typeof handler.persistNodeResult).toBe('function');
    });

    it('appears in the registry\'s node-eligible list, and not in its server-only one', () => {
      handler.onModuleInit();

      expect(registry.types()).toContain('note.source.extract');
      expect(registry.serverOnlyTypes()).not.toContain('note.source.extract');
    });

    it('derives the spec\'s output key, idempotently per job', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(makeObject());

      const first = await handler.deriveOutputKey(makeJob());
      const second = await handler.deriveOutputKey(makeJob());

      expect(first).toBe(`notes/sources/${OBJECT_ID}/extracted-${JOB_ID}.txt`);
      // A node asking again after a timed-out transfer must get the same key
      // rather than orphaning its first upload.
      expect(second).toBe(first);
    });

    it('declares a profile bounded well under the deployment default', () => {
      expect(handler.profile).toEqual({ maxRuntimeMs: 5 * 60 * 1000, maxAttempts: 3 });
    });
  });

  // ===========================================================================
  // The server path
  // ===========================================================================

  describe('process', () => {
    it('extracts a multi-page PDF and records the link the generator reads', async () => {
      const pdf = await multiPagePdf();

      prisma.storageObject.findUnique.mockResolvedValue(makeObject());
      storage.download.mockResolvedValue(Readable.from([pdf]));

      await handler.process(makeJob());

      expect(stored?.storageKey).toBe(extractedTextStorageKey(OBJECT_ID, JOB_ID));
      expect(stored?.text).toContain(PDF_PAGE_ONE);
      expect(stored?.text).toContain(PDF_PAGE_THREE);

      const metadata = writtenMetadata();

      // Spec §4.7's whole contract: the id at the TOP LEVEL, everything else
      // namespaced so two writers of this shared JSONB bag cannot collide.
      expect(metadata.extractedObjectId).toBe('extracted-object-1');
      expect(metadata[EXTRACTION_METADATA_KEY]).toMatchObject({
        status: 'extracted',
        pageCount: 3,
        encoding: 'pdf-text',
        extractedBy: 'server',
      });
    });

    it('strips a BOM from a text document before it can reach a prompt', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(
        makeObject({ name: 'brief.txt', mimeType: 'text/plain' }),
      );
      storage.download.mockResolvedValue(Readable.from([bomTextFile()]));

      await handler.process(makeJob());

      expect(stored?.text?.charCodeAt(0)).not.toBe(0xfeff);
      expect(writtenMetadata()[EXTRACTION_METADATA_KEY]).toMatchObject({
        encoding: 'utf-8-bom',
        pageCount: null,
      });
    });

    it('merges into `metadata` rather than replacing it', async () => {
      // `metadata` is a shared bag — the upload pipeline writes into it, the
      // metadata endpoint merges user keys into it. A replace would delete all
      // of that, and nothing about the extraction would look wrong afterwards.
      prisma.storageObject.findUnique.mockResolvedValue(
        makeObject({
          name: 'brief.md',
          mimeType: 'text/markdown',
          metadata: { uploadedFilename: 'brief.md', checksum: { sha256: 'abc' } },
        }),
      );
      storage.download.mockResolvedValue(Readable.from([Buffer.from('# Brief', 'utf8')]));

      await handler.process(makeJob());

      const metadata = writtenMetadata();

      expect(metadata.uploadedFilename).toBe('brief.md');
      expect(metadata.checksum).toEqual({ sha256: 'abc' });
      expect(metadata.extractedObjectId).toBe('extracted-object-1');
    });

    it('is a no-op when some executor already settled this document', async () => {
      // At-least-once delivery makes this ordinary, not exceptional. A second
      // extraction would write a text object the metadata no longer names.
      prisma.storageObject.findUnique.mockResolvedValue(
        makeObject({ metadata: { extractedObjectId: 'extracted-object-1' } }),
      );

      await handler.process(makeJob());

      expect(storage.download).not.toHaveBeenCalled();
      expect(objects.put).not.toHaveBeenCalled();
      expect(prisma.storageObject.update).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Failure is a domain outcome, not a crash
  // ===========================================================================

  describe('permanent failures', () => {
    async function extractAndReadReason(bytes: Buffer): Promise<Record<string, unknown>> {
      prisma.storageObject.findUnique.mockResolvedValue(makeObject());
      storage.download.mockResolvedValue(Readable.from([bytes]));

      await handler.process(makeJob());

      return writtenMetadata()[EXTRACTION_METADATA_KEY] as Record<string, unknown>;
    }

    it('records an encrypted PDF and RETURNS, storing no text object', async () => {
      const block = await extractAndReadReason(await encryptedPdf());

      expect(block).toMatchObject({ status: 'unextractable', reason: 'encrypted_pdf' });
      expect(String(block.message)).toMatch(/password/i);
      // No `extractedObjectId` is published, because there is nothing to point
      // it at — and `note.generate` reads exactly that key.
      expect(writtenMetadata().extractedObjectId).toBeUndefined();
      expect(objects.put).not.toHaveBeenCalled();
    });

    it('names images and states that OCR is not supported for a scanned PDF', async () => {
      const block = await extractAndReadReason(await scannedPdf());

      expect(block).toMatchObject({
        status: 'unextractable',
        reason: 'no_text_layer',
        pageCount: 2,
      });
      // "extraction failed" would tell the user to try again, and trying again
      // cannot work.
      expect(String(block.message)).toMatch(/images/i);
      expect(String(block.message)).toMatch(/OCR/);
    });

    it('records a corrupt file distinctly from the other two', async () => {
      const block = await extractAndReadReason(corruptPdf());

      expect(block).toMatchObject({ status: 'unextractable', reason: 'corrupt_file' });
    });

    it('does not throw for any of them', async () => {
      // Each `extractAndReadReason` above already awaited `process` without a
      // rejection; this states the property directly so a future change that
      // starts throwing fails on the rule rather than on a message.
      prisma.storageObject.findUnique.mockResolvedValue(makeObject());
      storage.download.mockResolvedValue(Readable.from([corruptPdf()]));

      await expect(handler.process(makeJob())).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // The node path
  // ===========================================================================

  describe('persistNodeResult', () => {
    const nodeResult = {
      outcome: 'extracted' as const,
      text: 'Text a worker node read off a presigned URL.',
      pageCount: 4,
      encoding: 'pdf-text' as const,
    };

    it('records the node\'s upload without downloading or re-extracting', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(makeObject());

      await handler.persistNodeResult(makeJob(), { ...nodeResult, reason: null });

      // PERSIST ONLY. The moment the server recomputes, the node's answer is
      // decorative and the reason for the node plane is gone.
      expect(storage.download).not.toHaveBeenCalled();
      expect(objects.put).not.toHaveBeenCalled();
      expect(objects.recordUploaded).toHaveBeenCalledWith(
        expect.objectContaining({
          storageKey: extractedTextStorageKey(OBJECT_ID, JOB_ID),
          ownerId: OWNER_ID,
        }),
      );
      expect(writtenMetadata()[EXTRACTION_METADATA_KEY]).toMatchObject({
        status: 'extracted',
        pageCount: 4,
        extractedBy: 'node',
      });
    });

    it('settles a permanent failure a node found, rather than burning attempts', async () => {
      prisma.storageObject.findUnique.mockResolvedValue(makeObject());

      await handler.persistNodeResult(makeJob(), {
        outcome: 'unextractable',
        text: null,
        reason: 'no_text_layer',
        pageCount: 9,
        encoding: null,
      });

      const block = writtenMetadata()[EXTRACTION_METADATA_KEY] as Record<string, unknown>;

      expect(block).toMatchObject({ status: 'unextractable', reason: 'no_text_layer' });
      expect(String(block.message)).toMatch(/OCR/);
    });

    describe('the trust boundary', () => {
      async function reject(body: unknown): Promise<void> {
        prisma.storageObject.findUnique.mockResolvedValue(makeObject());

        await expect(handler.persistNodeResult(makeJob(), body)).rejects.toBeDefined();

        // ⚠ AND NOTHING WAS WRITTEN. A schema that rejects after a partial
        // write is not a trust boundary.
        expect(prisma.storageObject.update).not.toHaveBeenCalled();
        expect(objects.recordUploaded).not.toHaveBeenCalled();
      }

      it('refuses an empty success — indistinguishable from a scan', async () => {
        await reject({ ...nodeResult, text: '', reason: null });
      });

      it('refuses a success with no text at all', async () => {
        await reject({ ...nodeResult, text: null, reason: null });
      });

      it('refuses a failure with no reason', async () => {
        await reject({
          outcome: 'unextractable',
          text: null,
          reason: null,
          pageCount: null,
          encoding: null,
        });
      });

      it('refuses a reason this application has no sentence for', async () => {
        await reject({
          outcome: 'unextractable',
          text: null,
          reason: 'ocr_needed',
          pageCount: null,
          encoding: null,
        });
      });

      it('refuses a contradictory body — text AND a failure reason', async () => {
        await reject({ ...nodeResult, reason: 'corrupt_file' });
      });

      it('refuses a missing page count, which is not the same as "no pages"', async () => {
        await reject({ outcome: 'extracted', text: 'hi', reason: null, encoding: 'utf-8' });
      });

      it('refuses an encoding this application does not produce', async () => {
        await reject({ ...nodeResult, reason: null, encoding: 'ebcdic' });
      });
    });
  });

  // ===========================================================================
  // ⚠ THE ASSERTION THIS FILE EXISTS FOR
  // ===========================================================================

  describe('one write, two paths', () => {
    it('stores the SAME text whichever executor claimed the job', async () => {
      const pdf = await multiPagePdf();

      // --- the server path: extract here -----------------------------------
      prisma.storageObject.findUnique.mockResolvedValue(makeObject());
      storage.download.mockResolvedValue(Readable.from([pdf]));

      await handler.process(makeJob());

      const serverText = stored?.text;
      const serverKey = stored?.storageKey;
      const serverBlock = writtenMetadata()[EXTRACTION_METADATA_KEY] as Record<string, unknown>;

      expect(typeof serverText).toBe('string');

      // --- the node path: the same document, read off-machine ---------------
      // The node's compute is exactly what the server just did, which is the
      // premise of node-eligibility: same bytes, same extractor, same answer.
      prisma = createMockPrismaService();
      storage = createMockStorageProvider();
      stored = null;
      handler = new NoteSourceExtractHandler(
        new JobHandlerRegistry(),
        prisma as never,
        objects as never,
        storage,
      );
      objects.recordUploaded.mockClear();
      prisma.storageObject.findUnique.mockResolvedValue(makeObject());

      await handler.persistNodeResult(makeJob(), {
        outcome: 'extracted',
        text: serverText,
        reason: null,
        pageCount: 3,
        encoding: 'pdf-text',
      });

      const nodeKey = objects.recordUploaded.mock.calls[0][0].storageKey as string;
      const nodeBlock = writtenMetadata()[EXTRACTION_METADATA_KEY] as Record<string, unknown>;

      // Same key, so the two paths cannot produce two objects for one job.
      expect(nodeKey).toBe(serverKey);
      // Same published link, so `note.generate` reads the same thing.
      expect(writtenMetadata().extractedObjectId).toBe('extracted-object-1');
      // Same recorded facts, except the one field whose whole purpose is to
      // record which executor ran — and the timestamp.
      expect({ ...nodeBlock, extractedBy: undefined, extractedAt: undefined }).toEqual({
        ...serverBlock,
        extractedBy: undefined,
        extractedAt: undefined,
      });
      expect(serverBlock.extractedBy).toBe('server');
      expect(nodeBlock.extractedBy).toBe('node');
    });
  });
});
