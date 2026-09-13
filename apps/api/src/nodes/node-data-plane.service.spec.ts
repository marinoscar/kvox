// =============================================================================
// NodeDataPlaneService unit coverage (issue #269, epic #254)
// =============================================================================
//
// FOUR GROUPS, AND THEY ARE NOT EQUALLY INTERESTING.
//
// The GUARD group is the one that matters most and it is deliberately thin:
// this service must not have its own opinion about whether a node still holds
// a job. What is asserted is that `assertJobHeldByNode` is REACHED — with the
// right arguments — and that a rejection from it stops everything, minting
// nothing. A second copy of that check written here would pass its own tests
// and drift from the real one on the first fix applied to either.
//
// The KEY group is the security-relevant one. A signed PUT is an
// unconditional overwrite of exactly the key it was signed for, so "the
// server chose the key" is not a nicety — it is what stands between a
// misconfigured worker and an overwrite of somebody else's upload. The
// assertions therefore look at the ARGUMENT handed to the provider, not at
// the response: a service that returned a server-derived key while signing a
// node-supplied one would pass any test that only read the body.
//
// The EXPIRY group asserts a bound rather than a value. The number itself is
// a judgement call; that it is bounded, in both directions, whatever the
// deployment's configuration says, is the property.
//
// The INPUT-RESOLUTION group is the `ENOENT … open ''` regression fence, seen
// from the HTTP side: three permanent, distinguishable failures, each with a
// status a node can act on and a `reason` it can log.
// =============================================================================

import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, StorageObject } from '@prisma/client';

import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../test/mocks/storage-provider.mock';
import type { JobHandler } from '../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../jobs/job-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import type { StorageProvider } from '../storage/providers/storage-provider.interface';
import { STORAGE_OBJECT_SUBJECT_TYPE } from '../storage/storage-job-input';
import { NodeUploadUrlDto } from './dto/node-data-plane.dto';
import {
  NODE_OUTPUT_KEY_PREFIX,
  NODE_SIGNED_URL_MAX_TTL_SECONDS,
  NODE_SIGNED_URL_MIN_TTL_SECONDS,
  NodeDataPlaneService,
} from './node-data-plane.service';
import { NodesService } from './nodes.service';

describe('NodeDataPlaneService', () => {
  const USER = 'user-1';
  const NODE_ID = 'node-1';
  const JOB_ID = '33333333-3333-4333-8333-333333333333';
  const OBJECT_ID = 'object-1';

  let prisma: MockPrismaService;
  let storage: jest.Mocked<StorageProvider>;
  let nodes: { assertJobHeldByNode: jest.Mock };
  let registry: JobHandlerRegistry;
  let configured: number | undefined;
  let service: NodeDataPlaneService;

  const config = {
    get: jest.fn((_key: string, fallback?: number) => configured ?? fallback),
  } as unknown as ConfigService;

  function makeJob(overrides: Partial<Job> = {}): Job {
    return {
      id: JOB_ID,
      type: 'example.checksum',
      subjectType: STORAGE_OBJECT_SUBJECT_TYPE,
      subjectId: OBJECT_ID,
      status: 'running',
      claimedByNodeId: NODE_ID,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    } as Job;
  }

  function makeObject(overrides: Partial<StorageObject> = {}): StorageObject {
    return {
      id: OBJECT_ID,
      name: 'invoice.pdf',
      size: BigInt(4096),
      mimeType: 'application/pdf',
      storageKey: 'uploads/1/abc.pdf',
      storageProvider: 's3',
      bucket: 'test-bucket',
      status: 'ready',
      s3UploadId: null,
      metadata: null,
      uploadedById: 'a-completely-different-user',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as StorageObject;
  }

  const uploadDto = (body: Record<string, unknown> = {}) => body as NodeUploadUrlDto;

  /**
   * Registers a handler for the job type under test.
   *
   * A REAL `JobHandlerRegistry`, not a `{ get: jest.fn() }` stub, because the
   * thing being asserted below is "an OPTIONAL member is absent" — and a
   * hand-rolled stub returning an object literal cannot be absent in the way a
   * registered handler is. `partial` carries only what the test is about;
   * `type` and `process` are the interface's two required members.
   */
  function registerHandler(partial: Partial<JobHandler> = {}): void {
    registry.register({
      type: 'example.checksum',
      process: jest.fn().mockResolvedValue(undefined),
      ...partial,
    } as JobHandler);
  }

  beforeEach(() => {
    configured = undefined;
    prisma = createMockPrismaService();
    storage = createMockStorageProvider();
    nodes = { assertJobHeldByNode: jest.fn().mockResolvedValue(makeJob()) };

    (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(makeObject());

    registry = new JobHandlerRegistry();

    service = new NodeDataPlaneService(
      prisma as unknown as PrismaService,
      config,
      nodes as unknown as NodesService,
      storage,
      registry
    );
  });

  // ===========================================================================
  // The guard — reused, never reimplemented
  // ===========================================================================

  describe('the lease guard', () => {
    it('asks `assertJobHeldByNode` first, with the caller, node and job', async () => {
      await service.createDownloadUrl(USER, NODE_ID, JOB_ID);

      expect(nodes.assertJobHeldByNode).toHaveBeenCalledWith(USER, NODE_ID, JOB_ID);
    });

    it('mints NOTHING for a download when the guard rejects', async () => {
      // The straggler: lease expired, another executor may own the job. The
      // guard's 409 must reach the caller unchanged, and no capability against
      // storage may be created on the way.
      nodes.assertJobHeldByNode.mockRejectedValue(new ConflictException('gone'));

      await expect(service.createDownloadUrl(USER, NODE_ID, JOB_ID)).rejects.toBeInstanceOf(
        ConflictException
      );

      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
      expect(prisma.storageObject.findUnique).not.toHaveBeenCalled();
    });

    it('mints NOTHING for an upload when the guard rejects', async () => {
      nodes.assertJobHeldByNode.mockRejectedValue(new ConflictException('gone'));

      await expect(
        service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto())
      ).rejects.toBeInstanceOf(ConflictException);

      expect(storage.getSignedPutUrl).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Download
  // ===========================================================================

  describe('createDownloadUrl', () => {
    it('signs the INPUT OBJECT’s key and reports the object’s facts', async () => {
      storage.getSignedDownloadUrl.mockResolvedValue('https://signed/get');

      const result = await service.createDownloadUrl(USER, NODE_ID, JOB_ID);

      expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith('uploads/1/abc.pdf', {
        expiresIn: expect.any(Number),
      });
      expect(result).toMatchObject({
        url: 'https://signed/get',
        objectId: OBJECT_ID,
        // A 64-bit column, so it crosses as a decimal string.
        size: '4096',
        mimeType: 'application/pdf',
      });
      expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('applies NO per-user ownership check — a node is an internal executor', async () => {
      // The object belongs to somebody who is not the node's owner, which is
      // the ordinary case: the operator who registered a machine has no
      // relationship to whoever uploaded the file a job is about. Routing this
      // through `ObjectsService.getDownloadUrl` would 403 every such job, and
      // the fleet would look healthy until the first cross-user one.
      (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
        makeObject({ uploadedById: 'not-the-node-owner' })
      );

      await expect(service.createDownloadUrl(USER, NODE_ID, JOB_ID)).resolves.toMatchObject({
        objectId: OBJECT_ID,
      });
    });

    it('never puts the signed URL into a log line', async () => {
      // A signed URL is a bearer capability. A log is the easiest place in a
      // system for one to be copied somewhere it outlives its expiry, so the
      // rule is "the URL is never logged" and this is the fence around it.
      const logs: unknown[][] = [];
      jest
        .spyOn(service['logger'], 'log')
        .mockImplementation((...args: unknown[]) => void logs.push(args));
      storage.getSignedDownloadUrl.mockResolvedValue('https://signed/get?X-Amz-Signature=deadbeef');

      await service.createDownloadUrl(USER, NODE_ID, JOB_ID);

      expect(logs.length).toBeGreaterThan(0);
      for (const args of logs) {
        expect(JSON.stringify(args)).not.toContain('X-Amz-Signature');
        expect(JSON.stringify(args)).not.toContain('https://signed');
      }
    });
  });

  // ===========================================================================
  // Upload — the key is the server's, and only the server's
  // ===========================================================================

  describe('createUploadTarget', () => {
    it('derives the key from the JOB ID and a fresh UUID', async () => {
      await service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto());

      const [key] = storage.getSignedPutUrl.mock.calls[0];
      expect(key).toMatch(
        new RegExp(`^${NODE_OUTPUT_KEY_PREFIX}/${JOB_ID}/[0-9a-f-]{36}$`)
      );
    });

    it('returns the key it actually signed', async () => {
      // Not a separately-computed string: a service that signed one key and
      // reported another would upload into a location the handler can never
      // find, and every assertion made on the response body alone would pass.
      const result = await service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto());

      expect(storage.getSignedPutUrl).toHaveBeenCalledWith(result.key, expect.anything());
    });

    it('never signs the same key twice, even for the same job', async () => {
      // The random suffix is what makes an overwrite impossible — including a
      // node overwriting its own earlier output.
      const first = await service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto());
      const second = await service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto());

      expect(first.key).not.toEqual(second.key);
    });

    it.each([
      ['key', { key: '../../etc/passwd' }],
      ['storageKey', { storageKey: 'uploads/someone-elses-object' }],
      ['path', { path: 'anything' }],
    ])('REFUSES a node-supplied `%s` with a 400 naming it', async (field, body) => {
      // Rejected rather than ignored, and the message is the whole reason:
      // ignoring means the node's author learns days later that their bytes
      // went somewhere they did not choose. See the DTO file's header.
      const error = await service
        .createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto(body))
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as {
        message: string;
        details: { rejectedFields: string[] };
      };
      expect(response.message).toContain(field);
      expect(response.message).toMatch(/chosen by the server/);
      expect(response.details.rejectedFields).toEqual([field]);

      // And nothing was signed: the refusal happens before any capability
      // exists, so a rejected request cannot leave a usable URL behind.
      expect(storage.getSignedPutUrl).not.toHaveBeenCalled();
    });

    it('accepts a `contentType` and passes it into the signature', async () => {
      await service.createUploadTarget(
        USER,
        NODE_ID,
        JOB_ID,
        uploadDto({ contentType: 'application/octet-stream' })
      );

      expect(storage.getSignedPutUrl).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ contentType: 'application/octet-stream' })
      );
    });

    it('creates no `storage_objects` row — minting a target is not recording an object', async () => {
      await service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto());

      expect(prisma.storageObject.create).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Handler-derived output keys (#348) — the choice moves, the chooser does not
  // ===========================================================================
  //
  // The group above proves the DEFAULT. This one proves that a type may
  // override where its output lands without any of the default's guarantees
  // moving to the node: the request body still cannot reach the key, an
  // unusable key is refused by the server rather than signed, and the value
  // handed to the provider is the value reported back.
  //
  // The regression guard is the FIRST test: `example.checksum` — the type this
  // whole data plane was built against — does not implement `deriveOutputKey`,
  // and its key must be byte-for-byte what it was before this member existed.

  describe('createUploadTarget with a handler-derived key', () => {
    const DERIVED = 'db-backups/2026/2026-09-07T00-00-00Z-run-1.dump';

    it('keeps the exact default for a handler that does not implement it', async () => {
      // `example.checksum`'s shape: `process` only. Registered, found, asked
      // nothing — a handler existing is not a handler having an opinion.
      registerHandler();

      const result = await service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto());

      expect(result.key).toMatch(
        new RegExp(`^${NODE_OUTPUT_KEY_PREFIX}/${JOB_ID}/[0-9a-f-]{36}$`)
      );
      expect(storage.getSignedPutUrl).toHaveBeenCalledWith(result.key, expect.anything());
    });

    it('falls back to the default when the type has no handler in this process at all', async () => {
      // A `jobs` row can legitimately name a type this process cannot run — a
      // fork's handler that is no longer registered. That must still mint a
      // usable target rather than throwing on the way to one.
      const result = await service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto());

      expect(result.key).toMatch(
        new RegExp(`^${NODE_OUTPUT_KEY_PREFIX}/${JOB_ID}/[0-9a-f-]{36}$`)
      );
    });

    it('signs and returns the key the handler derived', async () => {
      registerHandler({ deriveOutputKey: jest.fn().mockResolvedValue(DERIVED) });

      const result = await service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto());

      // Asserted on the ARGUMENT as well as the body, for the reason this
      // file's header gives: a service that signed one key and reported
      // another passes any test that only reads the response.
      expect(storage.getSignedPutUrl).toHaveBeenCalledWith(DERIVED, expect.anything());
      expect(result.key).toBe(DERIVED);
    });

    it('hands the handler the JOB and nothing from the request', async () => {
      const deriveOutputKey = jest.fn().mockResolvedValue(DERIVED);
      registerHandler({ deriveOutputKey });

      await service.createUploadTarget(
        USER,
        NODE_ID,
        JOB_ID,
        uploadDto({ contentType: 'application/octet-stream' })
      );

      expect(deriveOutputKey).toHaveBeenCalledTimes(1);
      expect(deriveOutputKey).toHaveBeenCalledWith(expect.objectContaining({ id: JOB_ID }));
      // One argument, so there is no channel by which a request field could
      // arrive even if a future edit widened the DTO.
      expect(deriveOutputKey.mock.calls[0]).toHaveLength(1);
    });

    it('returns the SAME key twice when the handler is idempotent', async () => {
      // The retry case the interface documents: a lost response, a timed-out
      // transfer, a restarted node. Two calls, one artifact — the opposite of
      // the default's deliberately-fresh key, and the handler's responsibility
      // rather than this service's.
      registerHandler({ deriveOutputKey: jest.fn().mockResolvedValue(DERIVED) });

      const first = await service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto());
      const second = await service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto());

      expect(first.key).toBe(second.key);
    });

    it('still REFUSES a node-supplied `key` before the handler is consulted', async () => {
      // The 400 is unchanged by #348, and it comes first: a request carrying a
      // key is refused whether or not the type has an opinion about where its
      // output goes.
      const deriveOutputKey = jest.fn().mockResolvedValue(DERIVED);
      registerHandler({ deriveOutputKey });

      await expect(
        service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto({ key: '../../etc/passwd' }))
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(deriveOutputKey).not.toHaveBeenCalled();
      expect(storage.getSignedPutUrl).not.toHaveBeenCalled();
    });

    it.each([
      ['traversal', '../../etc/passwd'],
      ['a leading slash', '/db-backups/absolute.dump'],
      ['a leading dot', '.hidden/backup.dump'],
      ['a space', 'db backups/2026/run.dump'],
      ['the empty string', ''],
    ])('mints NOTHING when a handler derives an unsafe key — %s', async (_label, unsafe) => {
      // ⚠ This is the assertion that makes `deriveOutputKey` safe to expose.
      // `..` is not an error at a storage provider, it is a key, and the
      // object lands somewhere nobody looks.
      registerHandler({ deriveOutputKey: jest.fn().mockResolvedValue(unsafe) });

      const error = await service
        .createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto())
        .catch((thrown: unknown) => thrown);

      // A 500, NOT a 400: nothing the node sent reached that string, so a 4xx
      // would send an operator to fix a node that behaved perfectly.
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain(JOB_ID);

      expect(storage.getSignedPutUrl).not.toHaveBeenCalled();
    });

    it('mints nothing when the derivation itself throws', async () => {
      // A handler whose artifact row cannot be written has no key to offer.
      // The failure must reach the caller with no capability created on the
      // way out.
      registerHandler({
        deriveOutputKey: jest.fn().mockRejectedValue(new Error('no run row for this job')),
      });

      await expect(
        service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto())
      ).rejects.toThrow('no run row');

      expect(storage.getSignedPutUrl).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Expiry — a bound, not a number
  // ===========================================================================

  describe('signed URL expiry', () => {
    async function expiryFor(configuredSeconds: number | undefined): Promise<number> {
      configured = configuredSeconds;
      const { expiresIn } = await service.createDownloadUrl(USER, NODE_ID, JOB_ID);
      return expiresIn;
    }

    it.each([
      ['the app-wide hour', 3600, NODE_SIGNED_URL_MAX_TTL_SECONDS],
      ['a stricter deployment value', 300, 300],
      ['an absurd value', 86_400, NODE_SIGNED_URL_MAX_TTL_SECONDS],
      ['zero', 0, NODE_SIGNED_URL_MIN_TTL_SECONDS],
      ['a negative value', -1, NODE_SIGNED_URL_MIN_TTL_SECONDS],
      ['nothing configured', undefined, NODE_SIGNED_URL_MAX_TTL_SECONDS],
    ])('clamps %s to %s → %s seconds', async (_label, input, expected) => {
      await expect(expiryFor(input as number | undefined)).resolves.toBe(expected);
    });

    it('is bounded on the upload side too, and reported as an absolute time', async () => {
      configured = 86_400;

      const result = await service.createUploadTarget(USER, NODE_ID, JOB_ID, uploadDto());

      expect(result.expiresIn).toBe(NODE_SIGNED_URL_MAX_TTL_SECONDS);
      expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(
        Date.now() + NODE_SIGNED_URL_MAX_TTL_SECONDS * 1000
      );
    });
  });

  // ===========================================================================
  // Input resolution — never an empty path
  // ===========================================================================

  describe('input resolution failures', () => {
    it.each([
      [
        'the job names no subject',
        () => nodes.assertJobHeldByNode.mockResolvedValue(makeJob({ subjectId: null })),
        'missing_subject_id',
      ],
      [
        'the storage object is gone',
        () => (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(null),
        'input_object_not_found',
      ],
      [
        'the storage object has no key',
        () =>
          (prisma.storageObject.findUnique as jest.Mock).mockResolvedValue(
            makeObject({ storageKey: '' })
          ),
        'input_object_has_no_storage_key',
      ],
    ])('answers 422 with reason `%s`-ish when %s', async (_label, arrange, reason) => {
      arrange();

      const error = await service
        .createDownloadUrl(USER, NODE_ID, JOB_ID)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      const response = (error as UnprocessableEntityException).getResponse() as {
        message: string;
        details: { reason: string; retryable: boolean };
      };
      expect(response.details.reason).toBe(reason);
      // The instruction, said out loud: this cannot succeed on a retry, so
      // report the job failed rather than hammering the endpoint.
      expect(response.details.retryable).toBe(false);
      // Not the failure this whole path exists to prevent.
      expect(response.message).not.toMatch(/ENOENT|open ''/);
      expect(response.message.length).toBeGreaterThan(20);

      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('lets an unexpected error through untouched', async () => {
      // Only `JobInputResolutionError` means "this job's input cannot be
      // named". A database outage must not be reported to a node as a
      // permanent, do-not-retry condition.
      const boom = new Error('connection terminated');
      (prisma.storageObject.findUnique as jest.Mock).mockRejectedValue(boom);

      await expect(service.createDownloadUrl(USER, NODE_ID, JOB_ID)).rejects.toBe(boom);
    });
  });
});
