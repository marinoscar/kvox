// =============================================================================
// Real-Postgres test: `note.source.extract` on a worker node (issue #51)
// =============================================================================
//
// THE TEST THAT PROVES THE NODE PATH ACTUALLY EXISTS FOR THIS TYPE. Everything
// else in #51 verifies a slice: the extractor reads a PDF, the handler writes a
// row, the schema refuses a malformed body. This file runs the WHOLE path with
// nothing mocked that matters:
//
//     enqueue → claim as a node → mint a download URL → read the bytes
//     off-band → extract → PUT the text to the key the SERVER chose →
//     submit → validate → persist → settle
//
// `JobsService` writes the row, `JobClaimService`'s `FOR UPDATE SKIP LOCKED`
// statement takes it, `NodeDataPlaneService` mints both URLs,
// `NoteSourceExtractHandler` persists, `JobTerminalService` settles. The only
// substitution is the storage PROVIDER, and the substitute is a real
// implementation with signed URLs the node must actually present.
//
// THREE ASSERTIONS THIS FILE OWNS, none of which a mocked suite can make:
//
//   1. `note.source.extract` is genuinely CLAIMABLE BY A NODE. The claim
//      statement only returns a job whose type the registry reports as
//      node-eligible, so a handler that lost `nodeResultSchema` or
//      `persistNodeResult` would return an empty list here — the only place
//      that mistake is visible as behaviour rather than as a property.
//   2. A malformed result is refused and THE JOB IS NOT SETTLED: it is still
//      `running` under its lease afterwards, so a node can fix its client and
//      submit again.
//   3. ONE WRITE, TWO PATHS: the same document extracted on the server and
//      submitted by a node leaves the same stored text, byte for byte.
//
// THIS IS A `*.db.spec.ts` FILE, excluded from `npm test` and run by
// `npm run test:db`. It SKIPS cleanly when no Postgres is reachable — see
// `../jobs/db-test-support.ts`.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job, PrismaClient } from '@prisma/client';
import { createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { JobClaimService } from '../../src/jobs/job-claim.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobLeaseService } from '../../src/jobs/job-lease.service';
import { JobTerminalService } from '../../src/jobs/job-terminal.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { NodeOffloadService } from '../../src/jobs/node-offload.service';
import { ProviderThrottleService } from '../../src/jobs/provider-throttle.service';
import { ClaimJobsDto, NodeJobResultDto } from '../../src/nodes/dto/node-control-plane.dto';
import { NodeUploadUrlDto } from '../../src/nodes/dto/node-data-plane.dto';
import { NodeDataPlaneService } from '../../src/nodes/node-data-plane.service';
import { NodesService } from '../../src/nodes/nodes.service';
import { NOTE_SOURCE_EXTRACT_JOB_TYPE } from '../../src/notes/job-types';
import { extractDocumentText } from '../../src/notes/extraction';
import { NoteSourceExtractHandler } from '../../src/notes/handlers/note-source-extract.handler';
import { NoteObjectsService } from '../../src/notes/note-objects.service';
import {
  EXTRACTION_METADATA_KEY,
  extractedTextStorageKey,
} from '../../src/notes/source-metadata';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type {
  MultipartUploadInit,
  SignedPutUrlOptions,
  SignedUrlOptions,
  StorageProvider,
  StorageUploadOptions,
  StorageUploadResult,
  UploadPart,
  UploadedPart,
} from '../../src/storage/providers';
import { STORAGE_OBJECT_SUBJECT_TYPE } from '../../src/storage/storage-job-input';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { MARKDOWN_BODY, markdownFile, multiPagePdf, PDF_PAGE_TWO } from '../fixtures/documents.fixture';

const { describeWithDb } = resolveDbSuite('note-source-extract.db.spec');

// =============================================================================
// An IN-MEMORY storage provider — a real implementation, not a stub
// =============================================================================
//
// It keeps bytes in a Map and signs URLs the way an object store does: a verb,
// a key, an expiry, and an HMAC over all three, verified on use. That last part
// is what makes it worth writing instead of stubbing `getSignedDownloadUrl` to
// return a constant: it proves the node can actually READ AND WRITE THE BYTES
// with nothing but the strings it was handed — no key, no bucket, no credential
// — which is the entire claim of the data plane.
//
// In memory rather than on disk (the checksum suite's `LocalFileStorageProvider`
// uses a temp directory) because nothing here needs a file: the documents are
// kilobytes, and a Map removes the mkdir/rm bookkeeping and the chance of a
// leaked temp directory when a test fails.
// =============================================================================

class InMemorySignedStorage implements StorageProvider {
  private readonly secret = randomUUID();

  readonly objects = new Map<string, Buffer>();

  private sign(verb: string, key: string, expiresAtMs: number): string {
    return createHmac('sha256', this.secret).update(`${verb}:${key}:${expiresAtMs}`).digest('hex');
  }

  private mint(verb: 'GET' | 'PUT', key: string, expiresIn: number): string {
    const expiresAtMs = Date.now() + expiresIn * 1000;
    const url = new URL('memory://storage/object');

    url.searchParams.set('verb', verb);
    url.searchParams.set('key', key);
    url.searchParams.set('expires', String(expiresAtMs));
    url.searchParams.set('sig', this.sign(verb, key, expiresAtMs));

    return url.toString();
  }

  private open(signedUrl: string, expectedVerb: 'GET' | 'PUT'): string {
    const url = new URL(signedUrl);
    const verb = url.searchParams.get('verb') ?? '';
    const key = url.searchParams.get('key') ?? '';
    const expiresAtMs = Number(url.searchParams.get('expires'));

    if (url.searchParams.get('sig') !== this.sign(verb, key, expiresAtMs)) {
      throw new Error('signature mismatch');
    }

    if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) {
      throw new Error('signed url expired');
    }

    if (verb !== expectedVerb) {
      throw new Error(`this url is signed for ${verb}, not ${expectedVerb}`);
    }

    return key;
  }

  /** What a NODE does with a signed GET: present it, get bytes. */
  fetchSigned(signedUrl: string): Buffer {
    const key = this.open(signedUrl, 'GET');
    const bytes = this.objects.get(key);

    if (!bytes) throw new Error(`no object at ${key}`);

    return bytes;
  }

  /** What a NODE does with a signed PUT: send bytes, hold no credential. */
  putSigned(signedUrl: string, body: Buffer): void {
    this.objects.set(this.open(signedUrl, 'PUT'), body);
  }

  /** Seeds an object outside the provider API, as a finished upload leaves. */
  seed(key: string, body: Buffer): void {
    this.objects.set(key, body);
  }

  async getSignedDownloadUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    return this.mint('GET', key, options?.expiresIn ?? 3600);
  }

  async getSignedPutUrl(key: string, options?: SignedPutUrlOptions): Promise<string> {
    return this.mint('PUT', key, options?.expiresIn ?? 3600);
  }

  async download(key: string): Promise<Readable> {
    const bytes = this.objects.get(key);

    if (!bytes) throw new Error(`no object at ${key}`);

    return Readable.from([bytes]);
  }

  async upload(
    key: string,
    stream: Readable,
    _options: StorageUploadOptions,
  ): Promise<StorageUploadResult> {
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }

    this.objects.set(key, Buffer.concat(chunks));

    return { key, bucket: 'memory', location: `memory://${key}` };
  }

  async initMultipartUpload(key: string): Promise<MultipartUploadInit> {
    return { uploadId: 'memory-upload', key };
  }

  async getSignedUploadUrl(key: string): Promise<string> {
    return this.mint('PUT', key, 3600);
  }

  async completeMultipartUpload(
    key: string,
    _uploadId: string,
    _parts: UploadPart[],
  ): Promise<StorageUploadResult> {
    return { key, bucket: 'memory', location: `memory://${key}` };
  }

  async abortMultipartUpload(): Promise<void> {}

  async listParts(): Promise<UploadedPart[]> {
    return [];
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async getMetadata(): Promise<Record<string, string> | null> {
    return {};
  }

  async setMetadata(): Promise<void> {}

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  getBucket(): string {
    return 'memory';
  }
}

describeWithDb('note.source.extract end to end on a worker node (real Postgres)', () => {
  /** Every row this suite creates is prefixed, so cleanup deletes only its own. */
  const PREFIX = `test.notesource.${process.pid}.`;
  const OWNER_EMAIL = `${PREFIX}owner@example.test`;
  const JOB_TYPE = NOTE_SOURCE_EXTRACT_JOB_TYPE;

  let prisma: PrismaClient;
  let storage: InMemorySignedStorage;
  let registry: JobHandlerRegistry;
  let handler: NoteSourceExtractHandler;
  let jobs: JobsService;
  let nodes: NodesService;
  let dataPlane: NodeDataPlaneService;
  let ownerId: string;
  let nodeId: string;

  const config = {
    get: (key: string, fallback?: unknown) =>
      key === 'storage.signedUrlExpiry' ? 120 : fallback,
  } as unknown as ConfigService;

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();

    storage = new InMemorySignedStorage();
    registry = new JobHandlerRegistry();

    const service = prisma as unknown as PrismaService;

    handler = new NoteSourceExtractHandler(
      registry,
      service,
      new NoteObjectsService(service, { deleteManagedObject: jest.fn() } as never, storage),
      storage,
    );

    // Self-registration, exactly as `NotesModule` triggers it — this is what
    // makes the type node-eligible and therefore claimable at all.
    handler.onModuleInit();

    jobs = new JobsService(service);
    nodes = new NodesService(
      service,
      config,
      new JobClaimService(service),
      new JobTerminalService(
        service,
        config,
        new ProviderThrottleService(config),
        new EventEmitter2(),
        registry,
      ),
      new JobLeaseService(service),
      registry,
      new NodeOffloadService(registry, {
        getNodesPolicy: async () => ({ ...DEFAULT_SYSTEM_SETTINGS.nodes }),
      } as unknown as SystemSettingsService),
    );
    dataPlane = new NodeDataPlaneService(service, config, nodes, storage, registry);

    const owner = await prisma.user.create({
      data: { email: OWNER_EMAIL, displayName: 'note source suite' },
    });
    ownerId = owner.id;

    const node = await prisma.workerNode.create({
      data: {
        name: `${PREFIX}node`,
        hostname: 'extract-box',
        platform: 'linux-x64',
        cliVersion: '0.0.0-test',
        eligibleTypes: [JOB_TYPE],
        concurrency: 4,
        status: 'online',
        createdById: ownerId,
      },
    });
    nodeId = node.id;
  });

  afterEach(async () => {
    await prisma.job.deleteMany({ where: { type: JOB_TYPE } });
    await prisma.storageObject.deleteMany({ where: { name: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await prisma?.job.deleteMany({ where: { type: JOB_TYPE } });
    await prisma?.storageObject.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma?.workerNode.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma?.user.deleteMany({ where: { email: OWNER_EMAIL } });
    await prisma?.$disconnect();
  });

  /** A stored source document with real bytes behind it, `managed_by: 'notes'`. */
  async function seedDocument(content: Buffer, mimeType: string): Promise<string> {
    const storageKey = `${PREFIX}notes/sources/uploads/${randomUUID()}/source`;
    storage.seed(storageKey, content);

    const object = await prisma.storageObject.create({
      data: {
        name: `${PREFIX}document`,
        size: BigInt(content.length),
        mimeType,
        storageKey,
        storageProvider: 'memory',
        bucket: 'memory',
        status: 'ready',
        managedBy: 'notes',
        uploadedById: ownerId,
      },
    });

    return object.id;
  }

  const claimOne = (): Promise<Job[]> =>
    nodes.claimJobs(ownerId, nodeId, { limit: 1 } as ClaimJobsDto);

  const enqueue = (objectId: string) =>
    jobs.enqueue({
      type: JOB_TYPE,
      reason: 'upload',
      subjectType: STORAGE_OBJECT_SUBJECT_TYPE,
      subjectId: objectId,
      payload: { objectId },
    });

  /**
   * What the worker node itself does. It is handed the job and NOTHING else —
   * no client, no provider, no bucket, no key — and it gets its bytes in and
   * out through the two URLs the server minted for it.
   */
  async function runNode(job: Job, mimeType: 'application/pdf' | 'text/markdown') {
    const grant = await dataPlane.createDownloadUrl(ownerId, nodeId, job.id);

    // What a node receives must already be short-lived, whatever the
    // deployment configured — asserted here because this is the moment it
    // matters.
    expect(grant.expiresIn).toBeGreaterThanOrEqual(60);
    expect(grant.expiresIn).toBeLessThanOrEqual(900);

    const bytes = storage.fetchSigned(grant.url);
    const outcome = await extractDocumentText(new Uint8Array(bytes), mimeType);

    if (outcome.outcome === 'unextractable') {
      return { outcome: 'unextractable' as const, text: null, reason: outcome.reason, pageCount: outcome.pageCount, encoding: null };
    }

    const target = await dataPlane.createUploadTarget(ownerId, nodeId, job.id, {
      contentType: 'text/plain',
    } as NodeUploadUrlDto);

    // ⚠ THE SERVER CHOSE THE KEY, NOT THE NODE. `deriveOutputKey` is what puts
    // the extracted text inside a prefix this module owns; a node that could
    // name its own key could park the artifact anywhere.
    storage.putSigned(target.url, Buffer.from(outcome.text, 'utf8'));

    return {
      outcome: 'extracted' as const,
      text: outcome.text,
      reason: null,
      pageCount: outcome.pageCount,
      encoding: outcome.encoding,
      key: target.key,
    };
  }

  const readMetadata = async (objectId: string): Promise<Record<string, any>> => {
    const row = await prisma.storageObject.findUniqueOrThrow({ where: { id: objectId } });

    return (row.metadata ?? {}) as Record<string, any>;
  };

  // ===========================================================================
  // The whole path
  // ===========================================================================

  it('runs enqueue → claim → download → extract → upload → submit → persist', async () => {
    const objectId = await seedDocument(await multiPagePdf(), 'application/pdf');
    const enqueued = await enqueue(objectId);

    const [claimed] = await claimOne();

    // ⚠ THE CLAIM IS THE PROOF OF NODE-ELIGIBILITY. The claim statement only
    // returns a job whose type the registry reports as node-eligible, so a
    // handler that lost either of its two members would return nothing here.
    expect(claimed?.id).toBe(enqueued.id);
    expect(claimed.executor).toBe('node');
    expect(claimed.claimedByNodeId).toBe(nodeId);

    const computed = await runNode(claimed, 'application/pdf');

    expect(computed.outcome).toBe('extracted');
    expect(computed.text).toContain(PDF_PAGE_TWO);
    // The spec's key, chosen by the SERVER (spec §4.7).
    expect(computed.key).toBe(extractedTextStorageKey(objectId, claimed.id));

    const settlement = await nodes.submitResult(ownerId, nodeId, claimed.id, {
      type: JOB_TYPE,
      result: {
        outcome: computed.outcome,
        text: computed.text,
        reason: computed.reason,
        pageCount: computed.pageCount,
        encoding: computed.encoding,
      },
    } as NodeJobResultDto);

    expect(settlement.outcome).toBe('succeeded');
    expect(settlement.willRetry).toBe(false);

    const settled = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(settled.status).toBe('succeeded');

    // The link `note.generate` reads, pointing at a row pointing at real bytes.
    const metadata = await readMetadata(objectId);
    const extractedId = metadata.extractedObjectId as string;

    expect(typeof extractedId).toBe('string');
    expect(metadata[EXTRACTION_METADATA_KEY]).toMatchObject({
      status: 'extracted',
      pageCount: 3,
      encoding: 'pdf-text',
      extractedBy: 'node',
    });

    const extracted = await prisma.storageObject.findUniqueOrThrow({
      where: { id: extractedId },
    });

    // Managed by this module, so the generic list hides it and the generic
    // DELETE refuses it — the same protection the upload itself gets.
    expect(extracted.managedBy).toBe('notes');
    expect(extracted.uploadedById).toBe(ownerId);
    expect(storage.objects.get(extracted.storageKey)?.toString('utf8')).toBe(computed.text);
  });

  // ===========================================================================
  // The trust boundary
  // ===========================================================================

  it('rejects a malformed result and does NOT settle the job', async () => {
    const objectId = await seedDocument(markdownFile(), 'text/markdown');
    await enqueue(objectId);

    const [claimed] = await claimOne();
    const computed = await runNode(claimed, 'text/markdown');

    await expect(
      nodes.submitResult(ownerId, nodeId, claimed.id, {
        type: JOB_TYPE,
        // An empty success: indistinguishable from a scanned PDF, and the one
        // body this schema must refuse.
        result: { outcome: 'extracted', text: '', reason: null, pageCount: null, encoding: 'utf-8' },
      } as NodeJobResultDto),
    ).rejects.toMatchObject({ status: 400 });

    // NOTHING happened: no metadata, and the job is still RUNNING under its
    // lease, so the node may fix its client and submit again.
    expect(await readMetadata(objectId)).toEqual({});

    const row = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(row.status).toBe('running');

    // …and the corrected submission lands.
    await expect(
      nodes.submitResult(ownerId, nodeId, claimed.id, {
        type: JOB_TYPE,
        result: {
          outcome: computed.outcome,
          text: computed.text,
          reason: computed.reason,
          pageCount: computed.pageCount,
          encoding: computed.encoding,
        },
      } as NodeJobResultDto),
    ).resolves.toMatchObject({ outcome: 'succeeded' });
  });

  // ===========================================================================
  // ⚠ ONE WRITE, TWO PATHS
  // ===========================================================================

  it('stores the same text whether a node or the server did the reading', async () => {
    // --- the node path ----------------------------------------------------
    const nodeObjectId = await seedDocument(markdownFile(), 'text/markdown');
    await enqueue(nodeObjectId);

    const [claimed] = await claimOne();
    const computed = await runNode(claimed, 'text/markdown');

    await nodes.submitResult(ownerId, nodeId, claimed.id, {
      type: JOB_TYPE,
      result: {
        outcome: computed.outcome,
        text: computed.text,
        reason: computed.reason,
        pageCount: computed.pageCount,
        encoding: computed.encoding,
      },
    } as NodeJobResultDto);

    // --- the server path, same document -----------------------------------
    const serverObjectId = await seedDocument(markdownFile(), 'text/markdown');
    const serverJob = await enqueue(serverObjectId);

    await handler.process(serverJob);

    const nodeMetadata = await readMetadata(nodeObjectId);
    const serverMetadata = await readMetadata(serverObjectId);

    const nodeText = storage.objects
      .get(
        (
          await prisma.storageObject.findUniqueOrThrow({
            where: { id: nodeMetadata.extractedObjectId as string },
          })
        ).storageKey,
      )
      ?.toString('utf8');

    const serverText = storage.objects
      .get(
        (
          await prisma.storageObject.findUniqueOrThrow({
            where: { id: serverMetadata.extractedObjectId as string },
          })
        ).storageKey,
      )
      ?.toString('utf8');

    // THE ASSERTION. A job's stored result must not depend on which executor
    // claimed it.
    expect(nodeText).toBe(MARKDOWN_BODY);
    expect(serverText).toBe(nodeText);

    // …and the recorded facts agree too, except the field whose whole purpose
    // is to record which executor ran.
    expect(nodeMetadata[EXTRACTION_METADATA_KEY].encoding).toBe(
      serverMetadata[EXTRACTION_METADATA_KEY].encoding,
    );
    expect(nodeMetadata[EXTRACTION_METADATA_KEY].characters).toBe(
      serverMetadata[EXTRACTION_METADATA_KEY].characters,
    );
    expect(nodeMetadata[EXTRACTION_METADATA_KEY].extractedBy).toBe('node');
    expect(serverMetadata[EXTRACTION_METADATA_KEY].extractedBy).toBe('server');
  });
});
