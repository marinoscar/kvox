// =============================================================================
// Real-Postgres test: `example.checksum` from enqueue to persisted metadata
// (issue #269, epic #254)
// =============================================================================
//
// THE ONE TEST THAT PROVES THE FLEET WORKS. Everything else in this epic
// verifies a slice: the service decides correctly, the router carries the
// decision, the handler hashes what it is given. This file runs the WHOLE
// path in one go, with nothing mocked that matters:
//
//     enqueue → claim as a node → mint a download URL → stream the bytes
//     off-band → hash → submit → validate → persist → settle
//
// Every step is the production component. `JobsService` writes the row,
// `JobClaimService`'s `FOR UPDATE SKIP LOCKED` statement takes it,
// `NodeDataPlaneService` mints the URL, `ExampleChecksumHandler` persists, and
// `JobTerminalService` settles. The only substitution is the storage PROVIDER,
// and the substitute is a real one — see `LocalFileStorageProvider` below.
//
// -----------------------------------------------------------------------------
// WHY THIS CANNOT BE A MOCKED SUITE
// -----------------------------------------------------------------------------
//
// Three of its assertions are properties of Postgres, not of arrangements:
//
//   * The claim only returns the job because the row satisfies the claim
//     statement's `WHERE` — pending, due, of a node-eligible type. A mocked
//     `$queryRaw` returns whatever the test told it to, which proves the
//     test's arrangement and nothing about the queue.
//   * `metadata` is JSONB. That the merged object round-trips through the
//     column — with a `bigint` size beside it — is a driver-and-column fact.
//   * The settle is an `UPDATE` against the row the claim locked; a mock
//     cannot show that the two agree.
//
// THIS IS A `*.db.spec.ts` FILE, excluded from `npm test` and run by
// `npm run test:db` (CI's `smoke` job, after `prisma:migrate`). It SKIPS
// cleanly when no Postgres is reachable — see `../jobs/db-test-support.ts`.
//
// -----------------------------------------------------------------------------
// THE "NODE" HERE IS A FUNCTION, AND IT IS HELD TO THE REAL RULES
// -----------------------------------------------------------------------------
//
// `runNode()` below is what a worker node does, in-process. It is deliberately
// given NOTHING a real node would not have: no `PrismaClient`, no storage
// provider, no bucket name, no storage key — only the job assignment it was
// handed and the signed URL it asked for. If a future refactor made the data
// plane depend on the node knowing something else, this function would stop
// compiling, which is the point of writing it this way rather than reaching
// into the fixtures for convenience.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job, PrismaClient } from '@prisma/client';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

import { z } from 'zod';

import { ExampleChecksumHandler } from '../../src/jobs/handlers/example-checksum.handler';
import type { JobHandler } from '../../src/jobs/job-handler.interface';
import { JobClaimService } from '../../src/jobs/job-claim.service';
import { JobLeaseService } from '../../src/jobs/job-lease.service';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobTerminalService } from '../../src/jobs/job-terminal.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { ProviderThrottleService } from '../../src/jobs/provider-throttle.service';
import { ClaimJobsDto, NodeJobResultDto } from '../../src/nodes/dto/node-control-plane.dto';
import { NodeUploadUrlDto } from '../../src/nodes/dto/node-data-plane.dto';
import { NodeDataPlaneService } from '../../src/nodes/node-data-plane.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { NodesService } from '../../src/nodes/nodes.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type {
  MultipartUploadInit,
  SignedPutUrlOptions,
  SignedUrlOptions,
  StorageProvider,
  StorageUploadOptions,
  StorageUploadResult,
  UploadPart,
} from '../../src/storage/providers';
import { STORAGE_OBJECT_SUBJECT_TYPE } from '../../src/storage/storage-job-input';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { NodeOffloadService } from '../../src/jobs/node-offload.service';
import type { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';

const { describeWithDb } = resolveDbSuite('node-checksum-data-plane.db.spec');

// =============================================================================
// A LOCAL storage provider — a real implementation, not a stub
// =============================================================================
//
// It writes files under a temp directory and signs URLs the way an object
// store does: an expiry and an HMAC over `(verb, key, expiry)`, verified on
// use. That last part is what makes it worth writing instead of stubbing
// `getSignedDownloadUrl` to return `'https://example/'`:
//
//   * A stub proves the server CALLED the provider. This proves the node can
//     actually READ THE BYTES with nothing but the string it was given — no
//     key, no bucket, no credential — which is the entire claim of the data
//     plane.
//   * The expiry and the signature are checked, so a URL that arrived
//     unbounded (or with a key the server did not sign) fails here rather
//     than passing silently.
//   * `S3StorageProvider` cannot be used: it needs a bucket, credentials and
//     a reachable endpoint, none of which a `npm run test:db` run has.
//
// It implements the WHOLE `StorageProvider` interface, so the day somebody
// adds a method without implementing it everywhere, this file stops
// compiling — which is exactly the reminder #269 needed when it added
// `getSignedPutUrl`.
// =============================================================================

class LocalFileStorageProvider implements StorageProvider {
  private readonly secret = randomUUID();

  constructor(private readonly root: string) {}

  private path(key: string): string {
    return join(this.root, key);
  }

  private sign(verb: string, key: string, expiresAtMs: number): string {
    return createHmac('sha256', this.secret)
      .update(`${verb}:${key}:${expiresAtMs}`)
      .digest('hex');
  }

  private mint(verb: 'GET' | 'PUT', key: string, expiresIn: number): string {
    const expiresAtMs = Date.now() + expiresIn * 1000;
    const url = new URL('local://storage/object');
    url.searchParams.set('verb', verb);
    url.searchParams.set('key', key);
    url.searchParams.set('expires', String(expiresAtMs));
    url.searchParams.set('sig', this.sign(verb, key, expiresAtMs));
    return url.toString();
  }

  /**
   * What a NODE does with a signed URL: present it, get bytes. The node holds
   * no key and no credential, so everything needed is inside the string.
   */
  fetchSigned(signedUrl: string): Buffer {
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
    if (verb !== 'GET') {
      throw new Error(`this url is signed for ${verb}, not GET`);
    }

    return readFileSync(this.path(key));
  }

  /** What a node does with a signed PUT: send bytes, hold no credential. */
  putSigned(signedUrl: string, body: Buffer): void {
    const url = new URL(signedUrl);
    const verb = url.searchParams.get('verb') ?? '';
    const key = url.searchParams.get('key') ?? '';
    const expiresAtMs = Number(url.searchParams.get('expires'));

    if (url.searchParams.get('sig') !== this.sign(verb, key, expiresAtMs)) {
      throw new Error('signature mismatch');
    }
    if (verb !== 'PUT') {
      throw new Error(`this url is signed for ${verb}, not PUT`);
    }

    const destination = this.path(key);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, body);
  }

  /** Seeds an object outside the provider API, as a prior upload would have. */
  seed(key: string, body: Buffer): void {
    const destination = this.path(key);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, body);
  }

  async getSignedDownloadUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    return this.mint('GET', key, options?.expiresIn ?? 3600);
  }

  async getSignedPutUrl(key: string, options?: SignedPutUrlOptions): Promise<string> {
    return this.mint('PUT', key, options?.expiresIn ?? 3600);
  }

  async download(key: string): Promise<Readable> {
    return Readable.from([readFileSync(this.path(key))]);
  }

  async upload(
    key: string,
    stream: Readable,
    _options: StorageUploadOptions
  ): Promise<StorageUploadResult> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    this.seed(key, Buffer.concat(chunks));
    return { key, bucket: 'local', location: this.path(key) };
  }

  async initMultipartUpload(key: string): Promise<MultipartUploadInit> {
    return { uploadId: 'local-upload', key };
  }

  async getSignedUploadUrl(key: string, _uploadId: string, _part: number): Promise<string> {
    return this.mint('PUT', key, 3600);
  }

  async completeMultipartUpload(
    key: string,
    _uploadId: string,
    _parts: UploadPart[]
  ): Promise<StorageUploadResult> {
    return { key, bucket: 'local', location: this.path(key) };
  }

  async abortMultipartUpload(): Promise<void> {}

  async delete(key: string): Promise<void> {
    rmSync(this.path(key), { force: true });
  }

  async getMetadata(): Promise<Record<string, string> | null> {
    return {};
  }

  async setMetadata(): Promise<void> {}

  async exists(key: string): Promise<boolean> {
    try {
      readFileSync(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  getBucket(): string {
    return 'local';
  }
}

describeWithDb('example.checksum end to end on a worker node (real Postgres)', () => {
  /** Every row this suite creates is prefixed, so cleanup deletes only its own. */
  const PREFIX = `test.checksum.${process.pid}.`;
  const OWNER_EMAIL = `${PREFIX}owner@example.test`;
  const JOB_TYPE = 'example.checksum';
  const SUBJECT_TYPE = STORAGE_OBJECT_SUBJECT_TYPE;

  /**
   * A second node-eligible type, registered only by this suite (#348).
   *
   * It exists because `example.checksum` is the REGRESSION side of
   * `deriveOutputKey` — it does not implement it and must keep the exact
   * `node-outputs/<jobId>/<uuid>` key it always had — so proving the other
   * side needs a type that DOES. `test.`-prefixed and defined below the
   * shipped handlers so nobody mistakes it for one, and cleaned up with the
   * rest of this suite's rows.
   */
  const ARTIFACT_TYPE = 'test.derived-key.artifact';

  /**
   * A node-eligible handler that owns WHERE its artifact lands (#348).
   *
   * Shaped like the real case this member exists for — a database backup,
   * whose key is recorded on a row and read back by a retention sweep, a
   * download endpoint and a restore — reduced to the only part the data plane
   * can observe: a key derived from the job and stable across calls.
   *
   * `derive` is a mutable field rather than a fixed method so the unsafe-key
   * test can make this handler misbehave without a second registration
   * fighting the first for the same `type`.
   */
  class DerivedKeyArtifactHandler implements JobHandler {
    readonly type = ARTIFACT_TYPE;

    /** Both node members or neither — this one is claimable, so: both. */
    readonly nodeResultSchema = z.object({ key: z.string() });

    /** Deterministic in the job id: the same job asks twice, gets one key. */
    derive: (job: Job) => string = (job) => `${PREFIX}artifacts/${job.id}.bin`;

    async process(): Promise<void> {}

    async persistNodeResult(): Promise<void> {}

    async deriveOutputKey(job: Job): Promise<string> {
      return this.derive(job);
    }
  }

  let prisma: PrismaClient;
  let root: string;
  let storage: LocalFileStorageProvider;

  let jobs: JobsService;
  let nodes: NodesService;
  let registry: JobHandlerRegistry;
  let artifactHandler: DerivedKeyArtifactHandler;
  let dataPlane: NodeDataPlaneService;
  let handler: ExampleChecksumHandler;

  let ownerId: string;
  let nodeId: string;

  /** Config answers: everything defaults, except a short signed-URL expiry. */
  const config = {
    get: (key: string, fallback?: unknown) =>
      key === 'storage.signedUrlExpiry' ? 120 : fallback,
  } as unknown as ConfigService;

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();

    root = mkdtempSync(join(tmpdir(), 'node-checksum-'));
    storage = new LocalFileStorageProvider(root);

    registry = new JobHandlerRegistry();
    const service = prisma as unknown as PrismaService;

    handler = new ExampleChecksumHandler(registry, service, storage);
    // Self-registration, exactly as `JobsModule` triggers it — this is what
    // makes the type node-eligible and therefore claimable at all.
    handler.onModuleInit();

    artifactHandler = new DerivedKeyArtifactHandler();
    registry.register(artifactHandler);

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
        registry
      ),
      // The real lease service over the same client (#347): renewal is a real
      // write on the row this suite is exercising, so a stub would hide it.
      new JobLeaseService(service),
      registry,
      // WHAT A NODE MAY CLAIM HERE, RIGHT NOW (#349, #352) — the REAL service
      // over this suite's own registry, with only its settings read stubbed to
      // the shipped default (`jobSecretBrokerEnabled: false`). No handler here
      // declares a broker or an offload gate, so the three filters it applies
      // are a no-op — but the claim reads it, and stubbing the service itself
      // would hide a drift between what a node is offered and what the
      // in-process worker's `system` mode claims as the complement.
      new NodeOffloadService(registry, {
        getNodesPolicy: async () => ({ ...DEFAULT_SYSTEM_SETTINGS.nodes }),
      } as unknown as SystemSettingsService)
    );
    dataPlane = new NodeDataPlaneService(service, config, nodes, storage, registry);

    const owner = await prisma.user.create({
      data: { email: OWNER_EMAIL, displayName: 'checksum suite' },
    });
    ownerId = owner.id;

    const node = await prisma.workerNode.create({
      data: {
        name: `${PREFIX}node`,
        hostname: 'checksum-box',
        platform: 'linux-x64',
        cliVersion: '0.0.0-test',
        eligibleTypes: [JOB_TYPE, ARTIFACT_TYPE],
        concurrency: 4,
        status: 'online',
        createdById: ownerId,
      },
    });
    nodeId = node.id;
  });

  afterEach(async () => {
    await prisma.job.deleteMany({ where: { type: { in: [JOB_TYPE, ARTIFACT_TYPE] } } });
    await prisma.storageObject.deleteMany({ where: { name: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await prisma?.job.deleteMany({ where: { type: { in: [JOB_TYPE, ARTIFACT_TYPE] } } });
    await prisma?.storageObject.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma?.workerNode.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await prisma?.user.deleteMany({ where: { email: OWNER_EMAIL } });
    await prisma?.$disconnect();
    rmSync(root, { recursive: true, force: true });
  });

  /** A stored object with real bytes behind it, as a completed upload leaves. */
  async function seedObject(content: Buffer): Promise<{ id: string; sha256: string }> {
    const storageKey = `${PREFIX}uploads/${randomUUID()}.bin`;
    storage.seed(storageKey, content);

    const object = await prisma.storageObject.create({
      data: {
        name: `${PREFIX}payload.bin`,
        size: BigInt(content.length),
        mimeType: 'application/octet-stream',
        storageKey,
        storageProvider: 'local',
        bucket: 'local',
        status: 'ready',
      },
    });

    return { id: object.id, sha256: createHash('sha256').update(content).digest('hex') };
  }

  const claimOne = (): Promise<Job[]> =>
    nodes.claimJobs(ownerId, nodeId, { limit: 1 } as ClaimJobsDto);

  /**
   * What the worker node itself does. It is handed the job and NOTHING else —
   * no client, no provider, no key — and it gets its bytes through the URL the
   * server minted for it.
   */
  async function runNode(job: Job): Promise<{ sha256: string; bytes: number }> {
    const grant = await dataPlane.createDownloadUrl(ownerId, nodeId, job.id);

    // The bound is asserted here rather than in a separate test because this
    // is the moment it matters: what a node receives must already be
    // short-lived, whatever the deployment configured.
    expect(grant.expiresIn).toBeGreaterThanOrEqual(60);
    expect(grant.expiresIn).toBeLessThanOrEqual(900);

    const bytes = storage.fetchSigned(grant.url);

    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }

  const readMetadata = async (objectId: string): Promise<Record<string, any>> => {
    const row = await prisma.storageObject.findUniqueOrThrow({ where: { id: objectId } });
    return (row.metadata ?? {}) as Record<string, any>;
  };

  // ===========================================================================
  // The whole path
  // ===========================================================================

  it('runs enqueue → claim → download → compute → submit → persist', async () => {
    const content = Buffer.from('the quick brown fox jumps over the lazy dog');
    const object = await seedObject(content);

    const enqueued = await jobs.enqueue({
      type: JOB_TYPE,
      reason: 'upload',
      subjectType: SUBJECT_TYPE,
      subjectId: object.id,
    });

    const [claimed] = await claimOne();
    expect(claimed?.id).toBe(enqueued.id);
    // Claimed AS A NODE: the executor and the node id are on the row, which is
    // what makes job history able to say where the work ran.
    expect(claimed.executor).toBe('node');
    expect(claimed.claimedByNodeId).toBe(nodeId);

    const computed = await runNode(claimed);
    expect(computed.sha256).toBe(object.sha256);
    expect(computed.bytes).toBe(content.length);

    const settlement = await nodes.submitResult(ownerId, nodeId, claimed.id, {
      type: JOB_TYPE,
      result: computed,
    } as NodeJobResultDto);

    expect(settlement.outcome).toBe('succeeded');
    expect(settlement.willRetry).toBe(false);

    // The job is terminal, its claim and lease released.
    const settled = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(settled.status).toBe('succeeded');
    expect(settled.leaseExpiresAt).toBeNull();

    // And the result is in the column — JSONB, round-tripped, beside a bigint.
    const metadata = await readMetadata(object.id);
    expect(metadata.checksum).toMatchObject({
      algorithm: 'sha256',
      sha256: object.sha256,
      bytes: content.length,
      computedBy: 'node',
    });
  });

  it('claims the type ONLY because a node-eligible handler is registered', async () => {
    // The gate #268 built and #269 finally satisfies: `claimJobs` intersects
    // with the registry's node-eligible types, so before `example.checksum`
    // existed this same call returned nothing for every node in every fleet.
    const object = await seedObject(Buffer.from('x'));
    await jobs.enqueue({
      type: JOB_TYPE,
      reason: 'backfill',
      subjectType: SUBJECT_TYPE,
      subjectId: object.id,
    });

    const published = await nodes.listNodeEligibleJobTypes();
    expect(published.map((entry) => entry.type)).toContain(JOB_TYPE);
    await expect(claimOne()).resolves.toHaveLength(1);
  });

  // ===========================================================================
  // The lease branch
  // ===========================================================================

  it('renews a lease mid-transfer, and the new expiry is what the row holds', async () => {
    const object = await seedObject(Buffer.from('slow download'));
    await jobs.enqueue({
      type: JOB_TYPE,
      reason: 'upload',
      subjectType: SUBJECT_TYPE,
      subjectId: object.id,
    });

    const [claimed] = await claimOne();
    const before = claimed.leaseExpiresAt as Date;

    // A long hash on a slow link is the reason renewal exists: without it the
    // reaper requeues work that is still running.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const renewed = await nodes.renewLease(ownerId, nodeId, claimed.id);

    expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThan(before.getTime());
    const row = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(row.leaseExpiresAt?.getTime()).toBe(renewed.leaseExpiresAt.getTime());

    // And the data plane still serves the job it just extended.
    await expect(
      dataPlane.createDownloadUrl(ownerId, nodeId, claimed.id)
    ).resolves.toMatchObject({ objectId: object.id });
  });

  it('refuses a download URL with 409 once the job is no longer held', async () => {
    const object = await seedObject(Buffer.from('done already'));
    await jobs.enqueue({
      type: JOB_TYPE,
      reason: 'upload',
      subjectType: SUBJECT_TYPE,
      subjectId: object.id,
    });

    const [claimed] = await claimOne();
    await nodes.submitResult(ownerId, nodeId, claimed.id, {
      type: JOB_TYPE,
      result: await runNode(claimed),
    } as NodeJobResultDto);

    // The straggler asking for bytes for work that is already settled.
    await expect(
      dataPlane.createDownloadUrl(ownerId, nodeId, claimed.id)
    ).rejects.toMatchObject({ status: 409 });
  });

  // ===========================================================================
  // The failure branch
  // ===========================================================================

  it('settles a node-reported failure through the ordinary retry machine', async () => {
    const object = await seedObject(Buffer.from('doomed'));
    await jobs.enqueue({
      type: JOB_TYPE,
      reason: 'upload',
      subjectType: SUBJECT_TYPE,
      subjectId: object.id,
    });

    const [claimed] = await claimOne();
    const settlement = await nodes.reportFailure(ownerId, nodeId, claimed.id, {
      error: 'the download stream was truncated',
    });

    expect(settlement.outcome).toBe('retry-scheduled');

    const row = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(row.status).toBe('pending');
    expect(row.lastError).toContain('truncated');
    // Nothing was written to the object: a failure is not a result.
    expect(await readMetadata(object.id)).toEqual({});
  });

  it('rejects a malformed result BEFORE `persistNodeResult` is reached', async () => {
    // The trust boundary, exercised against the real schema and a real row:
    // an upper-case digest is the kind of thing a fork's own node produces,
    // and it stores perfectly while breaking every comparison anyone makes.
    const content = Buffer.from('malformed result');
    const object = await seedObject(content);
    await jobs.enqueue({
      type: JOB_TYPE,
      reason: 'upload',
      subjectType: SUBJECT_TYPE,
      subjectId: object.id,
    });

    const [claimed] = await claimOne();
    const computed = await runNode(claimed);

    await expect(
      nodes.submitResult(ownerId, nodeId, claimed.id, {
        type: JOB_TYPE,
        result: { sha256: computed.sha256.toUpperCase(), bytes: computed.bytes },
      } as NodeJobResultDto)
    ).rejects.toMatchObject({ status: 400 });

    // NOTHING happened: no metadata, and the job is still running under its
    // lease, so the node may fix its client and submit again.
    expect(await readMetadata(object.id)).toEqual({});
    const row = await prisma.job.findUniqueOrThrow({ where: { id: claimed.id } });
    expect(row.status).toBe('running');

    // …and the corrected submission lands.
    await expect(
      nodes.submitResult(ownerId, nodeId, claimed.id, {
        type: JOB_TYPE,
        result: computed,
      } as NodeJobResultDto)
    ).resolves.toMatchObject({ outcome: 'succeeded' });
  });

  // ===========================================================================
  // Input resolution — never an empty path
  // ===========================================================================

  it.each([
    ['the job names no subject', 'none', 'missing_subject_id'],
    ['the object was deleted after enqueue', 'deleted', 'input_object_not_found'],
    ['the object has no storage key', 'keyless', 'input_object_has_no_storage_key'],
  ])('answers 422 with a specific reason when %s', async (_label, arrangement, reason) => {
    const object = await seedObject(Buffer.from('input'));

    const subjectId = arrangement === 'none' ? undefined : object.id;
    await jobs.enqueue({
      type: JOB_TYPE,
      reason: 'upload',
      subjectType: SUBJECT_TYPE,
      subjectId,
      skipDedup: true,
    });

    if (arrangement === 'deleted') {
      await prisma.storageObject.delete({ where: { id: object.id } });
    }
    if (arrangement === 'keyless') {
      // The column is non-nullable, so the reachable bad state is an EMPTY
      // key — the exact value that produced `ENOENT … open ''` in the
      // application this design came from.
      await prisma.storageObject.update({
        where: { id: object.id },
        data: { storageKey: '' },
      });
    }

    const [claimed] = await claimOne();

    const error = await dataPlane
      .createDownloadUrl(ownerId, nodeId, claimed.id)
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ status: 422 });
    const body = (error as { getResponse(): { message: string; details: { reason: string } } })
      .getResponse();
    expect(body.details.reason).toBe(reason);
    expect(body.message).not.toMatch(/ENOENT|open ''/);

    // The server-side path fails the same way, with the same reason — one
    // resolver, so an operator reading `lastError` sees what a node was told.
    await expect(handler.process(claimed)).rejects.toMatchObject({ reason });
  });

  // ===========================================================================
  // Writing output
  // ===========================================================================

  it('mints an upload target the node can actually PUT to, at a server-chosen key', async () => {
    const object = await seedObject(Buffer.from('input for an output job'));
    await jobs.enqueue({
      type: JOB_TYPE,
      reason: 'upload',
      subjectType: SUBJECT_TYPE,
      subjectId: object.id,
    });

    const [claimed] = await claimOne();

    const target = await dataPlane.createUploadTarget(
      ownerId,
      nodeId,
      claimed.id,
      {} as NodeUploadUrlDto
    );

    // Derived from the JOB, plus a fresh UUID — nothing from the request.
    //
    // ⚠ REGRESSION FENCE FOR #348. `example.checksum` does not implement
    // `deriveOutputKey`, and a type that does not implement it must keep this
    // key byte-for-byte: the default is what every existing node-eligible
    // type in every fork already writes to.
    expect(target.key).toMatch(new RegExp(`^node-outputs/${claimed.id}/[0-9a-f-]{36}$`));

    // The node writes with the URL alone — no key, no bucket, no credential.
    const payload = Buffer.from('bytes a node produced');
    storage.putSigned(target.url, payload);

    // …and the bytes are where the SERVER said they would be, not where the
    // node might have asked for.
    expect(readFileSync(join(root, target.key))).toEqual(payload);
  });

  it('refuses a node-supplied upload key rather than silently ignoring it', async () => {
    const object = await seedObject(Buffer.from('overwrite me if you can'));
    await jobs.enqueue({
      type: JOB_TYPE,
      reason: 'upload',
      subjectType: SUBJECT_TYPE,
      subjectId: object.id,
    });

    const [claimed] = await claimOne();
    const inputRow = await prisma.storageObject.findUniqueOrThrow({ where: { id: object.id } });

    await expect(
      dataPlane.createUploadTarget(ownerId, nodeId, claimed.id, {
        // The job's own input key: honouring this would let a node destroy
        // the file it was asked to read.
        key: inputRow.storageKey,
      } as unknown as NodeUploadUrlDto)
    ).rejects.toMatchObject({ status: 400 });

    // The input is untouched, and still hashes to what it did before.
    const bytes = readFileSync(join(root, inputRow.storageKey));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(object.sha256);
  });
  // ===========================================================================
  // Handler-derived output keys (#348, epic #345)
  // ===========================================================================
  //
  // The tests above are the DEFAULT half. These are the override half, run
  // against the same real claim, the same real lease guard and the same real
  // signing provider — because the property that matters is not "the service
  // returned a string", it is "the bytes a node PUT with the URL it was given
  // are readable at the key the handler named".

  /** Enqueue → claim one job of the suite's derived-key type. */
  async function claimArtifactJob(): Promise<Job> {
    await jobs.enqueue({ type: ARTIFACT_TYPE, reason: 'backfill' });
    const [claimed] = await claimOne();
    expect(claimed?.type).toBe(ARTIFACT_TYPE);
    return claimed;
  }

  it('lets a type choose where its own output lands, and signs THAT key', async () => {
    const claimed = await claimArtifactJob();

    const target = await dataPlane.createUploadTarget(
      ownerId,
      nodeId,
      claimed.id,
      {} as NodeUploadUrlDto
    );

    // The handler's location, not `node-outputs/…`. This is the whole issue:
    // an artifact whose key is recorded elsewhere must land where that record
    // says, or the sweep, the download and the restore all miss it.
    expect(target.key).toBe(`${PREFIX}artifacts/${claimed.id}.bin`);
    expect(target.key).not.toMatch(/^node-outputs\//);

    // And the node can actually write there with the URL alone — the signature
    // covers the key the handler chose, so a service that reported one key and
    // signed another would fail here rather than in production.
    const payload = Buffer.from('an artifact with a required location');
    storage.putSigned(target.url, payload);
    expect(readFileSync(join(root, target.key))).toEqual(payload);
  });

  it('gives the same job the same key twice — a retry is not a second artifact', async () => {
    // The lost-response case the interface documents. Two mints, one location:
    // whatever the node finishes writing is at the key its result will name.
    const claimed = await claimArtifactJob();

    const first = await dataPlane.createUploadTarget(
      ownerId,
      nodeId,
      claimed.id,
      {} as NodeUploadUrlDto
    );
    const second = await dataPlane.createUploadTarget(
      ownerId,
      nodeId,
      claimed.id,
      {} as NodeUploadUrlDto
    );

    expect(second.key).toBe(first.key);

    // Both URLs are usable and both address the same object, so the retry
    // overwrites its own artifact rather than orphaning the first one.
    storage.putSigned(first.url, Buffer.from('attempt one'));
    storage.putSigned(second.url, Buffer.from('attempt two'));
    expect(readFileSync(join(root, second.key)).toString()).toBe('attempt two');
  });

  it('still REFUSES a node-supplied key for a type that derives its own', async () => {
    // #348 moved the choice between two parts of the SERVER. It did not give
    // the node a vote, and a type having an opinion does not create one.
    const claimed = await claimArtifactJob();

    await expect(
      dataPlane.createUploadTarget(ownerId, nodeId, claimed.id, {
        key: `${PREFIX}artifacts/somewhere-else.bin`,
      } as unknown as NodeUploadUrlDto)
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses to sign anything when a handler derives an unsafe key', async () => {
    // ⚠ The guard that makes this member safe to expose. `..` is not an error
    // at a storage provider — it is a key — so the refusal has to happen here.
    const claimed = await claimArtifactJob();
    artifactHandler.derive = () => '../../../etc/passwd';

    try {
      const error = await dataPlane
        .createUploadTarget(ownerId, nodeId, claimed.id, {} as NodeUploadUrlDto)
        .catch((thrown: unknown) => thrown);

      // A plain 500-shaped failure, NOT a 4xx: nothing the node sent could
      // reach that string, so telling the node to fix its request would be a
      // lie. And the node gets no URL at all — there is no capability to leak.
      expect(error).toBeInstanceOf(Error);
      expect((error as { status?: number }).status).toBeUndefined();
      expect((error as Error).message).toContain(claimed.id);
    } finally {
      artifactHandler.derive = (job) => `${PREFIX}artifacts/${job.id}.bin`;
    }
  });
});
