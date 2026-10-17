import {
  bomTextFile,
  corruptPdf,
  encryptedPdf,
  multiPagePdf,
  scannedPdf,
  PDF_PAGE_ONE,
  PDF_PAGE_THREE,
} from '../../../src/notes/testing/document-fixtures.js';
import { NoteObjectsService } from '../../../src/notes/note-objects.service.js';
import { extractedTextStorageKey, EXTRACTION_METADATA_KEY } from '../../../src/notes/source-metadata.js';
import { NoteSourceExtractHandler } from '../../../src/notes/handlers/note-source-extract.handler.js';
import type { KvoxJob } from '../../../src/ports/index.js';
import {
  createFakeKvoxJobs,
  createInMemoryKvoxObjectStore,
  type InMemoryKvoxObjectStore,
} from '../../../src/testing/index.js';

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

const OWNER_ID = 'owner-1';
const JOB_ID = 'job-1';
const STORAGE_OBJECT_SUBJECT_TYPE = 'storage_object';

describe('NoteSourceExtractHandler', () => {
  let store: InMemoryKvoxObjectStore;
  let jobs: ReturnType<typeof createFakeKvoxJobs>;
  let handler: NoteSourceExtractHandler;
  let objectId: string;

  /** Puts the source document in the store, as the upload endpoint does. */
  async function upload(
    bytes: Buffer,
    overrides: { name?: string; mimeType?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<string> {
    const stored = await store.put({
      ownerId: OWNER_ID,
      key: 'notes/sources/uploads/abc/source.pdf',
      body: bytes,
      contentType: overrides.mimeType ?? 'application/pdf',
      managedBy: 'notes',
      name: overrides.name ?? 'proposal.pdf',
      ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
    });

    objectId = stored.objectId;

    return stored.objectId;
  }

  function makeJob(overrides: Partial<KvoxJob> = {}): KvoxJob {
    return {
      id: JOB_ID,
      type: 'note.source.extract',
      subjectType: STORAGE_OBJECT_SUBJECT_TYPE,
      subjectId: objectId,
      payload: { objectId },
      attempts: 1,
      orgId: null,
      ...overrides,
    };
  }

  /** The metadata the handler wrote onto the SOURCE object. */
  function writtenMetadata(): Record<string, unknown> {
    const metadata = store.objects.get(objectId)?.metadata;

    expect(metadata).toBeDefined();

    return metadata as Record<string, unknown>;
  }

  /** The extracted-text object the metadata names, as stored. */
  function extractedText(): string | null {
    const id = writtenMetadata().extractedObjectId as string | undefined;

    return id ? (store.objects.get(id)?.bytes.toString('utf8') ?? null) : null;
  }

  beforeEach(() => {
    store = createInMemoryKvoxObjectStore();
    jobs = createFakeKvoxJobs();

    handler = new NoteSourceExtractHandler(jobs, store, new NoteObjectsService(store));
  });

  describe('node eligibility', () => {
    it('declares BOTH `nodeResultSchema` and `persistNodeResult`, never one', () => {
      expect(handler.nodeResultSchema).toBeDefined();
      expect(typeof handler.persistNodeResult).toBe('function');
    });

    it('registers with the job port as a node-eligible handler that does not use AI', () => {
      handler.onModuleInit();

      const registered = jobs.handlers.find((entry) => entry.type === 'note.source.extract');

      expect(registered?.nodeResultSchema).toBeDefined();
      expect(registered?.usesAi).toBeUndefined();
    });

    it('derives the spec\'s output key, idempotently per job', async () => {
      await upload(await multiPagePdf());

      const first = await handler.deriveOutputKey(makeJob());
      const second = await handler.deriveOutputKey(makeJob());

      expect(first).toBe(`notes/sources/${objectId}/extracted-${JOB_ID}.txt`);
      expect(second).toBe(first);
    });

    it('declares a profile bounded well under the deployment default', () => {
      expect(handler.profile).toEqual({ maxRuntimeMs: 5 * 60 * 1000, maxAttempts: 3 });
    });
  });

  describe('the source object', () => {
    it('is named by the payload, or by the subject when the payload has no object id', async () => {
      await upload(await multiPagePdf());

      await handler.process(makeJob({ payload: {} }));

      expect(writtenMetadata()[EXTRACTION_METADATA_KEY]).toMatchObject({ status: 'extracted' });
    });

    it('is an error worth a retry when it does not exist', async () => {
      await expect(handler.process(makeJob({ payload: { objectId: 'missing' }, subjectId: 'missing' }))).rejects.toThrow(
        /does not exist/,
      );
    });

    it('is an error when the job names no object at all', async () => {
      await expect(handler.process(makeJob({ payload: {}, subjectId: null }))).rejects.toThrow(/names no source object/);
    });
  });

  describe('process', () => {
    it('extracts a multi-page PDF and records the link the generator reads', async () => {
      await upload(await multiPagePdf());

      await handler.process(makeJob());

      const metadata = writtenMetadata();
      const textObject = store.objects.get(metadata.extractedObjectId as string);

      expect(textObject?.key).toBe(extractedTextStorageKey(objectId, JOB_ID));
      expect(textObject?.managedBy).toBe('notes');
      expect(extractedText()).toContain(PDF_PAGE_ONE);
      expect(extractedText()).toContain(PDF_PAGE_THREE);
      expect(metadata[EXTRACTION_METADATA_KEY]).toMatchObject({
        status: 'extracted',
        pageCount: 3,
        encoding: 'pdf-text',
        extractedBy: 'server',
      });
    });

    it('strips a BOM from a text document before it can reach a prompt', async () => {
      await upload(bomTextFile(), { name: 'brief.txt', mimeType: 'text/plain' });

      await handler.process(makeJob());

      expect(extractedText()?.charCodeAt(0)).not.toBe(0xfeff);
      expect(writtenMetadata()[EXTRACTION_METADATA_KEY]).toMatchObject({
        encoding: 'utf-8-bom',
        pageCount: null,
      });
    });

    it('merges into `metadata` rather than replacing it', async () => {
      await upload(Buffer.from('# Brief', 'utf8'), {
        name: 'brief.md',
        mimeType: 'text/markdown',
        metadata: { uploadedFilename: 'brief.md', checksum: { sha256: 'abc' } },
      });

      await handler.process(makeJob());

      const metadata = writtenMetadata();

      expect(metadata.uploadedFilename).toBe('brief.md');
      expect(metadata.checksum).toEqual({ sha256: 'abc' });
      expect(typeof metadata.extractedObjectId).toBe('string');
    });

    it('is a no-op when some executor already settled this document', async () => {
      await upload(await multiPagePdf(), { metadata: { extractedObjectId: 'extracted-object-1' } });
      const before = store.objects.size;

      await handler.process(makeJob());

      expect(store.objects.size).toBe(before);
      expect(writtenMetadata()).toEqual({ extractedObjectId: 'extracted-object-1' });
    });
  });

  describe('permanent failures', () => {
    async function extractAndReadReason(bytes: Buffer): Promise<Record<string, unknown>> {
      await upload(bytes);

      await handler.process(makeJob());

      return writtenMetadata()[EXTRACTION_METADATA_KEY] as Record<string, unknown>;
    }

    it('records an encrypted PDF and RETURNS, storing no text object', async () => {
      const block = await extractAndReadReason(await encryptedPdf());

      expect(block).toMatchObject({ status: 'unextractable', reason: 'encrypted_pdf' });
      expect(String(block.message)).toMatch(/password/i);
      expect(writtenMetadata().extractedObjectId).toBeUndefined();
      expect(store.objects.size).toBe(1);
    });

    it('names images and states that OCR is not supported for a scanned PDF', async () => {
      const block = await extractAndReadReason(await scannedPdf());

      expect(block).toMatchObject({
        status: 'unextractable',
        reason: 'no_text_layer',
        pageCount: 2,
      });
      expect(String(block.message)).toMatch(/images/i);
      expect(String(block.message)).toMatch(/OCR/);
    });

    it('records a corrupt file distinctly from the other two', async () => {
      const block = await extractAndReadReason(corruptPdf());

      expect(block).toMatchObject({ status: 'unextractable', reason: 'corrupt_file' });
    });

    it('does not throw for any of them', async () => {
      await upload(corruptPdf());

      await expect(handler.process(makeJob())).resolves.toBeUndefined();
    });
  });

  describe('persistNodeResult', () => {
    const nodeResult = {
      outcome: 'extracted' as const,
      text: 'Text a worker node read off a presigned URL.',
      pageCount: 4,
      encoding: 'pdf-text' as const,
    };

    it('records the node\'s upload without downloading or re-extracting', async () => {
      await upload(await multiPagePdf());
      // The node PUT the text straight to the presigned URL for the key `deriveOutputKey` gave it.
      store.landBytes(extractedTextStorageKey(objectId, JOB_ID), Buffer.from(nodeResult.text, 'utf8'));

      await handler.persistNodeResult(makeJob(), { ...nodeResult, reason: null });

      const textObject = store.objects.get(writtenMetadata().extractedObjectId as string);

      expect(textObject?.key).toBe(extractedTextStorageKey(objectId, JOB_ID));
      expect(textObject?.ownerId).toBe(OWNER_ID);
      expect(writtenMetadata()[EXTRACTION_METADATA_KEY]).toMatchObject({
        status: 'extracted',
        pageCount: 4,
        extractedBy: 'node',
      });
    });

    it('settles a permanent failure a node found, rather than burning attempts', async () => {
      await upload(await multiPagePdf());

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

    it('fails when the node reports bytes that never landed in storage', async () => {
      await upload(await multiPagePdf());

      await expect(handler.persistNodeResult(makeJob(), { ...nodeResult, reason: null })).rejects.toThrow(
        /never landed in storage/,
      );
    });

    describe('the trust boundary', () => {
      async function reject(body: unknown): Promise<void> {
        await upload(await multiPagePdf());
        const before = JSON.stringify(store.objects.get(objectId)?.metadata ?? null);

        await expect(handler.persistNodeResult(makeJob(), body)).rejects.toBeDefined();

        expect(JSON.stringify(store.objects.get(objectId)?.metadata ?? null)).toBe(before);
        expect(store.objects.size).toBe(1);
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

  describe('one write, two paths', () => {
    it('stores the SAME text whichever executor claimed the job', async () => {
      await upload(await multiPagePdf());

      await handler.process(makeJob());

      const serverText = extractedText();
      const serverKey = store.objects.get(writtenMetadata().extractedObjectId as string)?.key?.replace(objectId, '<source>');
      const serverBlock = writtenMetadata()[EXTRACTION_METADATA_KEY] as Record<string, unknown>;

      expect(typeof serverText).toBe('string');

      // A fresh store and handler: the same document, claimed by a node this time.
      store = createInMemoryKvoxObjectStore();
      handler = new NoteSourceExtractHandler(createFakeKvoxJobs(), store, new NoteObjectsService(store));
      await upload(await multiPagePdf());
      store.landBytes(extractedTextStorageKey(objectId, JOB_ID), Buffer.from(serverText as string, 'utf8'));

      await handler.persistNodeResult(makeJob(), {
        outcome: 'extracted',
        text: serverText,
        reason: null,
        pageCount: 3,
        encoding: 'pdf-text',
      });

      const nodeKey = store.objects.get(writtenMetadata().extractedObjectId as string)?.key?.replace(objectId, '<source>');
      const nodeBlock = writtenMetadata()[EXTRACTION_METADATA_KEY] as Record<string, unknown>;

      expect(nodeKey).toBe(serverKey);
      expect(typeof writtenMetadata().extractedObjectId).toBe('string');
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
