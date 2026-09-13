// =============================================================================
// Unit tests for the in-process worker pool (issue #262, epic #254)
// =============================================================================
//
// NO DATABASE, AND NO REAL SLEEPS LONGER THAN A FEW MILLISECONDS. Everything
// this file asserts is a DECISION the worker makes in memory — which types it
// claims for a given mode, what it does with a job whose handler is missing,
// whether a slot is freed when a job overruns, whether a slow job blocks a
// fast one — and every one of those is settled before any SQL exists. The
// claim and the terminal service are stubbed, so what is recorded on those
// stubs IS the assertion.
//
// The lifecycle half — "a handler registering in `onModuleInit` is always
// registered before the first claim" — cannot be asserted here, because it is
// a claim about Nest's phase ordering. It lives in
// `job.worker.bootstrap.spec.ts`, which boots a real module graph.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Job } from '@prisma/client';
import { z } from 'zod';

import { JobClaimService, ClaimOptions } from './job-claim.service';
import { JobClock } from './job-clock';
import { JobHandler } from './job-handler.interface';
import { JobHandlerRegistry } from './job-handler.registry';
import { JobLeaseService } from './job-lease.service';
import { JobTerminalService } from './job-terminal.service';
import { resetJobProfileWarnings } from './job-execution-profile';
import { JobTimeoutError, JobWorker, resetUnknownWorkerModeWarning } from './job.worker';
import { ProviderThrottleService } from './provider-throttle.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../common/types/settings.types';
import { NodeOffloadService } from './node-offload.service';
import type { SystemSettingsService } from '../settings/system-settings/system-settings.service';

/** Every worker setting, with the shipped defaults spelled out rather than imported. */
interface WorkerConfig {
  'jobs.workerMode'?: unknown;
  'jobs.workerConcurrency'?: number;
  'jobs.pollMs'?: number;
  'jobs.jobTimeoutMs'?: number;
  'jobs.systemModeExtraTypes'?: unknown;
}

const DEFAULT_CONFIG: WorkerConfig = {
  'jobs.workerMode': 'all',
  'jobs.workerConcurrency': 1,
  // Long enough that a sleeping loop stays asleep for the whole test unless
  // something wakes it — which is exactly what the shutdown test measures.
  'jobs.pollMs': 60_000,
  'jobs.jobTimeoutMs': 0,
  'jobs.systemModeExtraTypes': [],
};

function stubConfig(values: WorkerConfig): ConfigService {
  const merged = { ...DEFAULT_CONFIG, ...values } as Record<string, unknown>;

  return {
    get: (key: string) => merged[key],
  } as unknown as ConfigService;
}

/** A claimed, running row. Only the fields the worker reads matter. */
function claimedJob(type: string, overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${type}`,
    type,
    status: 'running',
    attempts: 1,
    payload: null,
    ...overrides,
  } as Job;
}

/** A handler whose `process` is whatever the test needs it to be. */
function handler(type: string, process: () => Promise<void>): JobHandler {
  return { type, process };
}

/** A NODE-ELIGIBLE handler: it carries BOTH optional members (§2). */
function nodeEligibleHandler(type: string): JobHandler {
  return {
    type,
    process: async () => undefined,
    nodeResultSchema: z.object({ ok: z.boolean() }),
    persistNodeResult: async () => undefined,
  };
}

/** Lets the event loop drain — enough turns for pending timers set to 0/1ms. */
async function drain(turns = 4): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Polls `predicate` on real time, up to `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }

    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

interface Harness {
  worker: JobWorker;
  registry: JobHandlerRegistry;
  /** The REAL service `system` mode takes its complement from (#352). */
  offload: NodeOffloadService;
  /** Its one faked read, so a case can open the deployment's gates. */
  getNodesPolicy: jest.Mock;
  claim: jest.Mock;
  completeSucceeded: jest.Mock;
  completeFailed: jest.Mock;
  acquire: jest.Mock;
  /** `JobLeaseService.renew` (#347) — resolves `true` unless a case says otherwise. */
  renew: jest.Mock;
  warn: jest.SpyInstance;
  error: jest.SpyInstance;
}

function makeWorker(config: WorkerConfig = {}, throttle?: ProviderThrottleService): Harness {
  const registry = new JobHandlerRegistry();

  const claim = jest.fn().mockResolvedValue([] as Job[]);
  const completeSucceeded = jest.fn().mockResolvedValue('succeeded');
  const completeFailed = jest.fn().mockResolvedValue('failed');
  const acquire = jest.fn().mockResolvedValue(0);
  const renew = jest.fn().mockResolvedValue(true);

  // ⚠ THE REAL `NodeOffloadService`, OVER THE SAME REGISTRY (#352), not a
  // stub. `system` mode's list is now the COMPLEMENT of what a node may claim
  // here, and a stubbed complement would let the two halves drift back apart
  // with this suite green — which is the exact bug the delegation exists to
  // make impossible. Only the settings read is faked, to the shipped default
  // (`jobSecretBrokerEnabled: false`).
  const getNodesPolicy = jest.fn().mockResolvedValue({ ...DEFAULT_SYSTEM_SETTINGS.nodes });
  const offload = new NodeOffloadService(registry, {
    getNodesPolicy,
  } as unknown as SystemSettingsService);

  const worker = new JobWorker(
    stubConfig(config),
    registry,
    { claim } as unknown as JobClaimService,
    { completeSucceeded, completeFailed } as unknown as JobTerminalService,
    throttle ?? ({ acquire } as unknown as ProviderThrottleService),
    { renew } as unknown as JobLeaseService,
    offload
  );

  return {
    worker,
    registry,
    offload,
    getNodesPolicy,
    claim,
    completeSucceeded,
    completeFailed,
    acquire,
    renew,
    warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  };
}

describe('JobWorker', () => {
  beforeEach(() => {
    // The unknown-mode latch is MODULE level (so a typo warns once rather
    // than once per poll), which means it survives between cases. Left
    // un-reset, "warns exactly once" would pass vacuously for every case
    // after the first — the opposite of what that test is for.
    resetUnknownWorkerModeWarning();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // The lifecycle hook, structurally. The behavioural proof is in
  // job.worker.bootstrap.spec.ts; this is the cheap guard against someone
  // renaming the hook back.
  // ---------------------------------------------------------------------------

  describe('lifecycle phase', () => {
    it('implements onApplicationBootstrap and deliberately NOT onModuleInit', () => {
      const prototype = JobWorker.prototype as unknown as Record<string, unknown>;

      expect(typeof prototype.onApplicationBootstrap).toBe('function');
      // Handlers register in THEIR onModuleInit; a worker with this hook
      // would be racing them. See job-handler.registry.ts.
      expect(prototype.onModuleInit).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Worker modes
  // ---------------------------------------------------------------------------

  describe('worker modes', () => {
    it('"all" claims every registered type, node-eligible ones included', async () => {
      const { worker, registry } = makeWorker({ 'jobs.workerMode': 'all' });

      registry.register(handler('test.server-only', async () => undefined));
      registry.register(nodeEligibleHandler('test.node-eligible'));

      expect(worker.mode()).toBe('all');
      expect((await worker.eligibleTypes()).sort()).toEqual(
        ['test.node-eligible', 'test.server-only'].sort()
      );
    });

    it('"system" claims only what a node could never run', async () => {
      const { worker, registry } = makeWorker({ 'jobs.workerMode': 'system' });

      registry.register(handler('test.server-only', async () => undefined));
      registry.register(nodeEligibleHandler('test.node-eligible'));

      expect(worker.mode()).toBe('system');
      expect(await worker.eligibleTypes()).toEqual(['test.server-only']);
    });

    it('"off" starts no pool at all: nothing is ever claimed', async () => {
      const { worker, registry, claim } = makeWorker({
        'jobs.workerMode': 'off',
        'jobs.workerConcurrency': 4,
      });

      registry.register(handler('test.server-only', async () => undefined));

      worker.onApplicationBootstrap();
      await drain();

      expect(claim).not.toHaveBeenCalled();
      expect(await worker.eligibleTypes()).toEqual([]);

      await worker.onModuleDestroy();
    });

    it('is case- and whitespace-insensitive about the configured value', () => {
      const { worker } = makeWorker({ 'jobs.workerMode': '  SYSTEM ' });

      expect(worker.mode()).toBe('system');
    });

    it('falls open to "all" on an unrecognised value rather than stopping work', async () => {
      const { worker, registry } = makeWorker({ 'jobs.workerMode': 'sytem' });

      registry.register(handler('test.server-only', async () => undefined));
      registry.register(nodeEligibleHandler('test.node-eligible'));

      expect(worker.mode()).toBe('all');
      // The whole point of failing open: a typo must not silently stop the
      // node-eligible half of the queue.
      expect(await worker.eligibleTypes()).toHaveLength(2);
    });

    it('warns EXACTLY ONCE about an unrecognised value, however often it is read', () => {
      const { worker, warn } = makeWorker({ 'jobs.workerMode': 'sytem' });

      for (let index = 0; index < 50; index += 1) {
        worker.mode();
      }

      const unknownModeWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes('Unrecognised JOBS_WORKER_MODE')
      );

      expect(unknownModeWarnings).toHaveLength(1);
      expect(String(unknownModeWarnings[0][0])).toContain('sytem');
      expect(String(unknownModeWarnings[0][0])).toContain('all');
    });

    it('latches that warning at MODULE level, so a second worker stays quiet', () => {
      const first = makeWorker({ 'jobs.workerMode': 'nonsense' });
      first.worker.mode();

      const countUnknownModeWarnings = (): number =>
        first.warn.mock.calls.filter((call) =>
          String(call[0]).includes('Unrecognised JOBS_WORKER_MODE')
        ).length;

      expect(countUnknownModeWarnings()).toBe(1);

      // A SECOND worker instance, sharing nothing but the module-level latch.
      // (Both harnesses observe the same `Logger.prototype.warn` spy — Jest
      // returns the existing mock when a method is already spied on.)
      const second = makeWorker({ 'jobs.workerMode': 'nonsense' });
      second.worker.mode();

      // Still one across BOTH workers, not one each: the latch is why
      // re-reading the mode on every claim does not bury the log.
      expect(countUnknownModeWarnings()).toBe(1);
    });

    it('treats a missing setting as "all"', async () => {
      const { worker, registry } = makeWorker({ 'jobs.workerMode': undefined });

      registry.register(nodeEligibleHandler('test.node-eligible'));

      expect(worker.mode()).toBe('all');
      expect(await worker.eligibleTypes()).toEqual(['test.node-eligible']);
    });
  });

  // ---------------------------------------------------------------------------
  // JOBS_SYSTEM_MODE_EXTRA_TYPES
  // ---------------------------------------------------------------------------

  describe('systemModeEligibleTypes', () => {
    it('adds a registered node-eligible type named in the extras', async () => {
      const { worker, registry } = makeWorker({
        'jobs.workerMode': 'system',
        'jobs.systemModeExtraTypes': ['test.node-eligible'],
      });

      registry.register(handler('test.server-only', async () => undefined));
      registry.register(nodeEligibleHandler('test.node-eligible'));

      expect((await worker.systemModeEligibleTypes()).sort()).toEqual(
        ['test.node-eligible', 'test.server-only'].sort()
      );
    });

    it('accepts a raw comma-separated string as well as a parsed list', async () => {
      const { worker, registry } = makeWorker({
        'jobs.workerMode': 'system',
        'jobs.systemModeExtraTypes': ' test.node-eligible , ',
      });

      registry.register(nodeEligibleHandler('test.node-eligible'));

      expect(await worker.systemModeEligibleTypes()).toEqual(['test.node-eligible']);
    });

    it('does not duplicate a type that is already server-only', async () => {
      const { worker, registry } = makeWorker({
        'jobs.workerMode': 'system',
        'jobs.systemModeExtraTypes': ['test.server-only'],
      });

      registry.register(handler('test.server-only', async () => undefined));

      expect(await worker.systemModeEligibleTypes()).toEqual(['test.server-only']);
    });

    it('DROPS an entry no handler registers, with a warning', async () => {
      const { worker, registry, warn } = makeWorker({
        'jobs.workerMode': 'system',
        'jobs.systemModeExtraTypes': ['test.typo'],
      });

      registry.register(handler('test.server-only', async () => undefined));

      // Claiming a type with no handler is not harmless: the claim succeeds
      // and the job is then failed permanently.
      expect(await worker.systemModeEligibleTypes()).toEqual(['test.server-only']);

      const dropped = warn.mock.calls.filter((call) =>
        String(call[0]).includes('JOBS_SYSTEM_MODE_EXTRA_TYPES')
      );

      expect(dropped).toHaveLength(1);
      expect(String(dropped[0][0])).toContain('test.typo');
    });

    // =========================================================================
    // ⚠ THE PARTITION (#352, epic #345)
    // =========================================================================
    //
    // `system` mode's list is the COMPLEMENT of what a node may claim here,
    // and these cases pin that from the worker's side. The failure they exist
    // to catch is not a wrong list — it is a HOLE: a type structurally
    // node-eligible (so absent from `serverOnlyTypes()`) whose runtime gates
    // are all closed (so no node may claim it) would be claimed by NOBODY, and
    // for `db.backup.run` "nobody" means a deployment that quietly stops
    // taking backups.

    it('CLAIMS a node-eligible type whose deployment gates are closed — the hole this fix closed', async () => {
      const { worker, registry } = makeWorker({ 'jobs.workerMode': 'system' });

      registry.register(handler('test.server-only', async () => undefined));
      // Structurally node-eligible AND gated off by this deployment, which is
      // exactly `db.backup.run`'s shape with `nodeOffloadEnabled` false.
      registry.register({
        ...nodeEligibleHandler('test.gated'),
        nodeOffloadEnabled: async () => false,
      });

      // Before this fix the base was `serverOnlyTypes()`, which does not
      // contain `test.gated` — so this list was `['test.server-only']` and the
      // gated type was claimed by no executor at all.
      expect((await worker.systemModeEligibleTypes()).sort()).toEqual(
        ['test.gated', 'test.server-only'].sort()
      );
    });

    it('STOPS claiming it the moment the deployment opens the gate', async () => {
      const { worker, registry } = makeWorker({ 'jobs.workerMode': 'system' });

      let offloadEnabled = false;
      registry.register({
        ...nodeEligibleHandler('test.gated'),
        nodeOffloadEnabled: async () => offloadEnabled,
      });

      expect(await worker.systemModeEligibleTypes()).toEqual(['test.gated']);

      // The administrator turns offload on. No restart, no cached list: the
      // fleet takes the type and this process stops claiming it, in the same
      // process, on the next poll.
      offloadEnabled = true;

      expect(await worker.systemModeEligibleTypes()).toEqual([]);
    });

    it('is the exact complement of what a node is offered, whatever the gates say', async () => {
      const { worker, registry, offload } = makeWorker({ 'jobs.workerMode': 'system' });

      registry.register(handler('test.server-only', async () => undefined));
      registry.register(nodeEligibleHandler('test.open'));
      registry.register({
        ...nodeEligibleHandler('test.gated'),
        nodeOffloadEnabled: async () => false,
      });

      const offered = await offload.offeredTypes();
      const claimed = await worker.systemModeEligibleTypes();

      // ⚠ THE PROPERTY, STATED AS A PROPERTY: no overlap, and nothing missing.
      // Two independently derived lists could satisfy either half alone.
      expect(claimed.filter((type) => offered.includes(type))).toEqual([]);
      expect([...offered, ...claimed].sort()).toEqual(registry.types().sort());
    });

    it('still lets an operator force a gated-open type back onto the server', async () => {
      // The escape hatch is UNCHANGED by the partition fix: a fleet that is
      // small, paused, or does not run a type is still an operator's decision,
      // and `SKIP LOCKED` makes the overlap safe rather than merely tolerated.
      const { worker, registry } = makeWorker({
        'jobs.workerMode': 'system',
        'jobs.systemModeExtraTypes': ['test.open'],
      });

      registry.register(nodeEligibleHandler('test.open'));

      expect(await worker.systemModeEligibleTypes()).toEqual(['test.open']);
    });

    it('warns about a dropped entry once per type, not once per claim', async () => {
      const { worker, warn } = makeWorker({
        'jobs.workerMode': 'system',
        'jobs.systemModeExtraTypes': ['test.typo'],
      });

      for (let index = 0; index < 20; index += 1) {
        await worker.systemModeEligibleTypes();
      }

      expect(
        warn.mock.calls.filter((call) =>
          String(call[0]).includes('JOBS_SYSTEM_MODE_EXTRA_TYPES')
        )
      ).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Claiming
  // ---------------------------------------------------------------------------

  describe('claiming', () => {
    it('claims ONE row at a time, as the server, with no node id', async () => {
      const { worker, registry, claim } = makeWorker({
        'jobs.workerConcurrency': 1,
        'jobs.jobTimeoutMs': 30_000,
      });

      registry.register(handler('test.echo', async () => undefined));

      worker.start(1);
      await waitFor(() => claim.mock.calls.length > 0);
      await worker.stop();

      const options = claim.mock.calls[0][0] as ClaimOptions;

      expect(options.limit).toBe(1);
      expect(options.executor).toBe('server');
      expect(options.nodeId).toBeNull();
      expect(options.eligibleTypes).toEqual(['test.echo']);
      // The lease is DERIVED from the timeout so it cannot be configured
      // shorter than the run it has to outlive. One entry per eligible type
      // (#346), even at `limit: 1`: which type this slot ends up with is not
      // known until the statement has run.
      expect(options.leases).toEqual([{ type: 'test.echo', leaseMs: 90_000 }]);
      expect(options.leases[0].leaseMs).toBeGreaterThan(30_000);
    });

    it('re-resolves eligible types per claim rather than capturing them at start', async () => {
      const { worker, registry, claim } = makeWorker({
        'jobs.workerConcurrency': 1,
        'jobs.pollMs': 5,
      });

      registry.register(handler('test.first', async () => undefined));

      worker.start(1);
      await waitFor(() => claim.mock.calls.length >= 1);

      // A handler registered AFTER the pool started — the situation a
      // bootstrap-time capture would never see.
      registry.register(handler('test.second', async () => undefined));

      await waitFor(() =>
        claim.mock.calls.some((call) =>
          (call[0] as ClaimOptions).eligibleTypes.includes('test.second')
        )
      );

      await worker.stop();
    });

    it('backs off instead of spinning when the claim query itself fails', async () => {
      const { worker, claim, error } = makeWorker({
        'jobs.workerConcurrency': 1,
        'jobs.pollMs': 5,
      });

      claim.mockRejectedValue(new Error('connection terminated'));

      worker.start(1);
      await waitFor(() => error.mock.calls.length >= 1);
      await worker.stop();

      expect(String(error.mock.calls[0][0])).toContain('connection terminated');
    });
  });

  // ---------------------------------------------------------------------------
  // Per-type execution profiles (#346)
  // ---------------------------------------------------------------------------

  describe('per-type execution profiles', () => {
    /** A handler carrying a profile. */
    function profiled(type: string, maxRuntimeMs: number, maxAttempts = 3): JobHandler {
      return { type, profile: { maxRuntimeMs, maxAttempts }, process: async () => undefined };
    }

    beforeEach(() => {
      resetJobProfileWarnings();
    });

    it('claims a profiled type under a lease derived from ITS ceiling', async () => {
      const { worker, registry, claim } = makeWorker({
        'jobs.workerConcurrency': 1,
        'jobs.jobTimeoutMs': 30_000,
      });

      registry.register(profiled('test.slow', 7_200_000));

      worker.start(1);
      await waitFor(() => claim.mock.calls.length > 0);
      await worker.stop();

      const options = claim.mock.calls[0][0] as ClaimOptions;

      // Its own ceiling plus the same grace — NOT the 30s deployment timeout
      // this worker is otherwise configured with.
      expect(options.leases).toEqual([{ type: 'test.slow', leaseMs: 7_260_000 }]);
    });

    it('gives each type in a heterogeneous claim its own lease', async () => {
      // The in-process worker offers every registered type and takes whichever
      // row is most urgent, so it cannot know which type it will get. One
      // lease per type is what lets the statement stamp the right one.
      const { worker, registry, claim } = makeWorker({
        'jobs.workerConcurrency': 1,
        'jobs.jobTimeoutMs': 30_000,
      });

      registry.register(profiled('test.slow', 7_200_000));
      registry.register(profiled('test.brief', 5_000));
      registry.register(handler('test.plain', async () => undefined));

      worker.start(1);
      await waitFor(() => claim.mock.calls.length > 0);
      await worker.stop();

      const options = claim.mock.calls[0][0] as ClaimOptions;

      expect(options.leases).toEqual([
        { type: 'test.slow', leaseMs: 7_260_000 },
        { type: 'test.brief', leaseMs: 65_000 },
        { type: 'test.plain', leaseMs: 90_000 },
      ]);
    });

    it('covers every eligible type it offers, so the claim’s join cannot drop a row', async () => {
      const { worker, registry, claim } = makeWorker({ 'jobs.workerConcurrency': 1 });

      registry.register(profiled('test.slow', 7_200_000));
      registry.register(handler('test.plain', async () => undefined));

      worker.start(1);
      await waitFor(() => claim.mock.calls.length > 0);
      await worker.stop();

      const options = claim.mock.calls[0][0] as ClaimOptions;

      expect(options.leases.map(({ type }) => type)).toEqual(options.eligibleTypes);
    });

    it('times a profiled job out on its OWN ceiling, not the deployment’s', async () => {
      // The lease and the timeout must read the same ceiling. A timeout taken
      // from the global while the lease came from the profile is the
      // self-reaping job this whole feature exists to make unrepresentable.
      const { worker, registry, completeFailed } = makeWorker({ 'jobs.jobTimeoutMs': 600_000 });

      registry.register({
        type: 'test.hang',
        profile: { maxRuntimeMs: 20, maxAttempts: 3 },
        process: () => new Promise<void>(() => undefined),
      });

      const outcome = await worker.runJob(claimedJob('test.hang'));

      expect(outcome).toBe('failed');

      const [, error] = completeFailed.mock.calls[0];

      expect(error).toBeInstanceOf(JobTimeoutError);
      expect((error as JobTimeoutError).timeoutMs).toBe(20);
    });

    it('lets a profile of maxRuntimeMs 0 disable the timeout for that type alone', async () => {
      const { worker, registry, completeSucceeded } = makeWorker({ 'jobs.jobTimeoutMs': 20 });

      let release: () => void = () => undefined;
      const work = new Promise<void>((resolve) => {
        release = resolve;
      });

      registry.register({
        type: 'test.unbounded',
        profile: { maxRuntimeMs: 0, maxAttempts: 3 },
        process: () => work,
      });

      const settled = worker.runJob(claimedJob('test.unbounded'));

      // Well past the 20ms deployment timeout, which does not apply here.
      await new Promise((resolve) => setTimeout(resolve, 60));
      release();

      await expect(settled).resolves.toBe('succeeded');
      expect(completeSucceeded).toHaveBeenCalledTimes(1);
    });

    it('leaves an UNPROFILED type exactly as it was', async () => {
      // The regression guard: same lease, same timeout, same everything for
      // every handler that did not ask for a profile.
      const { worker, registry, claim, completeFailed } = makeWorker({
        'jobs.workerConcurrency': 1,
        'jobs.jobTimeoutMs': 20,
      });

      registry.register(handler('test.hang', () => new Promise<void>(() => undefined)));

      worker.start(1);
      await waitFor(() => claim.mock.calls.length > 0);
      await worker.stop();

      expect((claim.mock.calls[0][0] as ClaimOptions).leases).toEqual([
        { type: 'test.hang', leaseMs: 60_020 },
      ]);

      await worker.runJob(claimedJob('test.hang'));

      expect((completeFailed.mock.calls[0][1] as JobTimeoutError).timeoutMs).toBe(20);
    });

    it('falls back to the deployment numbers when the profile is unusable', async () => {
      const { worker, registry, claim, completeFailed } = makeWorker({
        'jobs.workerConcurrency': 1,
        'jobs.jobTimeoutMs': 20,
      });

      registry.register({
        type: 'test.hang',
        profile: { maxRuntimeMs: Number.NaN, maxAttempts: 3 },
        process: () => new Promise<void>(() => undefined),
      });

      worker.start(1);
      await waitFor(() => claim.mock.calls.length > 0);
      await worker.stop();

      expect((claim.mock.calls[0][0] as ClaimOptions).leases).toEqual([
        { type: 'test.hang', leaseMs: 60_020 },
      ]);

      await worker.runJob(claimedJob('test.hang'));

      expect((completeFailed.mock.calls[0][1] as JobTimeoutError).timeoutMs).toBe(20);
    });
  });

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  describe('runJob', () => {
    it('settles a successful job through completeSucceeded, never by writing a row', async () => {
      const { worker, registry, completeSucceeded, completeFailed } = makeWorker();

      const ran = jest.fn();
      registry.register(
        handler('test.echo', async () => {
          ran();
        })
      );

      const job = claimedJob('test.echo');

      await expect(worker.runJob(job)).resolves.toBe('succeeded');

      expect(ran).toHaveBeenCalledTimes(1);
      expect(completeSucceeded).toHaveBeenCalledWith(job);
      expect(completeFailed).not.toHaveBeenCalled();
    });

    it('routes a thrown handler error through completeFailed unchanged', async () => {
      const { worker, registry, completeFailed, completeSucceeded } = makeWorker();

      const boom = new Error('handler exploded');
      registry.register(
        handler('test.echo', async () => {
          throw boom;
        })
      );

      const job = claimedJob('test.echo');

      await expect(worker.runJob(job)).resolves.toBe('failed');

      // No `permanent` flag: an ordinary failure must keep its retry budget.
      expect(completeFailed).toHaveBeenCalledWith(job, boom);
      expect(completeSucceeded).not.toHaveBeenCalled();
    });

    it('waits out a provider cooldown before running the handler', async () => {
      const slept: number[] = [];
      let current = 1_000;

      const clock: JobClock = {
        now: () => current,
        sleep: async (ms: number) => {
          slept.push(ms);
          current += ms;
        },
      };

      // The REAL gate, so this proves the worker and the throttle agree
      // rather than proving a mock.
      const throttle = new ProviderThrottleService(
        { get: () => 900_000 } as unknown as ConfigService,
        clock
      );

      const { worker, registry } = makeWorker({}, throttle);

      throttle.registerProviderKey('test.provider', 'acme');
      throttle.trip('test.provider', 20_000);

      const ran = jest.fn();
      registry.register(
        handler('test.provider', async () => {
          ran();
        })
      );

      await expect(worker.runJob(claimedJob('test.provider'))).resolves.toBe('succeeded');

      expect(slept).toEqual([20_000]);
      expect(ran).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // A claimed job with no handler
  // ---------------------------------------------------------------------------

  describe('a job whose type has no registered handler', () => {
    it('fails it TERMINALLY through the chokepoint, with the claim released', async () => {
      const { worker, completeFailed, completeSucceeded } = makeWorker();

      const job = claimedJob('test.vanished');

      await expect(worker.runJob(job)).resolves.toBe('failed');

      expect(completeSucceeded).not.toHaveBeenCalled();
      expect(completeFailed).toHaveBeenCalledTimes(1);

      const [settledJob, error, opts] = completeFailed.mock.calls[0];

      expect(settledJob).toBe(job);
      expect((error as Error).message).toContain('test.vanished');
      // PERMANENT, not a retry: the next attempt would find the same
      // registry and reach the same conclusion.
      expect(opts).toEqual({ permanent: true });
    });

    it('never calls a handler for a different type', async () => {
      const { worker, registry } = makeWorker();

      const other = jest.fn();
      registry.register(
        handler('test.other', async () => {
          other();
        })
      );

      await worker.runJob(claimedJob('test.vanished'));

      expect(other).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Per-job timeouts
  // ---------------------------------------------------------------------------

  describe('per-job timeouts', () => {
    it('frees the slot promptly and routes the timeout through the normal failure path', async () => {
      const { worker, registry, completeFailed } = makeWorker({ 'jobs.jobTimeoutMs': 20 });

      // Never settles on its own: only the timeout can end this.
      registry.register(handler('test.hang', () => new Promise<void>(() => undefined)));

      const started = Date.now();
      const outcome = await worker.runJob(claimedJob('test.hang'));

      expect(outcome).toBe('failed');
      expect(Date.now() - started).toBeLessThan(1_000);

      const [, error] = completeFailed.mock.calls[0];

      expect(error).toBeInstanceOf(JobTimeoutError);
      expect((error as JobTimeoutError).timeoutMs).toBe(20);
      expect((error as Error).message).toContain('test.hang');
    });

    it('produces NO unhandled rejection when the abandoned work rejects later', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };

      process.on('unhandledRejection', onUnhandled);

      try {
        const { worker, registry } = makeWorker({ 'jobs.jobTimeoutMs': 20 });

        let rejectWork: (reason: unknown) => void = () => undefined;
        const work = new Promise<void>((_resolve, reject) => {
          rejectWork = reject;
        });

        registry.register(handler('test.hang', () => work));

        await expect(worker.runJob(claimedJob('test.hang'))).resolves.toBe('failed');

        // THE PART A NAIVE Promise.race GETS WRONG: the work promise lost the
        // race, and now — with nobody waiting on it any more — it rejects. If
        // the race did not attach its own reactions, this is an
        // unhandledRejection, which Node's default posture turns into a dead
        // process.
        rejectWork(new Error('the abandoned work failed, much later'));

        await drain(6);

        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('produces no unhandled rejection when the abandoned work RESOLVES later either', async () => {
      const { worker, registry, completeSucceeded } = makeWorker({ 'jobs.jobTimeoutMs': 20 });

      let finishWork: () => void = () => undefined;
      const work = new Promise<void>((resolve) => {
        finishWork = resolve;
      });

      registry.register(handler('test.slow', () => work));

      await expect(worker.runJob(claimedJob('test.slow'))).resolves.toBe('failed');

      finishWork();
      await drain(6);

      // The late success must NOT retroactively mark the job succeeded — the
      // row has already been settled by the timeout's failure path.
      expect(completeSucceeded).not.toHaveBeenCalled();
    });

    it('leaves the work untouched when the timeout is disabled with 0', async () => {
      const { worker, registry, completeSucceeded } = makeWorker({ 'jobs.jobTimeoutMs': 0 });

      registry.register(
        handler('test.slow', async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        })
      );

      await expect(worker.runJob(claimedJob('test.slow'))).resolves.toBe('succeeded');
      expect(completeSucceeded).toHaveBeenCalledTimes(1);
    });

    it('cancels the timeout timer as soon as the job finishes', async () => {
      const { worker, registry } = makeWorker({ 'jobs.jobTimeoutMs': 60_000 });

      registry.register(handler('test.echo', async () => undefined));

      await worker.runJob(claimedJob('test.echo'));

      // A 60-second timer left behind per job is how a busy queue accumulates
      // thousands of them.
      expect((worker as unknown as { timers: Set<unknown> }).timers.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Independent slots
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Lease renewal (#347)
  // ---------------------------------------------------------------------------

  describe('lease renewal', () => {
    // FAKE TIMERS, BECAUSE THE FLOOR IS FIVE SECONDS. `resolveRenewIntervalMs`
    // clamps to `[5s, 60s]` on purpose (a short lease must not produce a
    // renewal storm), so a real-timer test of "it renews twice" would sit
    // there for two minutes. What is being asserted is a schedule, and a
    // schedule is exactly the thing fake timers are honest about.
    afterEach(() => {
      jest.useRealTimers();
    });

    it('renews on a schedule for the whole of process(), and stops when it ends', async () => {
      jest.useFakeTimers();

      // Timeouts disabled → the unbounded one-hour lease → a 60s interval
      // (the clamp's ceiling, since an hour divided by three is far past it).
      const { worker, registry, renew } = makeWorker({ 'jobs.jobTimeoutMs': 0 });

      let finish: () => void = () => undefined;
      registry.register(
        handler(
          'test.long',
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            })
        )
      );

      const run = worker.runJob(claimedJob('test.long'));

      // NOTHING YET. The first renewal is due one interval in, not at claim
      // time — the claim already wrote a lease.
      await jest.advanceTimersByTimeAsync(59_000);
      expect(renew).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1_000);
      expect(renew).toHaveBeenCalledTimes(1);

      // THE ARGUMENTS ARE THE CONTRACT: the job's own id, the SAME lease the
      // claim took, and a `null` node id (this worker claimed as `server`).
      expect(renew).toHaveBeenCalledWith('job-test.long', 3_600_000, null);

      // It keeps going — a job that renewed once and stopped is a job the
      // reaper takes away a lease later.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(renew).toHaveBeenCalledTimes(2);

      finish();
      await expect(run).resolves.toBe('succeeded');

      // AND IT STOPS. A ticker left running would renew a settled row, and
      // (once the terminal write lands) log a false "no longer held" alarm.
      const settled = renew.mock.calls.length;
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(renew).toHaveBeenCalledTimes(settled);
    });

    it('renews on the TYPE’s lease when it has a profile, not the deployment’s', async () => {
      jest.useFakeTimers();

      // The deployment says 30s (→ a 90s lease → a 30s interval). The type
      // says "no ceiling" (→ the one-hour lease → a 60s interval). If the
      // ticker read the global, it would fire at 30s; if it reads the profile
      // — as the CLAIM did — the first renewal lands at 60s carrying the
      // hour-long lease. Renewing a six-hour job with a ten-minute extension
      // is the exact failure mode #346's profiles exist to make impossible.
      const { worker, registry, renew } = makeWorker({ 'jobs.jobTimeoutMs': 30_000 });

      let finish: () => void = () => undefined;
      registry.register({
        type: 'test.profiled',
        profile: { maxRuntimeMs: 0, maxAttempts: 3 },
        process: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      });

      const run = worker.runJob(claimedJob('test.profiled'));

      await jest.advanceTimersByTimeAsync(30_000);
      expect(renew).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(30_000);
      expect(renew).toHaveBeenCalledWith('job-test.profiled', 3_600_000, null);

      finish();
      await run;
    });

    it('stops renewing, at error, once the row is no longer held', async () => {
      jest.useFakeTimers();

      const { worker, registry, renew, error } = makeWorker({ 'jobs.jobTimeoutMs': 0 });
      renew.mockResolvedValue(false);

      let finish: () => void = () => undefined;
      registry.register(
        handler(
          'test.lost',
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            })
        )
      );

      const run = worker.runJob(claimedJob('test.lost'));

      await jest.advanceTimersByTimeAsync(60_000);
      expect(renew).toHaveBeenCalledTimes(1);

      // ONE renewal, then silence: a worker that has lost the row must not go
      // on re-forging the queue's view of it.
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(renew).toHaveBeenCalledTimes(1);

      expect(
        error.mock.calls.some((call) => String(call[0]).includes('no longer held by this worker'))
      ).toBe(true);

      // AND THE WORK RUNS ON. JavaScript cannot cancel a promise mid-await
      // (`withTimeout` says the same), so the honest outcome is that this
      // attempt finishes and reports; making the pre-existing at-least-once
      // reality visible is the whole of what this changes.
      finish();
      await expect(run).resolves.toBe('succeeded');
    });

    it('treats a transient database failure as a retry, not a lost lease', async () => {
      jest.useFakeTimers();

      const { worker, registry, renew, warn } = makeWorker({ 'jobs.jobTimeoutMs': 0 });
      renew.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValue(true);

      let finish: () => void = () => undefined;
      registry.register(
        handler(
          'test.flaky',
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            })
        )
      );

      const run = worker.runJob(claimedJob('test.flaky'));

      await jest.advanceTimersByTimeAsync(60_000);
      expect(renew).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('Could not renew'))).toBe(
        true
      );

      // The lease is three intervals long by construction, so one failure
      // costs nothing and giving up on it would lose a healthy job.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(renew).toHaveBeenCalledTimes(2);

      finish();
      await run;
    });

    it('does not renew across a provider cooldown, which holds nothing', async () => {
      jest.useFakeTimers();

      // The ticker starts AFTER `throttle.acquire` resolves. A slot parked in
      // a cooldown is not running anything, and extending a lease over a wait
      // is exactly the "held but idle" state a lease exists to expose.
      let releaseThrottle: () => void = () => undefined;
      const acquire = jest.fn(
        () =>
          new Promise<number>((resolve) => {
            releaseThrottle = () => resolve(0);
          })
      );

      const { worker, registry, renew } = makeWorker({ 'jobs.jobTimeoutMs': 0 }, {
        acquire,
      } as unknown as ProviderThrottleService);

      let finish: () => void = () => undefined;
      registry.register(
        handler(
          'test.throttled',
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            })
        )
      );

      const run = worker.runJob(claimedJob('test.throttled'));

      await jest.advanceTimersByTimeAsync(5 * 60_000);
      expect(renew).not.toHaveBeenCalled();

      releaseThrottle();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(renew).toHaveBeenCalledTimes(1);

      finish();
      await run;
    });

    it('registers the ticker in the shutdown timer set, so stop() cancels it', async () => {
      jest.useFakeTimers();

      // THE `PendingTimer` CONTRACT, and the reason the ticker is not a bare
      // `setInterval`: a renewal timer must never hold a closing process open,
      // and `stop()` must kill it in milliseconds rather than after a full
      // interval.
      const { worker, registry, renew } = makeWorker({ 'jobs.jobTimeoutMs': 0 });
      const timers = (worker as unknown as { timers: Set<unknown> }).timers;

      let finish: () => void = () => undefined;
      registry.register(
        handler(
          'test.shutdown',
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            })
        )
      );

      const run = worker.runJob(claimedJob('test.shutdown'));
      await jest.advanceTimersByTimeAsync(0);

      expect(timers.size).toBe(1);

      await worker.stop();

      expect(timers.size).toBe(0);

      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(renew).not.toHaveBeenCalled();

      finish();
      await run;
    });
  });

  describe('independent slot loops', () => {
    it('does not let a slow job in one slot delay a fast job in another', async () => {
      const { worker, registry, claim, completeSucceeded } = makeWorker({
        'jobs.workerConcurrency': 2,
        'jobs.pollMs': 60_000,
      });

      const finished: string[] = [];

      registry.register(
        handler('test.slow', async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          finished.push('test.slow');
        })
      );
      registry.register(
        handler('test.fast', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          finished.push('test.fast');
        })
      );

      // Slot 0 takes the slow job, slot 1 takes the fast one, and there is
      // nothing else to claim.
      claim
        .mockResolvedValueOnce([claimedJob('test.slow')])
        .mockResolvedValueOnce([claimedJob('test.fast')])
        .mockResolvedValue([]);

      worker.start(2);

      await waitFor(() => finished.includes('test.fast'));

      // THE ASSERTION: the fast job is done while the slow one is still
      // running. Under one loop claiming a batch of two, this array would be
      // empty until the slow job finished — the batch barrier.
      expect(finished).toEqual(['test.fast']);
      expect(completeSucceeded).toHaveBeenCalledTimes(1);

      await worker.stop();

      expect(finished).toEqual(['test.fast', 'test.slow']);
    });

    it('starts exactly as many loops as the configured concurrency', async () => {
      const { worker, claim } = makeWorker({
        'jobs.workerConcurrency': 3,
        'jobs.pollMs': 60_000,
      });

      worker.onApplicationBootstrap();
      await drain();

      // Each loop claims once, finds nothing, and parks in its poll sleep.
      expect(claim).toHaveBeenCalledTimes(3);

      await worker.onModuleDestroy();
    });

    it('is idempotent: a second start does not double the pool', async () => {
      const { worker, claim } = makeWorker({ 'jobs.pollMs': 60_000 });

      worker.start(2);
      worker.start(2);
      await drain();

      expect(claim).toHaveBeenCalledTimes(2);

      await worker.stop();
    });

    it('does not sleep between jobs while the queue still has work', async () => {
      const { worker, registry, claim, completeSucceeded } = makeWorker({
        'jobs.workerConcurrency': 1,
        // A poll interval this long makes the assertion unambiguous: three
        // jobs inside a second is only possible without a sleep between them.
        'jobs.pollMs': 600_000,
      });

      registry.register(handler('test.echo', async () => undefined));

      claim
        .mockResolvedValueOnce([claimedJob('test.echo', { id: 'a' })])
        .mockResolvedValueOnce([claimedJob('test.echo', { id: 'b' })])
        .mockResolvedValueOnce([claimedJob('test.echo', { id: 'c' })])
        .mockResolvedValue([]);

      worker.start(1);
      await waitFor(() => completeSucceeded.mock.calls.length === 3);
      await worker.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  describe('shutdown', () => {
    it('resolves promptly from a sleeping pool and leaves no timer behind', async () => {
      const { worker, claim } = makeWorker({
        'jobs.workerConcurrency': 3,
        // If shutdown waited a poll interval out, this test would take a
        // minute rather than milliseconds.
        'jobs.pollMs': 60_000,
      });

      worker.start(3);
      await waitFor(() => claim.mock.calls.length === 3);
      await waitFor(() => (worker as unknown as { timers: Set<unknown> }).timers.size === 3);

      const started = Date.now();
      await worker.onModuleDestroy();

      expect(Date.now() - started).toBeLessThan(1_000);
      expect((worker as unknown as { timers: Set<unknown> }).timers.size).toBe(0);
    });

    it('stops claiming immediately', async () => {
      const { worker, claim } = makeWorker({ 'jobs.pollMs': 1 });

      worker.start(1);
      await waitFor(() => claim.mock.calls.length >= 1);
      await worker.stop();

      const callsAtStop = claim.mock.calls.length;
      await drain(8);

      expect(claim.mock.calls.length).toBe(callsAtStop);
    });

    it('is safe to call when the pool never started, and safe to call twice', async () => {
      const { worker } = makeWorker({ 'jobs.workerMode': 'off' });

      worker.onApplicationBootstrap();

      await expect(worker.stop()).resolves.toBeUndefined();
      await expect(worker.stop()).resolves.toBeUndefined();
    });

    it('gives up on a job that outlives the grace rather than blocking the shutdown', async () => {
      const { worker, registry, claim } = makeWorker({
        'jobs.workerConcurrency': 1,
        'jobs.jobTimeoutMs': 0,
      });

      let release: () => void = () => undefined;
      const forever = new Promise<void>((resolve) => {
        release = resolve;
      });

      registry.register(handler('test.hang', () => forever));
      claim.mockResolvedValueOnce([claimedJob('test.hang')]).mockResolvedValue([]);

      worker.start(1);
      await waitFor(() => claim.mock.calls.length >= 1);

      const started = Date.now();
      // A short grace, because the point is that the wait is BOUNDED: the
      // row is left `running` with a lease for the reaper (#263).
      await worker.stop(30);

      expect(Date.now() - started).toBeLessThan(1_000);

      release();
      await drain();
    });

    it('does not start a pool at all when concurrency is zero', async () => {
      const { worker, claim, warn } = makeWorker({ 'jobs.workerConcurrency': 0 });

      worker.onApplicationBootstrap();
      await drain();

      expect(claim).not.toHaveBeenCalled();
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes('JOBS_WORKER_CONCURRENCY'))
      ).toBe(true);

      await worker.onModuleDestroy();
    });
  });

  // ---------------------------------------------------------------------------
  // Defensive configuration
  // ---------------------------------------------------------------------------

  describe('configuration fallbacks', () => {
    it('degrades a missing poll interval to the shipped default, never to NaN', async () => {
      // `setTimeout(NaN)` fires immediately, which would spin the event loop
      // flat out — the reason `configNumber` exists.
      const { worker, claim } = makeWorker({ 'jobs.pollMs': undefined });

      worker.start(1);
      await waitFor(() => claim.mock.calls.length >= 1);
      await drain(8);

      expect(claim.mock.calls.length).toBe(1);

      await worker.stop();
    });
  });
});
