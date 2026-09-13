// =============================================================================
// NodesService unit coverage (issue #268, epic #254)
// =============================================================================
//
// THREE GROUPS OF ASSERTION LIVE HERE, and they are not equally interesting.
//
// The register-or-reattach group exists because the failure it prevents is
// invisible: nothing errors when a restart creates a second node row. The
// fleet just slowly fills with ghosts, and by the time anybody notices, the
// operator cannot tell which row is the machine currently doing work. The
// P2002 case is the one a mock is genuinely good at — two replicas racing is
// hard to arrange for real and trivial to describe here.
//
// The claim-filter group exists because every one of those filters silently
// does nothing when it is wrong. A concurrency clamp that reads the
// registration instead of the row still returns jobs; a type intersection
// that unions instead of intersecting still returns jobs. Only an assertion
// on the arguments handed to `JobClaimService` can tell the difference, which
// is why these tests assert on the CALL rather than on the result.
//
// The lease group is the one that matters most. `assertJobHeldByNode` is what
// stands between a straggler node and a double-persist over another
// executor's newer run, and the state it refuses — expired lease, reassigned
// job, already-settled row — is a state no happy-path test ever reaches. Each
// condition is therefore sabotaged individually, against a job that is
// otherwise perfectly held, so a failure names exactly which check regressed.
//
// The claim itself and the terminal state machine are stubbed here ON PURPOSE:
// this service's job is to decide WHAT to ask them for, and their own
// behaviour is covered by `job-claim.db.spec.ts` (against real Postgres,
// because `SKIP LOCKED` cannot be proven against a mock) and
// `job-terminal.service.spec.ts`. Re-testing them through this service would
// assert the mock's arrangement, not the queue.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, WorkerNode } from '@prisma/client';
import { z } from 'zod';

import { JobClaimService } from '../jobs/job-claim.service';
import { JobHandlerRegistry } from '../jobs/job-handler.registry';
import { JobLeaseService } from '../jobs/job-lease.service';
import { JobTerminalService } from '../jobs/job-terminal.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../common/types/settings.types';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import {
  ClaimJobsDto,
  HeartbeatNodeDto,
  NodeJobFailureDto,
  NodeJobResultDto,
  RegisterNodeDto,
} from './dto/node-control-plane.dto';
import { NodeOffloadService } from '../jobs/node-offload.service';
import type { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { NodesService } from './nodes.service';

describe('NodesService', () => {
  const USER = 'user-1';
  const OTHER_USER = 'user-2';
  const NODE_ID = 'node-1';
  const JOB_ID = 'job-1';

  /** A node-eligible type: its handler carries BOTH optional members. */
  const NODE_TYPE = 'test.node.eligible';

  /** A server-only type: its handler carries neither. */
  const SERVER_TYPE = 'test.server.only';

  let prisma: MockPrismaService;
  let claims: { claim: jest.Mock };
  let terminal: { completeSucceeded: jest.Mock; completeFailed: jest.Mock };
  let registry: JobHandlerRegistry;
  let persistNodeResult: jest.Mock;
  let offload: NodeOffloadService;
  let getNodesPolicy: jest.Mock;
  let service: NodesService;

  /** A `ConfigService` that answers nothing, so every default is the shipped one. */
  const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;

  function makeNode(overrides: Partial<WorkerNode> = {}): WorkerNode {
    return {
      id: NODE_ID,
      name: 'prod-worker-1',
      hostname: 'box-a',
      platform: 'linux-x64',
      cliVersion: '1.0.0',
      eligibleTypes: [NODE_TYPE],
      concurrency: 2,
      status: 'online',
      capabilities: null,
      registeredAt: new Date('2026-01-01T00:00:00.000Z'),
      lastHeartbeatAt: null,
      createdById: USER,
      ...overrides,
    } as WorkerNode;
  }

  /** A job this node is holding legitimately: running, claimed, lease in the future. */
  function makeJob(overrides: Partial<Job> = {}): Job {
    return {
      id: JOB_ID,
      type: NODE_TYPE,
      subjectType: null,
      subjectId: null,
      dedupKey: null,
      status: 'running',
      reason: null,
      priority: 100,
      providerKey: null,
      modelVersion: null,
      payload: { input: 'x' },
      attempts: 1,
      lastError: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: null,
      scheduledFor: null,
      rateLimitedAt: null,
      rateLimitHits: 0,
      claimedByNodeId: NODE_ID,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      executor: 'node',
      ...overrides,
    } as Job;
  }

  const registerDto = (overrides: Partial<RegisterNodeDto> = {}): RegisterNodeDto =>
    ({
      name: 'prod-worker-1',
      hostname: 'box-b',
      platform: 'linux-arm64',
      cliVersion: '2.0.0',
      eligibleTypes: [NODE_TYPE],
      concurrency: 4,
      ...overrides,
    }) as RegisterNodeDto;

  beforeEach(() => {
    prisma = createMockPrismaService();
    claims = { claim: jest.fn().mockResolvedValue([]) };
    terminal = {
      completeSucceeded: jest.fn().mockResolvedValue('succeeded'),
      completeFailed: jest.fn().mockResolvedValue('retry-scheduled'),
    };

    persistNodeResult = jest.fn().mockResolvedValue(undefined);

    registry = new JobHandlerRegistry();
    registry.register({
      type: NODE_TYPE,
      process: async () => undefined,
      nodeResultSchema: z.object({ ok: z.boolean() }),
      persistNodeResult,
    });
    registry.register({ type: SERVER_TYPE, process: async () => undefined });

    // ⚠ THE REAL `NodeOffloadService` (#352), over this suite's own registry.
    // It is what decides which types a node is offered, and `JobWorker`'s
    // `system` mode consumes its COMPLEMENT — a stub here would let the two
    // halves of that partition drift apart with this file green. Only its
    // settings read is faked, held so a case can change what a deployment has
    // decided between one claim and the next.
    getNodesPolicy = jest.fn().mockResolvedValue({ ...DEFAULT_SYSTEM_SETTINGS.nodes });
    offload = new NodeOffloadService(registry, {
      getNodesPolicy,
    } as unknown as SystemSettingsService);

    service = new NodesService(
      prisma as unknown as PrismaService,
      config,
      claims as unknown as JobClaimService,
      terminal as unknown as JobTerminalService,
      // THE REAL SERVICE OVER THE SAME PRISMA STUB, not a mock (#347). The
      // point of moving the renewal guard into `JobLeaseService` is that this
      // endpoint stops carrying its own copy — a mocked renewer would let a
      // future refactor drop `leaseExpiresAt: { gt: now }` from the shared
      // predicate with this suite still green, which is the one thing these
      // cases exist to prevent. The assertions below still read
      // `prisma.job.updateMany`, because that is still where the write lands.
      new JobLeaseService(prisma as unknown as PrismaService),
      registry,
      // The narrow settings accessor (#349). Stubbed to the SHIPPED DEFAULT —
      // brokering off — because that is what a deployment that has never
      // touched the setting reads, and because this suite's types carry no
      // broker, so the filter it drives is a no-op here by construction.
      offload
    );
  });

  // ===========================================================================
  // register — idempotent on (owner, name)
  // ===========================================================================

  describe('register', () => {
    it('creates a node when this owner has none under that name', async () => {
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.workerNode.create as jest.Mock).mockImplementation(async ({ data }: any) =>
        makeNode(data)
      );

      const result = await service.register(USER, registerDto());

      expect(result.reattached).toBe(false);
      const created = (prisma.workerNode.create as jest.Mock).mock.calls[0][0].data;
      expect(created).toMatchObject({
        name: 'prod-worker-1',
        createdById: USER,
        status: 'online',
        concurrency: 4,
      });
      // The lookup is the composite unique, not a scan — this is what makes
      // the endpoint idempotent rather than merely usually-idempotent.
      expect((prisma.workerNode.findUnique as jest.Mock).mock.calls[0][0]).toEqual({
        where: { createdById_name: { createdById: USER, name: 'prod-worker-1' } },
      });
    });

    it('REATTACHES to the existing row instead of creating a second one', async () => {
      // The headline acceptance criterion: a container that is recreated must
      // not leak a node row.
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode());
      (prisma.workerNode.update as jest.Mock).mockImplementation(async ({ data }: any) =>
        makeNode(data)
      );

      const result = await service.register(USER, registerDto());

      expect(result.reattached).toBe(true);
      expect(prisma.workerNode.create).not.toHaveBeenCalled();

      const data = (prisma.workerNode.update as jest.Mock).mock.calls[0][0].data;
      expect(data).toMatchObject({
        hostname: 'box-b',
        platform: 'linux-arm64',
        cliVersion: '2.0.0',
        concurrency: 4,
        status: 'online',
      });
    });

    it('recovers from a concurrent replica’s P2002 by reattaching, not failing', async () => {
      // Two replicas both find nothing and both insert; one loses. Losing is
      // not an error — the row it wanted now exists.
      const existing = makeNode();
      (prisma.workerNode.findUnique as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existing);
      (prisma.workerNode.create as jest.Mock).mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      );
      (prisma.workerNode.update as jest.Mock).mockResolvedValue(existing);

      const result = await service.register(USER, registerDto());

      expect(result.reattached).toBe(true);
      expect(result.node.id).toBe(NODE_ID);
      // Exactly one insert attempt, and no second row anywhere.
      expect(prisma.workerNode.create).toHaveBeenCalledTimes(1);
      expect(prisma.workerNode.update).toHaveBeenCalledTimes(1);
    });

    it('re-throws a P2002 whose row it cannot then find', async () => {
      // A unique violation on some OTHER constraint. Inventing a recovery for
      // a conflict we cannot see would hide a real schema problem.
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.workerNode.create as jest.Mock).mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      );

      await expect(service.register(USER, registerDto())).rejects.toThrow(
        'Unique constraint failed'
      );
    });

    it('warns but PROCEEDS when the existing row is still heartbeating', async () => {
      // Last writer wins: the normal cause is a container recreated before its
      // heartbeat aged out, and refusing would turn a routine restart into a
      // startup failure on a machine nobody is watching.
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ lastHeartbeatAt: new Date(), hostname: 'box-a' })
      );
      (prisma.workerNode.update as jest.Mock).mockResolvedValue(makeNode());

      const result = await service.register(USER, registerDto({ hostname: 'box-b' }));

      expect(result.reattached).toBe(true);
      expect(prisma.workerNode.update).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('still heartbeating'));
    });

    it('does NOT clear an operator’s `disabled` on reattach', async () => {
      // Otherwise the kill switch is defeatable with `docker restart` — by the
      // very process being switched off.
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ status: 'disabled' })
      );
      (prisma.workerNode.update as jest.Mock).mockResolvedValue(makeNode({ status: 'disabled' }));

      await service.register(USER, registerDto());

      const data = (prisma.workerNode.update as jest.Mock).mock.calls[0][0].data;
      expect(data).not.toHaveProperty('status');
    });
  });

  // ===========================================================================
  // heartbeat
  // ===========================================================================

  describe('heartbeat', () => {
    beforeEach(() => {
      (prisma.workerNode.update as jest.Mock).mockImplementation(async ({ data }: any) =>
        makeNode(data)
      );
    });

    it('stamps liveness and applies what the node reports', async () => {
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode());

      await service.heartbeat(USER, NODE_ID, {
        status: 'online',
        concurrency: 8,
        capabilities: { gpu: true },
      } as HeartbeatNodeDto);

      const data = (prisma.workerNode.update as jest.Mock).mock.calls[0][0].data;
      expect(data.lastHeartbeatAt).toBeInstanceOf(Date);
      expect(data.concurrency).toBe(8);
      expect(data.status).toBe('online');
      expect(data.capabilities).toEqual({ gpu: true });
    });

    it.each([['disabled'], ['draining']])(
      'refuses to let a heartbeat clear an operator’s `%s`',
      async (status) => {
        // A node that could report its way out of `disabled` would walk out of
        // its own kill switch on the next tick.
        (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode({ status } as any));

        await service.heartbeat(USER, NODE_ID, { status: 'online' } as HeartbeatNodeDto);

        const data = (prisma.workerNode.update as jest.Mock).mock.calls[0][0].data;
        expect(data).not.toHaveProperty('status');
        // Liveness is still recorded: a disabled node is still alive, and the
        // fleet page needs to know that.
        expect(data.lastHeartbeatAt).toBeInstanceOf(Date);
      }
    );
  });

  // ===========================================================================
  // claim — three filters, each asserted on the CALL
  // ===========================================================================

  describe('claimJobs', () => {
    const claimArgs = () => claims.claim.mock.calls[0][0];

    it('clamps the limit down to the node’s declared concurrency', async () => {
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode({ concurrency: 2 }));

      await service.claimJobs(USER, NODE_ID, { limit: 50 } as ClaimJobsDto);

      expect(claimArgs().limit).toBe(2);
    });

    it('defaults the limit to the node’s concurrency when none is asked for', async () => {
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode({ concurrency: 3 }));

      await service.claimJobs(USER, NODE_ID, {} as ClaimJobsDto);

      expect(claimArgs().limit).toBe(3);
    });

    it('honours a smaller requested limit — a node with one free slot asks for one', async () => {
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode({ concurrency: 4 }));

      await service.claimJobs(USER, NODE_ID, { limit: 1 } as ClaimJobsDto);

      expect(claimArgs().limit).toBe(1);
    });

    it('DROPS a requested type the node never registered', async () => {
      // A node may narrow, never widen. The request is the one input a
      // compromised worker fully controls.
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ eligibleTypes: [NODE_TYPE] })
      );

      await service.claimJobs(USER, NODE_ID, {
        types: [NODE_TYPE, 'something.it.never.declared'],
      } as ClaimJobsDto);

      expect(claimArgs().eligibleTypes).toEqual([NODE_TYPE]);
    });

    it('drops a registered type no node could run (server-only handler)', async () => {
      // Otherwise the node computes something this server cannot store, its
      // result post is refused, the lease expires, the reaper requeues, and the
      // loop burns an attempt per lap.
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ eligibleTypes: [NODE_TYPE, SERVER_TYPE] })
      );

      await service.claimJobs(USER, NODE_ID, {} as ClaimJobsDto);

      expect(claimArgs().eligibleTypes).toEqual([NODE_TYPE]);
    });

    it('claims as `node`, under this node’s id, with a server-derived lease', async () => {
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode());

      await service.claimJobs(USER, NODE_ID, {} as ClaimJobsDto);

      expect(claimArgs()).toMatchObject({ nodeId: NODE_ID, executor: 'node' });
      // Derived from the shipped `JOBS_JOB_TIMEOUT_MS` default plus the grace,
      // identically to the in-process worker — not a number this file chose.
      // ONE ENTRY PER ELIGIBLE TYPE (#346): a node claims up to its
      // concurrency across several types in one statement, so the lease is
      // per row, not per batch.
      expect(claimArgs().leases).toEqual([{ type: NODE_TYPE, leaseMs: 660_000 }]);
    });

    it('derives a PROFILED type’s lease from its own ceiling, like the server does', async () => {
      // A node and the API server must reach the same number for the same
      // type, because the lease is the reaper's contract, not a claimer's
      // private detail. Both go through `buildClaimLeases`, so the only way
      // they can disagree is if one of them stops calling it.
      registry.register({
        type: NODE_TYPE,
        profile: { maxRuntimeMs: 7_200_000, maxAttempts: 1 },
        process: async () => undefined,
        nodeResultSchema: z.object({ ok: z.boolean() }),
        persistNodeResult,
      });

      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode());

      await service.claimJobs(USER, NODE_ID, {} as ClaimJobsDto);

      expect(claimArgs().leases).toEqual([{ type: NODE_TYPE, leaseMs: 7_260_000 }]);
    });

    it('emits one lease per eligible type, matching the list it claims on', async () => {
      // The heterogeneous claim is the whole reason the lease became per row:
      // a node takes up to its concurrency ACROSS types in one statement.
      const second = 'test.node.eligible.two';

      registry.register({
        type: second,
        profile: { maxRuntimeMs: 5_000, maxAttempts: 3 },
        process: async () => undefined,
        nodeResultSchema: z.object({ ok: z.boolean() }),
        persistNodeResult,
      });

      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ eligibleTypes: [NODE_TYPE, second] })
      );

      await service.claimJobs(USER, NODE_ID, {} as ClaimJobsDto);

      expect(claimArgs().leases).toEqual([
        { type: NODE_TYPE, leaseMs: 660_000 },
        { type: second, leaseMs: 65_000 },
      ]);
      expect(claimArgs().leases.map((lease: { type: string }) => lease.type)).toEqual(
        claimArgs().eligibleTypes
      );
    });

    it('refuses a DISABLED node with 403 and claims nothing', async () => {
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ status: 'disabled' })
      );

      await expect(service.claimJobs(USER, NODE_ID, {} as ClaimJobsDto)).rejects.toThrow(
        ForbiddenException
      );
      expect(claims.claim).not.toHaveBeenCalled();
    });

    it('gives a DRAINING node an empty list rather than an error', async () => {
      // Draining is a normal state with a normal instruction; a node that must
      // keep heartbeating while it drains must not be taught this endpoint is
      // failing.
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ status: 'draining' })
      );

      await expect(service.claimJobs(USER, NODE_ID, {} as ClaimJobsDto)).resolves.toEqual([]);
      expect(claims.claim).not.toHaveBeenCalled();
    });

    it('reads concurrency LIVE, so a heartbeat changes the next claim’s cap', async () => {
      // The whole reason nothing is cached at registration: `appctl node
      // set-concurrency` must take effect on the very next claim.
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode({ concurrency: 2 }));
      (prisma.workerNode.update as jest.Mock).mockImplementation(async ({ data }: any) =>
        makeNode(data)
      );

      await service.claimJobs(USER, NODE_ID, {} as ClaimJobsDto);
      expect(claims.claim.mock.calls[0][0].limit).toBe(2);

      await service.heartbeat(USER, NODE_ID, { concurrency: 8 } as HeartbeatNodeDto);
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode({ concurrency: 8 }));

      await service.claimJobs(USER, NODE_ID, {} as ClaimJobsDto);
      expect(claims.claim.mock.calls[1][0].limit).toBe(8);
    });
  });

  // ===========================================================================
  // assertOwnership — 404 vs 403
  // ===========================================================================

  describe('assertOwnership', () => {
    it('404s for a node that does not exist', async () => {
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.assertOwnership(USER, NODE_ID)).rejects.toThrow(NotFoundException);
    });

    it('403s for another user’s node — deliberately not 404', async () => {
      // A node id is not secret, and telling a misconfigured operator "no such
      // node" sends them off to re-register, leaking a duplicate row and
      // stranding the real node's jobs.
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ createdById: OTHER_USER })
      );

      await expect(service.assertOwnership(USER, NODE_ID)).rejects.toThrow(ForbiddenException);
    });

    it('returns the row, so no caller needs a second fetch', async () => {
      const node = makeNode();
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(node);

      await expect(service.assertOwnership(USER, NODE_ID)).resolves.toBe(node);
      expect(prisma.workerNode.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // The lease guard — the group that matters most
  // ===========================================================================

  describe('assertJobHeldByNode', () => {
    beforeEach(() => {
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode());
    });

    it('returns the job when the node genuinely holds it', async () => {
      const job = makeJob();
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(job);

      await expect(service.assertJobHeldByNode(USER, NODE_ID, JOB_ID)).resolves.toBe(job);
    });

    it('404s for a job that does not exist', async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.assertJobHeldByNode(USER, NODE_ID, JOB_ID)).rejects.toThrow(
        NotFoundException
      );
    });

    // Each of these is sabotaged individually against an otherwise perfectly
    // held job, so a failure names exactly which condition regressed.
    it.each([
      ['claimed by a different node', { claimedByNodeId: 'node-9' }],
      ['no longer running', { status: 'succeeded' as Job['status'] }],
      ['holding no lease at all', { leaseExpiresAt: null }],
      ['holding an EXPIRED lease', { leaseExpiresAt: new Date(Date.now() - 1_000) }],
    ])('409s when the job is %s', async (_label, overrides) => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(makeJob(overrides as Partial<Job>));

      await expect(service.assertJobHeldByNode(USER, NODE_ID, JOB_ID)).rejects.toThrow(
        ConflictException
      );
    });

    it('checks node ownership BEFORE looking at the job', async () => {
      // A caller who does not own the node must learn nothing about the jobs it
      // holds, including whether a job id exists.
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ createdById: OTHER_USER })
      );

      await expect(service.assertJobHeldByNode(USER, NODE_ID, JOB_ID)).rejects.toThrow(
        ForbiddenException
      );
      expect(prisma.job.findUnique).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // renew
  // ===========================================================================

  describe('renewLease', () => {
    beforeEach(() => {
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode());
    });

    it('pushes the lease out by the server’s derived interval', async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(makeJob());
      (prisma.job.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      const before = Date.now();
      const result = await service.renewLease(USER, NODE_ID, JOB_ID);

      expect(result.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 660_000);
      // The write re-asserts the guard rather than trusting the read.
      expect((prisma.job.updateMany as jest.Mock).mock.calls[0][0].where).toMatchObject({
        id: JOB_ID,
        claimedByNodeId: NODE_ID,
        status: 'running',
      });
      // And the clause that makes the guard a guard rather than a filter: a
      // lease that has ALREADY passed may not be renewed, because by then the
      // reaper may have handed the row to somebody else.
      expect(
        (prisma.job.updateMany as jest.Mock).mock.calls[0][0].where.leaseExpiresAt.gt
      ).toBeInstanceOf(Date);
    });

    it('409s once the lease has expired, and writes nothing', async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(
        makeJob({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      );

      await expect(service.renewLease(USER, NODE_ID, JOB_ID)).rejects.toThrow(ConflictException);
      expect(prisma.job.updateMany).not.toHaveBeenCalled();
    });

    it('409s when the guarded write matches nothing — the state moved under us', async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(makeJob());
      (prisma.job.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(service.renewLease(USER, NODE_ID, JOB_ID)).rejects.toThrow(ConflictException);
    });
  });

  // ===========================================================================
  // Result ingestion — the five steps, in order
  // ===========================================================================

  describe('submitResult', () => {
    const goodResult = { type: NODE_TYPE, result: { ok: true } } as NodeJobResultDto;

    beforeEach(() => {
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode());
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(makeJob());
    });

    it('validates, persists and settles', async () => {
      const result = await service.submitResult(USER, NODE_ID, JOB_ID, goodResult);

      expect(persistNodeResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: JOB_ID }),
        { ok: true }
      );
      expect(terminal.completeSucceeded).toHaveBeenCalled();
      expect(result).toEqual({ jobId: JOB_ID, outcome: 'succeeded', willRetry: false });
    });

    it('400s when the posted type does not match the job’s', async () => {
      // A node holding two jobs and crossing their ids would otherwise persist
      // one job's result against the other.
      await expect(
        service.submitResult(USER, NODE_ID, JOB_ID, {
          type: 'some.other.type',
          result: { ok: true },
        } as NodeJobResultDto)
      ).rejects.toThrow(BadRequestException);

      expect(persistNodeResult).not.toHaveBeenCalled();
      expect(terminal.completeSucceeded).not.toHaveBeenCalled();
    });

    it('400s when the type is not node-persistable', async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(makeJob({ type: SERVER_TYPE }));

      await expect(
        service.submitResult(USER, NODE_ID, JOB_ID, {
          type: SERVER_TYPE,
          result: {},
        } as NodeJobResultDto)
      ).rejects.toThrow(/not node-persistable/);

      expect(terminal.completeSucceeded).not.toHaveBeenCalled();
    });

    it('400s with the validation detail when the result fails the handler’s schema', async () => {
      // THE TRUST BOUNDARY. The payload came from a machine this deployment may
      // not own; `nodeResultSchema` is the only thing narrowing it.
      const error = await service
        .submitResult(USER, NODE_ID, JOB_ID, {
          type: NODE_TYPE,
          result: { ok: 'not-a-boolean' },
        } as NodeJobResultDto)
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      // Custom fields live in `details` — the exception filter rebuilds bodies
      // from a fixed key allowlist and would drop anything else.
      expect(error.getResponse().details).toMatchObject({
        jobId: JOB_ID,
        type: NODE_TYPE,
        issues: expect.arrayContaining([expect.objectContaining({ path: 'ok' })]),
      });
      expect(persistNodeResult).not.toHaveBeenCalled();
    });

    it('fails the JOB through the normal path, and answers 500, when persisting throws', async () => {
      // Once the server has begun persisting it owns the row's lifecycle: the
      // failure belongs in the retry machine, and the node must not resubmit.
      persistNodeResult.mockRejectedValue(new Error('constraint violation'));
      terminal.completeFailed.mockResolvedValue('retry-scheduled');

      const error = await service
        .submitResult(USER, NODE_ID, JOB_ID, goodResult)
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(InternalServerErrorException);
      expect(terminal.completeFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: JOB_ID }),
        expect.objectContaining({ message: 'constraint violation' })
      );
      expect(terminal.completeSucceeded).not.toHaveBeenCalled();
      expect(error.getResponse().details).toMatchObject({ resubmit: false });
    });

    it('409s — and persists NOTHING — for a result posted after the lease expired', async () => {
      // The straggler case: the reaper has requeued this job and another
      // executor may already be running it.
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(
        makeJob({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      );

      await expect(service.submitResult(USER, NODE_ID, JOB_ID, goodResult)).rejects.toThrow(
        ConflictException
      );

      expect(persistNodeResult).not.toHaveBeenCalled();
      expect(terminal.completeSucceeded).not.toHaveBeenCalled();
      expect(terminal.completeFailed).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Failure reporting
  // ===========================================================================

  describe('reportFailure', () => {
    beforeEach(() => {
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode());
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(makeJob());
    });

    it('passes the rate-limit flags straight into the terminal chokepoint', async () => {
      terminal.completeFailed.mockResolvedValue('rate-limit-deferred');

      const result = await service.reportFailure(USER, NODE_ID, JOB_ID, {
        error: 'provider said 429',
        rateLimited: true,
        retryAfterMs: 30_000,
      } as NodeJobFailureDto);

      expect(terminal.completeFailed).toHaveBeenCalledWith(
        expect.objectContaining({ id: JOB_ID }),
        expect.objectContaining({ message: 'provider said 429' }),
        { rateLimited: true, retryAfterMs: 30_000 }
      );
      expect(result.willRetry).toBe(true);
    });

    it('IGNORES the node’s `willRetry` and answers with the server’s decision', async () => {
      // Advisory only. A node that could dictate its own retries could retry
      // itself past the budget that bounds a job nobody is watching.
      terminal.completeFailed.mockResolvedValue('failed');

      const result = await service.reportFailure(USER, NODE_ID, JOB_ID, {
        error: 'boom',
        willRetry: true,
      } as NodeJobFailureDto);

      expect(terminal.completeFailed).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { rateLimited: undefined, retryAfterMs: undefined }
      );
      expect(result).toEqual({ jobId: JOB_ID, outcome: 'failed', willRetry: false });
    });

    it('409s for a failure reported after the lease expired', async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(
        makeJob({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      );

      await expect(
        service.reportFailure(USER, NODE_ID, JOB_ID, { error: 'boom' } as NodeJobFailureDto)
      ).rejects.toThrow(ConflictException);

      expect(terminal.completeFailed).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // The published contract (#269)
  // ===========================================================================

  describe('listNodeEligibleJobTypes', () => {
    it('lists node-eligible types only — never a server-only one', async () => {
      // The same derivation the claim uses, published. A server-only type
      // appearing here would tell a client to build a node for work this
      // server could never store a result for.
      const types = (await service.listNodeEligibleJobTypes()).map((entry) => entry.type);

      expect(types).toContain(NODE_TYPE);
      expect(types).not.toContain(SERVER_TYPE);
    });

    it('publishes the handler’s OWN schema as JSON Schema', async () => {
      // Generated from the very object `submitResult` parses against, which is
      // the entire point: a client cannot validate against a definition this
      // server stopped using.
      const [entry] = await service.listNodeEligibleJobTypes();

      expect(entry.resultSchema).toMatchObject({
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      });
      expect(entry.label).toBe(NODE_TYPE);
    });

    it('publishes `null` — not `{}` — for a schema with no JSON Schema form', async () => {
      // `{}` in JSON Schema means "anything is valid", so an empty object
      // would be a lie in the most expensive direction: the client validates
      // garbage confidently and is refused by the server it just agreed with.
      // `null` says "submit it and let the server answer", which is true.
      registry.register({
        type: 'test.unrepresentable',
        process: async () => undefined,
        nodeResultSchema: z.custom(() => true),
        persistNodeResult: async () => undefined,
      });

      const entry = (await service.listNodeEligibleJobTypes()).find(
        (candidate) => candidate.type === 'test.unrepresentable'
      );

      expect(entry).toBeDefined();
      // Still LISTED — it is still claimable; only its contract is unpublishable.
      expect(entry?.resultSchema).toBeNull();
    });
  });

  // ===========================================================================
  // The three claim-time gates (#349, #352 — epic #345)
  // ===========================================================================
  //
  // A type is node-ELIGIBLE because its handler carries the two members. What
  // a deployment OFFERS is that set intersected with three runtime answers,
  // and none of the three mutates the registry: the handler is unchanged
  // throughout every case below, which is exactly what each assertion pairs
  // with its "…and it is still eligible" companion.

  describe('what a deployment offers a node', () => {
    const BROKER_TYPE = 'test.needs-credential';

    /** Registers a node-eligible type carrying a broker and an offload gate. */
    function registerGatedType(overrides: {
      usable?: jest.Mock;
      nodeOffloadEnabled?: jest.Mock;
    }): { usable: jest.Mock; nodeOffloadEnabled?: jest.Mock } {
      const usable = overrides.usable ?? jest.fn().mockResolvedValue({ ok: true });

      registry.register({
        type: BROKER_TYPE,
        process: async () => undefined,
        nodeResultSchema: z.object({ ok: z.boolean() }),
        persistNodeResult: async () => undefined,
        nodeSecretBroker: {
          kind: 'test.postgres',
          usable: usable as unknown as () => Promise<{ ok: true }>,
          issue: jest.fn(),
          revoke: jest.fn(),
        },
        ...(overrides.nodeOffloadEnabled
          ? { nodeOffloadEnabled: overrides.nodeOffloadEnabled as unknown as () => Promise<boolean> }
          : {}),
      });

      return { usable, ...(overrides.nodeOffloadEnabled ? { nodeOffloadEnabled: overrides.nodeOffloadEnabled } : {}) };
    }

    /** `nodes.jobSecretBrokerEnabled`, as the real settings accessor answers it. */
    function givenBrokerEnabled(enabled: boolean): void {
      getNodesPolicy.mockResolvedValue({
        ...DEFAULT_SYSTEM_SETTINGS.nodes,
        jobSecretBrokerEnabled: enabled,
      });
    }

    it('withholds a broker-carrying type while `nodes.jobSecretBrokerEnabled` is off', async () => {
      registerGatedType({});
      givenBrokerEnabled(false);

      const types = (await service.listNodeEligibleJobTypes()).map((entry) => entry.type);

      expect(types).not.toContain(BROKER_TYPE);
      // ⚠ AND THE REGISTRY IS UNTOUCHED. The type is still node-eligible;
      // this deployment declines to offer it. A mutation here would make "can
      // this type run on a node" depend on a setting, which is the exact
      // disagreement `job-handler.interface.ts` makes unrepresentable.
      expect(registry.serverOnlyTypes()).not.toContain(BROKER_TYPE);
    });

    it('does not probe the broker at all when the switch is off — no database round trip to answer a settled question', async () => {
      const { usable } = registerGatedType({});
      givenBrokerEnabled(false);

      await service.listNodeEligibleJobTypes();

      expect(usable).not.toHaveBeenCalled();
    });

    it('withholds a type whose broker reports it CANNOT mint here', async () => {
      // The failure this prevents: the node claims, asks for its credential,
      // gets a 503 and defers — burning a claim and a lease cycle every poll,
      // forever, on a deployment that simply cannot mint roles (managed
      // PostgreSQL denying CREATEROLE is the ordinary case).
      registerGatedType({
        usable: jest.fn().mockResolvedValue({
          ok: false,
          reason: 'the application role lacks CREATEROLE',
          remedy: 'ALTER ROLE app CREATEROLE;',
        }),
      });
      givenBrokerEnabled(true);

      const types = (await service.listNodeEligibleJobTypes()).map((entry) => entry.type);

      expect(types).not.toContain(BROKER_TYPE);
    });

    it('withholds the type — and only that type — when the probe THROWS', async () => {
      registerGatedType({ usable: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
      givenBrokerEnabled(true);

      const types = (await service.listNodeEligibleJobTypes()).map((entry) => entry.type);

      expect(types).not.toContain(BROKER_TYPE);
      // A probe failure must never fail the whole claim: the node is very
      // likely holding unrelated work that has nothing to do with this broker.
      expect(types).toContain(NODE_TYPE);
    });

    it('withholds a type whose handler says this deployment has not enabled offload for it', async () => {
      registerGatedType({ nodeOffloadEnabled: jest.fn().mockResolvedValue(false) });
      givenBrokerEnabled(true);

      const types = (await service.listNodeEligibleJobTypes()).map((entry) => entry.type);

      expect(types).not.toContain(BROKER_TYPE);
    });

    it('asks the handler’s gate on EVERY call — an administrator’s switch is not cached here', async () => {
      const gate = jest.fn().mockResolvedValue(true);
      registerGatedType({ nodeOffloadEnabled: gate });
      givenBrokerEnabled(true);

      await service.listNodeEligibleJobTypes();
      await service.listNodeEligibleJobTypes();

      expect(gate).toHaveBeenCalledTimes(2);
    });

    it('offers the type when all three gates agree', async () => {
      registerGatedType({ nodeOffloadEnabled: jest.fn().mockResolvedValue(true) });
      givenBrokerEnabled(true);

      const types = (await service.listNodeEligibleJobTypes()).map((entry) => entry.type);

      expect(types).toContain(BROKER_TYPE);
    });

    it('leaves a type with NO gate and NO broker exactly as it was — the additive default', async () => {
      givenBrokerEnabled(false);

      // `NODE_TYPE` carries neither member. Every node-eligible type written
      // before these gates existed must be offered exactly as it always was.
      const types = (await service.listNodeEligibleJobTypes()).map((entry) => entry.type);

      expect(types).toContain(NODE_TYPE);
    });

    it('withholds a gated type from the CLAIM as well as from the listing', async () => {
      // The listing is advice; the claim is the fence. A type that appeared in
      // neither list but was still claimable would be the worst of both.
      registerGatedType({ nodeOffloadEnabled: jest.fn().mockResolvedValue(false) });
      givenBrokerEnabled(true);
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(
        makeNode({ eligibleTypes: [NODE_TYPE, BROKER_TYPE] })
      );

      await service.claimJobs(USER, NODE_ID, {} as ClaimJobsDto);

      expect(claims.claim.mock.calls[0][0].eligibleTypes).toEqual([NODE_TYPE]);
    });
  });

  // ===========================================================================
  // deregister
  // ===========================================================================

  describe('deregister', () => {
    it('marks the node offline and leaves its held jobs to the lease reaper', async () => {
      // Requeueing here would hand a still-running job to a second executor on
      // the say-so of a process that may not actually have stopped.
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(makeNode());
      (prisma.workerNode.update as jest.Mock).mockResolvedValue(makeNode({ status: 'offline' }));

      await service.deregister(USER, NODE_ID);

      expect((prisma.workerNode.update as jest.Mock).mock.calls[0][0]).toEqual({
        where: { id: NODE_ID },
        data: { status: 'offline' },
      });
      expect(prisma.job.updateMany).not.toHaveBeenCalled();
      expect(prisma.job.update).not.toHaveBeenCalled();
    });
  });
});
