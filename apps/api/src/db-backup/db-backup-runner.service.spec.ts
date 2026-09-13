import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { Logger } from '@nestjs/common';
import { Prisma, type Job } from '@prisma/client';

import type { ConfigService } from '@nestjs/config';

import type { DbBackupRunResult } from '../jobs/contracts/db-backup-run.contract';
import { ACTIVE_DEDUP_INDEX_NAME, type JobsService } from '../jobs/jobs.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import type { StorageProvider } from '../storage/providers/storage-provider.interface';
import type { SystemDatabaseBackupValue } from '../common/schemas/settings.schema';
import {
  ACTIVE_RUN_INDEX_NAME,
  BACKUP_HEARTBEAT_INTERVAL_MS,
  BACKUP_JOB_DEDUP_KEY,
  BACKUP_JOB_TYPE,
  DatabaseBackupRunnerService,
  isActiveRunConflict,
  systemBackupTimers,
  type BackupTimers,
  type DatabaseBackupEngine,
} from './db-backup-runner.service';
import { DB_BACKUP_SWEEP_TYPE } from './handlers/db-backup-sweep.handler';
import { BACKUP_KEY_PREFIX } from './db-backup-storage';
import {
  DatabaseBackupAlreadyRunningError,
  DatabaseBackupCancelledError,
  DatabaseBackupVerificationError,
  DatabaseBackupStorageProviderError,
} from './db-backup.errors';
import type { PgProcess } from './pg-dump.util';
import type { PgVersionCheck } from './pg-version.util';

// =============================================================================
// The backup engine's acceptance criteria, one describe block each (#281)
// =============================================================================
//
// Everything here runs with NO PostgreSQL binaries, NO database and NO bucket:
// the `DatabaseBackupEngine` seam stands in for `pg_dump`/`pg_restore`, a fake
// `StorageProvider` stands in for S3, and a small in-memory Prisma double
// stands in for the table. That is the point — a suite that needed any of the
// three is a suite CI skips, and a skipped test guards nothing.
//
// The one thing NOT faked is the streaming itself: every test below drives real
// `Readable`/`Transform` plumbing, because the properties under test (the
// archive is never materialised; a truncated stream still fails the run) are
// properties OF that plumbing.
// =============================================================================

// -----------------------------------------------------------------------------
// Doubles
// -----------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/** Yields to the event loop so stream machinery can make progress. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Polls `condition` until it holds, so a test never asserts on a half-flushed pipeline. */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    if (condition()) return;
    await tick();
  }

  throw new Error(`timed out waiting for: ${label}`);
}

/**
 * A `pg_dump` this test drives by hand: push bytes, then finish or die.
 *
 * `done` carries its own idle `.catch()` exactly as `spawnPgProcess` does, so
 * rejecting it before the service attaches its handler is not an unhandled
 * rejection.
 */
class ManualDump implements PgProcess {
  readonly stdout: Readable;
  readonly kill = jest.fn<void, [NodeJS.Signals?]>();

  private readonly settle = deferred();
  readonly done = this.settle.promise;
  private readonly ownsStdout: boolean;

  /**
   * @param stdout an externally driven source, for the large-fixture test —
   * which needs a stream that HONOURS BACK-PRESSURE. The default push-driven
   * stream deliberately does not, so that a test can queue bytes freely.
   */
  constructor(stdout?: Readable) {
    this.ownsStdout = stdout === undefined;
    this.stdout = stdout ?? new Readable({ read: () => undefined });
    void this.done.catch(() => undefined);
  }

  push(chunk: Buffer): void {
    this.stdout.push(chunk);
  }

  /** A clean exit: stdout ends, exit code 0. */
  finish(): void {
    if (this.ownsStdout) this.stdout.push(null);
    this.settle.resolve();
  }

  /**
   * A dump that dies mid-flight. Note it ENDS its stdout — that is what makes
   * a truncated archive look like a complete one to a naive consumer.
   */
  die(error: Error): void {
    if (this.ownsStdout) this.stdout.push(null);
    this.settle.reject(error);
  }
}

const OK_VERSION: PgVersionCheck = {
  status: 'ok',
  clientMajor: 17,
  serverMajor: 17,
  message: 'ok',
};

const POLICY: SystemDatabaseBackupValue = {
  enabled: true,
  frequency: 'daily',
  dayOfWeek: 0,
  dayOfMonth: 1,
  timeOfDay: '02:00',
  timezone: 'UTC',
  retentionCount: 7,
  storageProvider: 's3',
  runStaleMinutes: 120,
  compressionLevel: 6,
  restoreRollbackMode: 'retain_database',
  oldDatabaseRetentionHours: 48,
  nodeOffloadEnabled: false,
};

interface HarnessOptions {
  policy?: Partial<SystemDatabaseBackupValue>;
  /** Errors the first N `create` calls throw, in order. */
  createFailures?: unknown[];
  /** What `findFirst` reports as the active run. */
  activeRunId?: string | null;
  version?: PgVersionCheck;
  /** Table-of-contents entries the verification step reads back. */
  tocEntries?: number;
  uploadImpl?: StorageProvider['upload'];
  downloadImpl?: StorageProvider['download'];
  deleteImpl?: StorageProvider['delete'];
  timers?: BackupTimers;
  /** A back-pressure-honouring stdout for the dump, instead of the push-driven default. */
  dumpStdout?: Readable;
  /** #288: what `ConfigService.get('appUrl')` returns. */
  appUrl?: string;
  /** #288: a notifier that misbehaves, for the containment assertions. */
  notifyImpl?: () => Promise<void>;
  /** #351: errors `JobsService.enqueueWithin` throws, in order. */
  enqueueFailures?: unknown[];
  /** #351: what `job.findFirst` reports as the active `db.backup.run` job. */
  activeBackupJob?: { id: string; backupRun: { id: string } | null } | null;
  /** #351: rows `databaseBackupRun.findUnique` answers with, keyed by `jobId`. */
  runsByJobId?: Record<string, Record<string, unknown>>;
}

function makeHarness(options: HarnessOptions = {}) {
  /** Every side effect in the order it happened, for the ordering assertions. */
  const order: string[] = [];

  const rows = new Map<string, Record<string, unknown>>();
  const settled = deferred<Record<string, unknown>>();
  const createFailures = [...(options.createFailures ?? [])];

  const dumps: ManualDump[] = [];
  const uploads: Array<{ key: string; stream: unknown; options: unknown }> = [];
  /** #351: every `jobs` row the fake queue accepted, in order. */
  const jobRows: Array<Record<string, unknown>> = [];
  const enqueueFailures = [...(options.enqueueFailures ?? [])];
  /** Bytes the fake provider has actually pulled through the metering stream. */
  const progress = { uploaded: 0 };

  const prismaBase = {
    databaseBackupRun: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        order.push('create');

        const failure = createFailures.shift();
        if (failure !== undefined) throw failure;

        rows.set(data.id as string, { ...data });
        return { ...data };
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const status = (data.status as string | undefined) ?? 'heartbeat';
          order.push(`update:${status}`);

          const row = { ...(rows.get(where.id) ?? {}), ...data };
          rows.set(where.id, row);

          // ONE TICK LATER, so `executeRun`'s `finally` (clear the heartbeat,
          // release the cancel handle) has run by the time a test asserts on it.
          if (status === 'completed' || status === 'failed') {
            setImmediate(() => settled.resolve(row));
          }

          return row;
        }
      ),
      findFirst: jest.fn(async () => {
        order.push('findFirst');
        return options.activeRunId === undefined || options.activeRunId === null
          ? null
          : { id: options.activeRunId };
      }),
      // #351: `resolveRunForJob`'s single lookup on the UNIQUE `job_id`.
      findUnique: jest.fn(async ({ where }: { where: { jobId?: string; id?: string } }) => {
        order.push('findUnique');

        if (where.jobId !== undefined) {
          const seeded = options.runsByJobId?.[where.jobId];
          if (seeded !== undefined) return { ...seeded };

          for (const row of rows.values()) {
            if (row.jobId === where.jobId) return { ...row };
          }

          return null;
        }

        return where.id !== undefined ? (rows.get(where.id) ?? null) : null;
      }),
    },
    // #351: the queue's side of `resolveQueueConflict`.
    job: {
      findFirst: jest.fn(async (args: { where?: { type?: string } } = {}) => {
        // #353: two callers now. `resolveQueueConflict` asks about
        // `db.backup.run`; `enqueueHousekeepingJob` asks about
        // `db.backup.sweep` before queueing retention. Only the first is what
        // `activeBackupJob` describes.
        if (args.where?.type === DB_BACKUP_SWEEP_TYPE) return null;

        order.push('job.findFirst');
        return options.activeBackupJob ?? null;
      }),
    },
    // Tagged-template double: the audit reads are best-effort, so answering
    // both with a plausible row proves they land on the row rather than that
    // the SQL is right (which only a real Postgres can say).
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (sql.includes('server_version')) return [{ server_version: '17.4' }];
      if (sql.includes('_prisma_migrations')) {
        return [{ migration_name: '20260907120000_add_database_backup_runs' }];
      }
      return [];
    }),
  };

  /**
   * #351: `$transaction` with a real ROLLBACK, not a pass-through.
   *
   * The fake undoes both writes when the callback throws, because the single
   * property `queueBackup` is built on is that a failed enqueue leaves NO
   * `pending` run row behind — and a `$transaction` double that simply ran the
   * callback would let that regression pass with the test still green.
   */
  const $transaction = jest.fn(async (fn: (tx: typeof prismaBase) => Promise<unknown>) => {
    const rowsBefore = new Map(rows);
    const jobsBefore = jobRows.length;

    try {
      return await fn(prismaBase);
    } catch (error) {
      rows.clear();
      for (const [key, value] of rowsBefore) rows.set(key, value);
      jobRows.length = jobsBefore;
      throw error;
    }
  });

  const prisma = Object.assign(prismaBase, { $transaction });

  /**
   * #351: the queue seam. `enqueueWithin` deliberately does NOT collapse onto
   * an existing job — see its own doc comment: inside a transaction it cannot,
   * so it lets the conflict propagate and `resolveQueueConflict` deals with it
   * after the rollback. The double mirrors exactly that.
   */
  const enqueueWithin = jest.fn(async (_tx: unknown, input: Record<string, unknown>) => {
    order.push('enqueue');

    const failure = enqueueFailures.shift();
    if (failure !== undefined) throw failure;

    const job = { id: `job-${jobRows.length + 1}`, ...input };
    jobRows.push(job);

    return job;
  });
  /**
   * #353: retention is no longer awaited inside `completeRun` — it is a
   * `db.backup.sweep` job. This double stands in for that enqueue, and
   * `order.push('sweep')` is what every ordering assertion below now reads.
   */
  const enqueueSweep = jest.fn(async (input: Record<string, unknown>) => {
    if (input.type === DB_BACKUP_SWEEP_TYPE) order.push('sweep');

    const failure = enqueueFailures.shift();
    if (failure !== undefined) throw failure;

    return { id: `job-${jobRows.length + 1}`, ...input };
  });

  const jobs = { enqueueWithin, enqueue: enqueueSweep } as unknown as JobsService;

  const settings = {
    getDatabaseBackupPolicy: jest.fn(async () => ({ ...POLICY, ...options.policy })),
  };

  const storage = {
    getBucket: jest.fn(() => 'test-bucket'),
    upload:
      options.uploadImpl ??
      (jest.fn(async (key: string, stream: Readable, uploadOptions: unknown) => {
        order.push('upload');
        uploads.push({ key, stream, options: uploadOptions });

        // Real consumption, with real back-pressure — `for await` pulls.
        let bytes = 0;
        for await (const chunk of stream) {
          bytes += (chunk as Buffer).length;
          progress.uploaded = bytes;
        }

        return { key, bucket: 'test-bucket', location: `s3://test-bucket/${key}`, size: bytes };
      }) as unknown as StorageProvider['upload']),
    download:
      options.downloadImpl ??
      (jest.fn(async (key: string) => {
        order.push('download');
        return Readable.from([Buffer.from(`archive-of-${key}`)]);
      }) as unknown as StorageProvider['download']),
    delete:
      options.deleteImpl ??
      (jest.fn(async () => {
        order.push('delete');
      }) as unknown as StorageProvider['delete']),
  };

  const engine: DatabaseBackupEngine = {
    startDump: jest.fn(() => {
      order.push('startDump');
      const dump = new ManualDump(options.dumpStdout);
      dumps.push(dump);
      return dump;
    }),
    readTocEntryCount: jest.fn(async (source: Readable) => {
      order.push('readTocEntryCount');
      // Drain it: the real reader consumes the stream, and a test that did not
      // would leave a paused stream holding the fake provider open.
      for await (const _chunk of source) void _chunk;
      return options.tocEntries ?? 42;
    }),
    checkClientVersion: jest.fn(async () => {
      order.push('checkClientVersion');
      return options.version ?? OK_VERSION;
    }),
  };

  /** Fires the heartbeat on demand instead of on a clock. */
  const heartbeats: Array<() => void> = [];
  const cleared: NodeJS.Timeout[] = [];
  const timers: BackupTimers =
    options.timers ??
    ({
      setInterval: (handler: () => void) => {
        heartbeats.push(handler);
        return { id: heartbeats.length } as unknown as NodeJS.Timeout;
      },
      clearInterval: (handle: NodeJS.Timeout) => {
        cleared.push(handle);
      },
    } as BackupTimers);

  // #288's notifier. A jest mock rather than the real service: what this suite
  // proves about it is that a FAILING one cannot fail a backup, which needs a
  // seam that can be made to throw.
  const notifyPermissionHolders: jest.Mock = jest.fn(async (..._args: unknown[]) => {
    if (options.notifyImpl) await options.notifyImpl();
  });
  const notifications = {
    notifyPermissionHolders,
  } as unknown as NotificationsService;

  const config = {
    get: jest.fn((key: string) => (key === 'appUrl' ? options.appUrl : undefined)),
  } as unknown as ConfigService;

  const service = new DatabaseBackupRunnerService(
    prisma as unknown as PrismaService,
    settings as unknown as SystemSettingsService,
    storage as unknown as StorageProvider,
    notifications,
    config,
    jobs,
    engine,
    timers
  );

  return {
    service,
    notifyPermissionHolders,
    enqueueSweep,
    prisma,
    settings,
    storage,
    engine,
    jobs,
    enqueueWithin,
    jobRows,
    order,
    rows,
    dumps,
    uploads,
    heartbeats,
    cleared,
    progress,
    /** Resolves with the terminal row once the detached run has settled. */
    settled: settled.promise,
    /** Waits until the detached run has spawned its dump. */
    async firstDump(): Promise<ManualDump> {
      await waitFor(() => dumps.length > 0, 'the dump to be spawned');
      return dumps[0];
    },
  };
}

/** A P2002 shaped the way `@prisma/adapter-pg` reports it. */
function adapterConflict(indexName = ACTIVE_RUN_INDEX_NAME): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: {
      modelName: 'DatabaseBackupRun',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: `duplicate key value violates unique constraint "${indexName}"`,
          kind: 'UniqueConstraintViolation',
          constraint: { index: indexName },
        },
      },
    },
  });
}

beforeAll(() => {
  // The failure paths log at error/warn by design; keeping that out of the
  // suite's output is not the same as suppressing it in production.
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

// -----------------------------------------------------------------------------

describe('the claim', () => {
  it('is awaited: the caller gets a real run id and a running row', async () => {
    const h = makeHarness();

    const run = await h.service.startBackup({ trigger: 'manual', createdById: 'admin-1' });

    expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.status).toBe('running');
    expect(run.trigger).toBe('manual');
    expect(run.createdById).toBe('admin-1');
    expect(run.bucket).toBe('test-bucket');
    expect(run.storageKey.startsWith(BACKUP_KEY_PREFIX)).toBe(true);
    // The key contains the run's own id — the collision guarantee.
    expect(run.storageKey).toContain(run.id);
    // Seeded so the stale sweep has a baseline from the first moment.
    expect(run.lastHeartbeatAt).toBeInstanceOf(Date);

    (await h.firstDump()).finish();
    await h.settled;
  });

  it('detaches the dump, so the response does not wait on it', async () => {
    const h = makeHarness();

    await h.service.startBackup({ trigger: 'scheduled' });

    // `startBackup` has returned; the dump has not finished, and there is no
    // terminal update yet. This is the property a reverse proxy timeout makes
    // non-negotiable.
    const dump = await h.firstDump();
    expect(h.order).not.toContain('update:completed');

    dump.push(Buffer.from('bytes'));
    dump.finish();
    await h.settled;

    expect(h.order).toContain('update:completed');
  });

  it('lets the DATABASE decide the race: a P2002 becomes a typed already-running error', async () => {
    const h = makeHarness({
      createFailures: [adapterConflict()],
      activeRunId: 'winner-run-id',
    });

    await expect(h.service.startBackup({ trigger: 'manual' })).rejects.toBeInstanceOf(
      DatabaseBackupAlreadyRunningError
    );

    // ⚠ The lookup happens only AFTER the insert failed. A `findFirst` before
    // the `create` would be a check-then-act race, which is the entire reason
    // the index exists.
    expect(h.order).toEqual(['create', 'findFirst']);
  });

  it('carries the active run id, so the caller can name what is already running', async () => {
    const h = makeHarness({ createFailures: [adapterConflict()], activeRunId: 'winner-run-id' });

    await h.service.startBackup({ trigger: 'manual' }).then(
      () => {
        throw new Error('expected a rejection');
      },
      (error: unknown) => {
        expect((error as DatabaseBackupAlreadyRunningError).activeRunId).toBe('winner-run-id');
        expect((error as Error).message).toContain('winner-run-id');
      }
    );
  });

  it('retries when the winning run settled between the conflict and the lookup', async () => {
    // The slot is free again by the time we look, so "already running" would be
    // a false statement. Insert again instead.
    const h = makeHarness({ createFailures: [adapterConflict()], activeRunId: null });

    const run = await h.service.startBackup({ trigger: 'scheduled' });

    expect(run.status).toBe('running');
    expect(h.order.slice(0, 3)).toEqual(['create', 'findFirst', 'create']);

    (await h.firstDump()).finish();
    await h.settled;
  });

  it('lets an unrelated unique violation stay loud', async () => {
    const unrelated = adapterConflict('some_other_uniq_idx');
    const h = makeHarness({ createFailures: [unrelated] });

    await expect(h.service.startBackup({ trigger: 'manual' })).rejects.toBe(unrelated);
    expect(h.prisma.databaseBackupRun.findFirst).not.toHaveBeenCalled();
  });

  it('recognises the conflict through the classic query engine shape too', () => {
    const classic = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['status'] },
    });

    expect(isActiveRunConflict(classic)).toBe(true);
    expect(isActiveRunConflict(new Error('nope'))).toBe(false);
  });
});

describe('the streaming contract', () => {
  it('hands the storage provider a STREAM, never a buffer or a string', async () => {
    const h = makeHarness();

    await h.service.startBackup({ trigger: 'manual' });
    const dump = await h.firstDump();
    dump.push(Buffer.from('one'));
    dump.push(Buffer.from('two'));
    dump.finish();
    await h.settled;

    expect(h.uploads).toHaveLength(1);
    const sent = h.uploads[0].stream;
    expect(sent).toBeInstanceOf(Readable);
    expect(Buffer.isBuffer(sent)).toBe(false);
    expect(typeof sent).not.toBe('string');
    expect(Array.isArray(sent)).toBe(false);
    // No `contentLength`: a streamed dump's size is unknown until the last byte.
    expect((h.uploads[0].options as Record<string, unknown>).contentLength).toBeUndefined();
  });

  it('never materialises the archive: in-flight bytes stay bounded while a large fixture streams', async () => {
    // THE PROOF THAT NOTHING IS BUFFERED. A 64 MiB fixture is produced by a
    // source that honours back-pressure and consumed by a deliberately slow
    // reader; `maxInFlight` is the largest gap that ever opened between the
    // two. Streaming keeps it to a couple of pipeline high-water marks. An
    // implementation that collected the archive first — "just to hash it" —
    // would let the producer run to completion, and the gap would reach the
    // whole 64 MiB.
    const CHUNK = 256 * 1024;
    const CHUNKS = 256;
    const TOTAL = CHUNK * CHUNKS;

    let produced = 0;
    let consumed = 0;
    let maxInFlight = 0;

    const source = new Readable({
      highWaterMark: 64 * 1024,
      read() {
        if (produced >= TOTAL) {
          this.push(null);
          return;
        }
        produced += CHUNK;
        this.push(Buffer.alloc(CHUNK, 7));
      },
    });

    const upload = jest.fn(async (key: string, stream: Readable) => {
      for await (const chunk of stream) {
        consumed += (chunk as Buffer).length;
        maxInFlight = Math.max(maxInFlight, produced - consumed);
        if (consumed % (CHUNK * 16) === 0) await tick();
      }

      return { key, bucket: 'test-bucket', location: 'x' };
    }) as unknown as StorageProvider['upload'];

    const h = makeHarness({ uploadImpl: upload, dumpStdout: source });

    await h.service.startBackup({ trigger: 'scheduled' });
    const dump = await h.firstDump();
    source.on('end', () => dump.finish());

    const row = await h.settled;

    expect(consumed).toBe(TOTAL);
    expect(row.status).toBe('completed');
    expect(row.sizeBytes).toBe(BigInt(TOTAL));
    // A few high-water marks, not the archive. This IS the proof that nothing
    // is buffered — see the block comment above.
    //
    // There used to be a second assertion here, comparing
    // `process.memoryUsage()` before and after the run and requiring the
    // heap+external growth to stay under `TOTAL`. It was deleted (see CI
    // failure on PR #318: measured growth of 68217643 bytes against a
    // 67108864-byte bound) and MUST NOT be reintroduced in this or any
    // similar form. Two independent reasons, either one sufficient on its
    // own:
    //
    // 1. `process.memoryUsage()` reads whatever the heap happens to look
    //    like at the moment it is called, and the heap only shrinks when V8
    //    decides to run a collection. Nothing in this test forces one —
    //    `global.gc()` requires Node to be launched with `--expose-gc`,
    //    which this suite is not — so the number is at least as much a
    //    measurement of GC scheduling on the CI runner as it is of what the
    //    implementation actually retained. A metric that moves with the
    //    garbage collector's mood is not a metric a test can gate on.
    // 2. Even granting a favourable GC moment, there is no threshold that
    //    actually separates "streamed" from "buffered" here. A fully
    //    buffered implementation would grow by roughly `TOTAL` (64 MiB); the
    //    real, correctly-streaming implementation measured `TOTAL` + ~1.06
    //    MiB of incidental overhead on the CI run above. Any bound tight
    //    enough to catch a buffered implementation is also tight enough to
    //    be tripped by ordinary allocator/runtime noise, and any bound loose
    //    enough to tolerate that noise no longer catches a buffered
    //    implementation. Widening the bound to make CI green would not fix
    //    the test — it would leave an assertion that reads as coverage of
    //    "never materialises the archive" while being unable to fail for
    //    that reason.
    //
    // The `maxInFlight` assertion below is what actually proves the
    // no-buffering property, and it does so deterministically: it is a
    // running max of `produced - consumed`, both of which are plain byte
    // counters driven by the real stream's backpressure, not a snapshot of
    // process-wide memory. A buffered implementation (collect everything,
    // *then* hand it to the consumer) would let `produced` race to `TOTAL`
    // before `consumed` moves at all, pushing this gap to the full 64 MiB —
    // nowhere near the 8 MiB bound below. If a future implementation change
    // needs a memory-based check, it needs a differently-designed one (e.g.
    // asserting on byte counters the implementation itself reports, not on
    // `process.memoryUsage()`), not a resurrection of this one.
    expect(maxInFlight).toBeLessThan(8 * 1024 * 1024);
  });

  it('computes the checksum and the byte count in ONE pass, matching an independent hash', async () => {
    const chunks = [Buffer.from('alpha'), Buffer.from('bravo'), Buffer.alloc(4096, 3)];
    const expectedHash = createHash('sha256');
    let expectedBytes = 0;
    for (const chunk of chunks) {
      expectedHash.update(chunk);
      expectedBytes += chunk.length;
    }

    const h = makeHarness();
    await h.service.startBackup({ trigger: 'manual' });
    const dump = await h.firstDump();
    for (const chunk of chunks) dump.push(chunk);
    dump.finish();

    const row = await h.settled;

    expect(row.checksumSha256).toBe(expectedHash.digest('hex'));
    expect(row.sizeBytes).toBe(BigInt(expectedBytes));
    expect(row.bytesWritten).toBe(BigInt(expectedBytes));
    // One pass: the dump's stdout was read once, and the only OTHER read is the
    // verification, which reads the STORED object.
    expect(h.storage.download).toHaveBeenCalledTimes(1);
  });
});

describe('both halves of the transfer are awaited', () => {
  it('fails the run when the dump dies mid-stream EVEN THOUGH the upload resolved', async () => {
    // The upload sees a clean EOF on a truncated archive and reports success.
    // Only the exit code knows better.
    const upload = jest.fn(async (key: string) => ({
      key,
      bucket: 'test-bucket',
      location: 'x',
    })) as unknown as StorageProvider['upload'];

    const h = makeHarness({ uploadImpl: upload });
    await h.service.startBackup({ trigger: 'scheduled' });

    const dump = await h.firstDump();
    dump.push(Buffer.from('half an archive'));
    dump.die(new Error('pg_dump exited with code 1: connection lost'));

    const row = await h.settled;

    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('connection lost');
    expect(row.verifiedAt).toBeUndefined();
  });

  it('fails the run when the upload dies EVEN THOUGH the dump exits 0, and kills the dump', async () => {
    const upload = jest.fn(async () => {
      throw new Error('bucket refused the write');
    }) as unknown as StorageProvider['upload'];

    const h = makeHarness({ uploadImpl: upload });
    await h.service.startBackup({ trigger: 'manual' });

    const dump = await h.firstDump();
    dump.push(Buffer.from('bytes'));

    const row = await h.settled;

    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('bucket refused the write');
    // Otherwise pg_dump keeps reading a whole database for an archive nobody
    // is storing.
    expect(dump.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('verification', () => {
  it('reads the UPLOADED OBJECT back before marking the run completed', async () => {
    const h = makeHarness({ tocEntries: 128 });

    const run = await h.service.startBackup({ trigger: 'manual' });
    (await h.firstDump()).finish();
    const row = await h.settled;

    expect(h.storage.download).toHaveBeenCalledWith(run.storageKey);
    // The order is the assertion: verify, THEN complete.
    expect(h.order.indexOf('download')).toBeLessThan(h.order.indexOf('update:completed'));
    expect(h.order.indexOf('readTocEntryCount')).toBeLessThan(h.order.indexOf('update:completed'));
    expect(row.status).toBe('completed');
    expect(row.verifiedAt).toBeInstanceOf(Date);
  });

  it('fails the run on an EMPTY table of contents, and deletes the object', async () => {
    // A zero-byte object, a truncated upload, or a dump of the wrong (empty)
    // database — none of which an exit code or a byte count can see.
    const h = makeHarness({ tocEntries: 0 });

    const run = await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).finish();
    const row = await h.settled;

    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('not a readable archive');
    expect(h.storage.delete).toHaveBeenCalledWith(run.storageKey);
    expect(row.verifiedAt).toBeUndefined();
  });
});

describe('the heartbeat', () => {
  it('advances bytesWritten while the dump is still streaming', async () => {
    const h = makeHarness();
    const run = await h.service.startBackup({ trigger: 'manual' });

    const dump = await h.firstDump();
    dump.push(Buffer.alloc(1000, 1));

    await waitFor(() => h.heartbeats.length > 0, 'the heartbeat to be scheduled');
    // The bytes have to reach the metering transform before a beat can report
    // them; the fake provider tells us when it has pulled them through.
    await waitFor(() => h.progress.uploaded === 1000, 'the chunk to stream through the meter');

    h.heartbeats[0]();
    await waitFor(
      () => h.rows.get(run.id)?.bytesWritten === 1000n,
      'the heartbeat to record live progress'
    );

    // Liveness AND progress in one indexed UPDATE — this is what #282's stale
    // sweep reads, and what an operator watches move.
    expect(h.rows.get(run.id)?.lastHeartbeatAt).toBeInstanceOf(Date);
    // The run is still going: this is LIVE progress, not a terminal size.
    expect(h.rows.get(run.id)?.status).toBe('running');
    expect(h.rows.get(run.id)?.sizeBytes).toBeUndefined();

    dump.finish();
    await h.settled;
  });

  it('survives a transient write failure: a blip must not abort a progressing backup', async () => {
    const h = makeHarness();
    const run = await h.service.startBackup({ trigger: 'manual' });
    const dump = await h.firstDump();

    await waitFor(() => h.heartbeats.length > 0, 'the heartbeat to be scheduled');

    h.prisma.databaseBackupRun.update.mockRejectedValueOnce(
      new Error('connection terminated unexpectedly')
    );
    h.heartbeats[0]();
    await tick();

    dump.push(Buffer.from('still going'));
    dump.finish();

    const row = await h.settled;

    // The backup completed anyway — the blip cost one progress update.
    expect(row.status).toBe('completed');
  });

  it('is always cleared, so it cannot keep writing to a settled row', async () => {
    const h = makeHarness();
    await h.service.startBackup({ trigger: 'manual' });
    (await h.firstDump()).finish();
    await h.settled;

    expect(h.cleared).toHaveLength(1);
  });

  it('is cleared on the FAILURE path too', async () => {
    const h = makeHarness();
    await h.service.startBackup({ trigger: 'manual' });
    (await h.firstDump()).die(new Error('boom'));
    await h.settled;

    expect(h.cleared).toHaveLength(1);
  });

  it('runs on an unref’d real interval when nothing overrides the seam', () => {
    // The default seam, driven by Jest’s fake timers rather than by a real
    // twenty-second wait. Unref’d so a pending beat cannot hold a
    // shutting-down process open for the length of a dump.
    jest.useFakeTimers();
    try {
      const beats: number[] = [];
      const handle = systemBackupTimers.setInterval(() => beats.push(Date.now()), 20_000);

      expect(BACKUP_HEARTBEAT_INTERVAL_MS).toBe(20_000);
      jest.advanceTimersByTime(60_000);
      expect(beats).toHaveLength(3);

      systemBackupTimers.clearInterval(handle);
      jest.advanceTimersByTime(60_000);
      expect(beats).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the failure path', () => {
  it('deletes the partial object BEFORE marking the row failed', async () => {
    const h = makeHarness();
    await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).die(new Error('pg_dump exited with code 1'));
    await h.settled;

    // The row is the only index of what is in the bucket: marking first would
    // orphan the object, billed forever with nothing pointing at it.
    expect(h.order.indexOf('delete')).toBeGreaterThan(-1);
    expect(h.order.indexOf('delete')).toBeLessThan(h.order.indexOf('update:failed'));
  });

  it('does not let a failed delete mask the original error', async () => {
    const deleteImpl = jest.fn(async () => {
      throw new Error('bucket unreachable');
    }) as unknown as StorageProvider['delete'];

    const h = makeHarness({ deleteImpl });
    await h.service.startBackup({ trigger: 'manual' });
    (await h.firstDump()).die(new Error('the real reason: server closed the connection'));

    const row = await h.settled;

    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('the real reason');
    expect(row.lastError).not.toContain('bucket unreachable');
  });

  it('records how far a failed dump got, rather than resetting it to zero', async () => {
    const h = makeHarness();
    await h.service.startBackup({ trigger: 'manual' });

    const dump = await h.firstDump();
    dump.push(Buffer.alloc(4096, 9));
    await tick();
    dump.die(new Error('died at 4 KiB'));

    const row = await h.settled;

    expect(row.bytesWritten).toBe(4096n);
    expect(row.sizeBytes).toBeUndefined();
  });

  it('never retries automatically: one run, one dump', async () => {
    const h = makeHarness();
    await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).die(new Error('nope'));
    await h.settled;
    await tick();

    expect(h.engine.startDump).toHaveBeenCalledTimes(1);
    expect(h.prisma.databaseBackupRun.create).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// `db_backup.backup_failed` (#288, epic #254)
// =============================================================================

describe('the failure path raises db_backup.backup_failed', () => {
  it('raises it once, after the failed row has been written', async () => {
    const h = makeHarness();
    await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).die(new Error('pg_dump exited with code 1'));
    await h.settled;
    await tick();

    expect(h.notifyPermissionHolders).toHaveBeenCalledTimes(1);
    expect(h.notifyPermissionHolders.mock.calls[0][0]).toBe('db_backup.backup_failed');
    // `db_backup:read` — the exact string `db-backup.controller.ts` enforces.
    expect(h.notifyPermissionHolders.mock.calls[0][1]).toBe('db_backup:read');
  });

  it("carries outcome 'failed', the run id, the error and the trigger", async () => {
    const h = makeHarness({ appUrl: 'https://app.example.com/' });
    await h.service.startBackup({ trigger: 'manual' });
    (await h.firstDump()).die(new Error('server closed the connection'));
    const row = await h.settled;
    await tick();

    const payload = h.notifyPermissionHolders.mock.calls[0][2];

    expect(payload).toMatchObject({
      runId: row.id,
      // NOT 'stale'. Something observed this run break and wrote down what; the
      // sweep's give-up is the case where nothing did.
      outcome: 'failed',
      error: 'server closed the connection',
      trigger: 'manual',
      // Trailing slash trimmed, exactly as `UsersService.appUrl()` does it.
      appUrl: 'https://app.example.com',
    });
    expect(payload.failedAt).toBeInstanceOf(Date);
  });

  it('raises NOTHING on a run that completed', async () => {
    const h = makeHarness();
    await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).finish();
    await h.settled;
    await tick();

    expect(h.notifyPermissionHolders).not.toHaveBeenCalled();
  });

  it('raises NOTHING when the failure row could not even be written', async () => {
    // The row is still `running` from the table's point of view, so the stale
    // sweep will settle it and raise the event with a `stale` outcome. Raising
    // it here as well would mail two contradictory failure notices for one
    // failure.
    const h = makeHarness();
    await h.service.startBackup({ trigger: 'scheduled' });

    h.prisma.databaseBackupRun.update.mockRejectedValue(new Error('database is down'));

    (await h.firstDump()).die(new Error('pg_dump exited with code 1'));
    await tick();
    await tick();

    expect(h.notifyPermissionHolders).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // CONTAINMENT — the #288 acceptance criterion
  // ---------------------------------------------------------------------------

  it('a THROWING notifier does not stop the run being recorded as failed', async () => {
    const h = makeHarness({
      notifyImpl: () => {
        throw new Error('the notifier exploded');
      },
    });

    await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).die(new Error('pg_dump exited with code 1'));

    const row = await h.settled;
    await tick();

    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('pg_dump exited with code 1');
  });

  it('a notifier that REJECTS does not stop the run being recorded as failed either', async () => {
    const h = makeHarness({
      notifyImpl: async () => {
        throw new Error('dispatch blew up');
      },
    });

    await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).die(new Error('pg_dump exited with code 1'));

    const row = await h.settled;
    await tick();

    expect(row.status).toBe('failed');
  });

  it('a THROWING notifier does not stop a SUCCESSFUL run either — it is never reached', async () => {
    const h = makeHarness({
      notifyImpl: () => {
        throw new Error('the notifier exploded');
      },
    });

    await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).finish();

    const row = await h.settled;
    await tick();

    expect(row.status).toBe('completed');
  });
});

describe('the client/server version guard', () => {
  it('blocks BEFORE a single byte is dumped, with the runbook message on the row', async () => {
    const h = makeHarness({
      version: {
        status: 'blocked',
        clientMajor: 16,
        serverMajor: 18,
        message: 'pg_dump refuses ... rebuild the image with postgresql18-client',
      },
    });

    await h.service.startBackup({ trigger: 'scheduled' });
    const row = await h.settled;

    expect(h.engine.startDump).not.toHaveBeenCalled();
    expect(h.storage.upload).not.toHaveBeenCalled();
    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('rebuild the image');
  });

  it('proceeds on an UNREADABLE version pair — a guard rail, not a gate', async () => {
    const h = makeHarness({
      version: { status: 'unknown', clientMajor: null, serverMajor: null, message: 'could not read' },
    });

    await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).finish();
    const row = await h.settled;

    expect(row.status).toBe('completed');
  });
});

describe('cancellation', () => {
  it('routes through the ORDINARY failure path: object deleted, row failed', async () => {
    const h = makeHarness();
    const run = await h.service.startBackup({ trigger: 'manual' });
    const dump = await h.firstDump();
    dump.push(Buffer.from('partial'));
    await tick();

    expect(h.service.cancel(run.id)).toEqual({ outcome: 'signalled', runId: run.id });

    const row = await h.settled;

    expect(dump.kill).toHaveBeenCalledWith('SIGKILL');
    expect(h.storage.delete).toHaveBeenCalledWith(run.storageKey);
    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('cancelled');
    // Not a second teardown mechanism — the same delete-then-mark ordering.
    expect(h.order.indexOf('delete')).toBeLessThan(h.order.indexOf('update:failed'));
  });

  it('reports honestly when the run is not this process’s to cancel', async () => {
    const h = makeHarness();

    // A run started on another replica, or one that already settled: this
    // process holds no child-process handle for it, and saying "cancelled"
    // would tell an operator a dump had stopped while it is still streaming.
    expect(h.service.cancel('a-run-on-another-replica')).toEqual({
      outcome: 'not_running_here',
      runId: 'a-run-on-another-replica',
    });

    const run = await h.service.startBackup({ trigger: 'manual' });
    (await h.firstDump()).finish();
    await h.settled;

    // ...and the handle is released once the run settles.
    expect(h.service.cancel(run.id)).toEqual({ outcome: 'not_running_here', runId: run.id });
  });
});

describe('the storage-provider constraint', () => {
  it('refuses to start when the setting names a provider this deployment does not have', async () => {
    const h = makeHarness({ policy: { storageProvider: 'gcs' } });

    await expect(h.service.startBackup({ trigger: 'manual' })).rejects.toBeInstanceOf(
      DatabaseBackupStorageProviderError
    );

    // No row, no dump: there is nothing to record about a backup that was never
    // allowed to start.
    expect(h.prisma.databaseBackupRun.create).not.toHaveBeenCalled();
    expect(h.engine.startDump).not.toHaveBeenCalled();
  });

  it('accepts an empty setting as "whatever provider is active"', async () => {
    const h = makeHarness({ policy: { storageProvider: '' } });

    const run = await h.service.startBackup({ trigger: 'scheduled' });
    expect(run.storageProvider).toBe('s3');

    (await h.firstDump()).finish();
    await h.settled;
  });

  it('exposes the same rule to #283’s config write path', () => {
    const h = makeHarness();

    expect(() => h.service.assertStorageProviderUsable('gcs')).toThrow(
      DatabaseBackupStorageProviderError
    );
    expect(() => h.service.assertStorageProviderUsable('s3')).not.toThrow();
    expect(() => h.service.assertStorageProviderUsable(null)).not.toThrow();
  });
});

describe('the audit trio', () => {
  it('records the server version, the app version and the newest migration', async () => {
    const h = makeHarness();
    await h.service.startBackup({ trigger: 'manual' });
    (await h.firstDump()).finish();
    const row = await h.settled;

    expect(row.dbVersion).toBe('17.4');
    expect(row.migrationName).toBe('20260907120000_add_database_backup_runs');
    expect(typeof row.appVersion).toBe('string');
    expect((row.appVersion as string).length).toBeGreaterThan(0);
  });

  it('records it on a FAILED run too — the 3am reader needs it most there', async () => {
    const h = makeHarness();
    await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).die(new Error('boom'));
    const row = await h.settled;

    expect(row.status).toBe('failed');
    expect(row.dbVersion).toBe('17.4');
    expect(row.migrationName).toBe('20260907120000_add_database_backup_runs');
  });

  it('never fails a backup because an audit read failed', async () => {
    const h = makeHarness();
    h.prisma.$queryRaw.mockRejectedValue(new Error('permission denied for _prisma_migrations'));

    await h.service.startBackup({ trigger: 'manual' });
    (await h.firstDump()).finish();
    const row = await h.settled;

    expect(row.status).toBe('completed');
    expect(row.dbVersion).toBeNull();
    expect(row.migrationName).toBeNull();
  });
});

describe('retention is wired to the success path (#282, queued since #353)', () => {
  // ⚠ THE CRITERION IS UNCHANGED; THE OBSERVABLE IS. Retention used to be
  // `await this.retention.prune()` inside `completeRun`; since #353 it is an
  // enqueue of `db.backup.sweep`, whose handler prunes on a worker slot. Every
  // ordering rule these cases pin still has to hold — a job cannot be claimed
  // before the write it was enqueued after has committed — so what moved is
  // which call is asserted, not what is being proven.
  it('queues the sweep AFTER the run is marked completed, so the new backup counts as one of the N', async () => {
    const h = makeHarness();

    await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).finish();
    await h.settled;
    await waitFor(() => h.order.includes('sweep'), 'retention to be queued');

    expect(h.enqueueSweep).toHaveBeenCalledTimes(1);
    expect(h.enqueueSweep.mock.calls[0][0]).toMatchObject({ type: 'db.backup.sweep' });
    // The ordering IS the criterion. Queueing before the `completed` write
    // would leave this run uncounted by the count rule and evict one more old
    // backup than retention asked for.
    expect(h.order.indexOf('update:completed')).toBeLessThan(h.order.indexOf('sweep'));
    // And after verification, not before: a run that is about to fail
    // `pg_restore --list` must never get to delete the last known-good backup
    // on its way out.
    expect(h.order.indexOf('readTocEntryCount')).toBeLessThan(h.order.indexOf('sweep'));
  });

  it('does not queue the sweep when the dump fails — old archives matter most exactly then', async () => {
    const h = makeHarness();

    await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).die(new Error('pg_dump exited 1'));
    const row = await h.settled;
    // Give the failure path every chance to do something it should not.
    await tick();
    await tick();

    expect(row.status).toBe('failed');
    expect(h.enqueueSweep).not.toHaveBeenCalled();
  });

  it('does not queue the sweep when verification fails', async () => {
    const h = makeHarness({ tocEntries: 0 });

    await h.service.startBackup({ trigger: 'manual' });
    (await h.firstDump()).finish();
    const row = await h.settled;
    await tick();

    expect(row.status).toBe('failed');
    expect(h.enqueueSweep).not.toHaveBeenCalled();
  });

  it('never lets a failed retention enqueue turn a verified backup into a failed run', async () => {
    // Since #353 retention cannot reach this failure path at all — it runs in
    // another job — but the ENQUEUE is still a write inside `executeRun`'s
    // `try`, and storage housekeeping must not be able to fail a backup whose
    // archive has already been proven good.
    const h = makeHarness();
    h.enqueueSweep.mockRejectedValue(new Error('queue unreachable'));

    await h.service.startBackup({ trigger: 'scheduled' });
    (await h.firstDump()).finish();
    const row = await h.settled;
    await tick();

    expect(row.status).toBe('completed');
    expect(h.storage.delete).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// #351 (epic #345): the dump is a queue job
// -----------------------------------------------------------------------------

/** A P2002 shaped the way the queue's ACTIVE-DEDUP index reports it. */
function dedupConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: {
      modelName: 'Job',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage:
            `duplicate key value violates unique constraint "${ACTIVE_DEDUP_INDEX_NAME}"`,
          kind: 'UniqueConstraintViolation',
          constraint: { index: ACTIVE_DEDUP_INDEX_NAME },
        },
      },
    },
  });
}

describe('queueBackup: the enqueue and the run row are ONE commit', () => {
  it('writes the job and a `pending` run row inside a single transaction', async () => {
    const h = makeHarness();

    const { run, job } = await h.service.queueBackup({
      trigger: 'manual',
      createdById: 'admin-1',
    });

    // The endpoint's contract: a real run id, immediately.
    expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.storageKey.startsWith(BACKUP_KEY_PREFIX)).toBe(true);
    // ⚠ THE KEY EMBEDS THE RUN ID, and that is why the id is generated
    // client-side on this path as well as on the claim path.
    expect(run.storageKey).toContain(run.id);
    expect(run.bucket).toBe('test-bucket');
    expect(run.trigger).toBe('manual');
    expect(run.createdById).toBe('admin-1');

    // `pending`, and NOTHING claiming a dump exists yet. The old behaviour
    // reported `running` before anything ran; this is the correction.
    expect(run.status).toBe('pending');
    expect(run.startedAt).toBeUndefined();
    expect(run.lastHeartbeatAt).toBeUndefined();

    // The link that makes a second run row for one job unrepresentable.
    expect(run.jobId).toBe(job.id);

    // ⚠ THE ORDER: enqueue first, then the run row — so `job_id` is written by
    // the INSERT and never by a follow-up UPDATE. Both are inside the one
    // `$transaction` call, which is what closes the "claimed job, no run row"
    // window entirely.
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(['enqueue', 'create']);

    // And no dump has been started: this path only queues.
    expect(h.order).not.toContain('startDump');
  });

  it('enqueues under the CONSTANT dedup key, with no subject and dedup left on', async () => {
    const h = makeHarness();

    await h.service.queueBackup({ trigger: 'scheduled' });

    const [, input] = h.enqueueWithin.mock.calls[0];

    expect(input.type).toBe(BACKUP_JOB_TYPE);
    expect(input.subjectType).toBeUndefined();
    expect(input.subjectId).toBeUndefined();
    // Not opted out — the whole single-active-backup guarantee at the queue
    // layer rests on this key being present and identical every time.
    expect(input.skipDedup).toBeUndefined();
    expect(BACKUP_JOB_DEDUP_KEY).toBe(`${BACKUP_JOB_TYPE}::`);

    // The payload carries provenance and nothing else — identifiers, not data.
    expect(input.payload).toEqual({ trigger: 'scheduled', createdById: null });
  });

  it('leaves NO run row behind when the enqueue conflicts — the leak that would block every future backup', async () => {
    const h = makeHarness({
      enqueueFailures: [dedupConflict()],
      activeBackupJob: { id: 'job-winner', backupRun: { id: 'winner-run-id' } },
    });

    await expect(h.service.queueBackup({ trigger: 'manual' })).rejects.toMatchObject({
      activeRunId: 'winner-run-id',
    });

    // ⚠ THE ASSERTION THIS ORDERING EXISTS FOR. A `pending` row left behind
    // here would hold the single active slot — the tightened index admits ONE
    // active row across `pending` and `running` combined — and every backup
    // this deployment would ever take again would 409 until somebody deleted
    // it by hand.
    expect(h.rows.size).toBe(0);
    expect(h.jobRows).toHaveLength(0);
  });

  it('turns a queue dedup conflict into a 409 carrying the WINNER\'S RUN ID, not its job id', async () => {
    const h = makeHarness({
      enqueueFailures: [dedupConflict()],
      activeBackupJob: { id: 'job-winner', backupRun: { id: 'winner-run-id' } },
    });

    const error = await h.service
      .queueBackup({ trigger: 'scheduled' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DatabaseBackupAlreadyRunningError);
    // A client polls `GET /runs/{id}`, so the id it needs is the RUN's.
    expect((error as DatabaseBackupAlreadyRunningError).activeRunId).toBe('winner-run-id');
  });

  it('still answers 409 when the winning job has no run row to point at', async () => {
    // Reachable: an administrator deleted the run row, or `job.history.purge`
    // set `job_id` back to NULL. "A backup is already queued, and here is no
    // id" is true and useful; a 500 would not be.
    const h = makeHarness({
      enqueueFailures: [dedupConflict()],
      activeBackupJob: { id: 'job-winner', backupRun: null },
    });

    const error = await h.service
      .queueBackup({ trigger: 'manual' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DatabaseBackupAlreadyRunningError);
    expect((error as DatabaseBackupAlreadyRunningError).activeRunId).toBeNull();
  });

  it('turns the RUN TABLE\'s own guard into the same 409 — the pre_restore dump is still a blocker', async () => {
    const h = makeHarness({
      createFailures: [adapterConflict()],
      activeRunId: 'pre-restore-run',
    });

    const error = await h.service
      .queueBackup({ trigger: 'scheduled' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DatabaseBackupAlreadyRunningError);
    expect((error as DatabaseBackupAlreadyRunningError).activeRunId).toBe('pre-restore-run');

    // The transaction rolled back, so the job it had already inserted is gone
    // too — there is no orphan `db.backup.run` job for a run that never
    // existed.
    expect(h.jobRows).toHaveLength(0);
    expect(h.rows.size).toBe(0);
  });

  it('retries when the winner settled between the conflicting insert and the lookup', async () => {
    // Nothing is active any more, so reporting "already running" would be
    // false. Same bounded-retry rule `enqueue` and `claimRun` both follow.
    const h = makeHarness({
      enqueueFailures: [dedupConflict()],
      activeBackupJob: null,
    });

    const { run } = await h.service.queueBackup({ trigger: 'manual' });

    expect(run.status).toBe('pending');
    expect(h.enqueueWithin).toHaveBeenCalledTimes(2);
  });

  it('lets an unrecognised failure stay loud rather than reporting it as "already running"', async () => {
    const boom = new Error('the database is on fire');
    const h = makeHarness({ enqueueFailures: [boom] });

    await expect(h.service.queueBackup({ trigger: 'manual' })).rejects.toBe(boom);
  });

  it('refuses a misconfigured storage provider BEFORE anything is written', async () => {
    const h = makeHarness({ policy: { storageProvider: 'gcs' } });

    await expect(h.service.queueBackup({ trigger: 'manual' })).rejects.toBeInstanceOf(
      DatabaseBackupStorageProviderError
    );

    // No job, no row, no 500 an hour later: a configuration mistake is a 400
    // at request time.
    expect(h.jobRows).toHaveLength(0);
    expect(h.rows.size).toBe(0);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('runQueuedBackup: the job\'s lifetime IS the dump\'s lifetime', () => {
  /** A `jobs` row as the worker hands one to `process()`. */
  const jobRow = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'job-1',
      type: BACKUP_JOB_TYPE,
      payload: { trigger: 'manual', createdById: 'admin-1' },
      ...overrides,
    }) as never;

  it('flips the pending row to running, takes the dump AWAITED, and completes it', async () => {
    const h = makeHarness();

    const { run, job } = await h.service.queueBackup({ trigger: 'manual' });

    const running = h.service.runQueuedBackup(job as never);

    // ⚠ NOT RESOLVED YET. This is the entire point of #351: a handler that
    // returned here would buy a dashboard row and nothing else.
    const dump = await h.firstDump();
    expect(h.rows.get(run.id)?.status).toBe('running');
    expect(h.rows.get(run.id)?.startedAt).toBeInstanceOf(Date);

    dump.push(Buffer.from('archive-bytes'));
    dump.finish();

    await expect(running).resolves.toBeUndefined();

    const settled = h.rows.get(run.id) as Record<string, unknown>;
    expect(settled.status).toBe('completed');
    expect(settled.jobId).toBe(job.id);
    // `verifiedAt` semantics UNCHANGED: it is written on the same terminal
    // update as `completed`, and only after the STORED OBJECT was downloaded
    // and read by `readTocEntryCount`.
    expect(settled.verifiedAt).toBeInstanceOf(Date);
    expect(h.order.indexOf('download')).toBeLessThan(h.order.indexOf('update:completed'));
    expect(h.order.indexOf('readTocEntryCount')).toBeLessThan(
      h.order.indexOf('update:completed')
    );
  });

  it('THROWS when the dump fails, so the worker settles the job as failed too', async () => {
    // The run row records the failure, as it always did. What is new is that
    // the failure also reaches the queue — a `succeeded` job for a `failed`
    // dump would be a row that lies.
    const h = makeHarness({ tocEntries: 0 });

    const { run, job } = await h.service.queueBackup({ trigger: 'manual' });
    const running = h.service.runQueuedBackup(job as never);

    (await h.firstDump()).finish();

    await expect(running).rejects.toBeInstanceOf(DatabaseBackupVerificationError);
    expect(h.rows.get(run.id)?.status).toBe('failed');
  });

  it('does nothing at all when the run has already completed — the queue is at-least-once', async () => {
    const h = makeHarness({
      runsByJobId: { 'job-1': { id: 'done-run', status: 'completed', storageKey: 'k' } },
    });

    await expect(h.service.runQueuedBackup(jobRow())).resolves.toBeUndefined();

    // No second dump of a database whose archive is already durable.
    expect(h.order).not.toContain('startDump');
  });

  it('refuses a run something else already gave up on, rather than re-dumping beside a newer backup', async () => {
    const h = makeHarness({
      runsByJobId: { 'job-1': { id: 'gone-run', status: 'stale', storageKey: 'k' } },
    });

    await expect(h.service.runQueuedBackup(jobRow())).rejects.toThrow(/already "stale"/);
    expect(h.order).not.toContain('startDump');
  });

  it('creates the run row from the payload when a job arrives without one', async () => {
    // Unreachable for jobs `queueBackup` queued (one commit), so this covers
    // the paths that are not `queueBackup`: a hand-enqueued job, or a run row
    // an administrator deleted while its job was still queued.
    const h = makeHarness();

    const running = h.service.runQueuedBackup(
      jobRow({ id: 'orphan-job', payload: { trigger: 'scheduled', createdById: null } })
    );

    const dump = await h.firstDump();
    dump.finish();
    await running;

    const created = [...h.rows.values()][0];
    expect(created.jobId).toBe('orphan-job');
    expect(created.trigger).toBe('scheduled');
    expect(created.status).toBe('completed');
  });

  it('falls back to a `manual` trigger rather than refusing an unreadable payload', async () => {
    const h = makeHarness();

    const running = h.service.runQueuedBackup(jobRow({ id: 'weird-job', payload: null }));
    (await h.firstDump()).finish();
    await running;

    const created = [...h.rows.values()][0];
    expect(created.trigger).toBe('manual');
    expect(created.createdById).toBeNull();
  });

  it('re-reads the policy at claim time, not at enqueue time', async () => {
    const h = makeHarness();

    const { job } = await h.service.queueBackup({ trigger: 'manual' });
    h.settings.getDatabaseBackupPolicy.mockClear();

    const running = h.service.runQueuedBackup(job as never);
    (await h.firstDump()).finish();
    await running;

    // A job may sit queued for hours; the compression level and the stale
    // window it runs under must be the ones in force NOW.
    expect(h.settings.getDatabaseBackupPolicy).toHaveBeenCalled();
  });

  it('settles the job when an operator cancels the dump it is executing', async () => {
    const h = makeHarness();

    const { run, job } = await h.service.queueBackup({ trigger: 'manual' });
    const running = h.service.runQueuedBackup(job as never);

    await h.firstDump();

    expect(h.service.cancel(run.id)).toEqual({ outcome: 'signalled', runId: run.id });

    // ⚠ THE REJECTION IS HOW THE JOB SETTLES. Cancellation reaches the
    // ORDINARY failure path — partial object deleted, row marked `failed` —
    // and then reaches the worker, so the job does not sit `running` waiting
    // for the reaper.
    await expect(running).rejects.toBeInstanceOf(DatabaseBackupCancelledError);
    expect(h.rows.get(run.id)?.status).toBe('failed');
  });

  it('reports a run this process is not executing honestly, as it always did', async () => {
    const h = makeHarness();

    const { run } = await h.service.queueBackup({ trigger: 'manual' });

    // Queued but unclaimed: there is no child process to signal, and saying
    // otherwise would tell an operator their dump had stopped.
    expect(h.service.cancel(run.id)).toEqual({ outcome: 'not_running_here', runId: run.id });
  });
});

// =============================================================================
// The node path: `resolveNodeOutputKey` and `completeNodeRun` (#352, epic #345)
// =============================================================================
//
// FOUR PROPERTIES, and the first is the one every other one exists to protect:
//
//   1. BOTH EXECUTORS PRODUCE THE SAME ROW. `executeRun` and `completeNodeRun`
//      go through one private `completeRun`, so a backup's stored state cannot
//      depend on which machine took it.
//   2. THE KEY IS THE SERVER'S. A node may only report the key it was handed;
//      anything else is refused, not corrected.
//   3. VERIFICATION IS SERVER-SIDE, ALWAYS. `verified_at` is written because
//      THIS process read the object back out of the bucket, never because a
//      node said so.
//   4. `bytes` SURVIVES 2^53. The decimal-string wire type is only worth
//      having if the value reaches the column exact.
// =============================================================================

/** A `db.backup.run` job row, as a node would be holding it. */
const NODE_JOB = { id: 'job-node-1', type: BACKUP_JOB_TYPE } as unknown as Job;

/** What a node reports. Overridden per test. */
function nodeResult(overrides: Partial<DbBackupRunResult> = {}): DbBackupRunResult {
  return {
    storageKey: 'backups/2026/09/07/run-node.dump',
    bytes: '1048576',
    sha256: 'b'.repeat(64),
    pgDumpVersion: 'pg_dump (PostgreSQL) 17.2',
    dbVersion: 'PostgreSQL 17.4',
    migrationName: '20260907160000_add_backup_run_pg_dump_version',
    startedAt: '2026-09-07T02:00:00.000Z',
    finishedAt: '2026-09-07T02:12:00.000Z',
    ...overrides,
  };
}

/** A run row a node is executing, seeded straight into the fake table. */
function seedNodeRun(
  h: ReturnType<typeof makeHarness>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const row = {
    id: 'run-node',
    jobId: NODE_JOB.id,
    status: 'running',
    trigger: 'manual',
    storageProvider: 's3',
    storageKey: 'backups/2026/09/07/run-node.dump',
    bucket: 'test-bucket',
    format: 'custom',
    bytesWritten: 0n,
    dbVersion: null,
    appVersion: null,
    migrationName: null,
    pgDumpVersion: null,
    startedAt: new Date('2026-09-07T02:00:00.000Z'),
    lastHeartbeatAt: new Date('2026-09-07T02:00:00.000Z'),
    ...overrides,
  };

  h.rows.set(row.id as string, row);

  return row;
}

describe('resolveNodeOutputKey: the server chooses where a node writes', () => {
  it('returns the run’s recorded key — never a node-outputs path', async () => {
    const h = makeHarness();
    seedNodeRun(h);

    await expect(h.service.resolveNodeOutputKey(NODE_JOB)).resolves.toBe(
      'backups/2026/09/07/run-node.dump'
    );
  });

  it('is idempotent: a node that asks twice gets ONE key, not a second archive', async () => {
    const h = makeHarness();
    seedNodeRun(h, { status: 'pending', startedAt: null, lastHeartbeatAt: null });

    const first = await h.service.resolveNodeOutputKey(NODE_JOB);
    const second = await h.service.resolveNodeOutputKey(NODE_JOB);

    expect(second).toBe(first);
  });

  it('flips `pending` to `running` on the first ask — the only moment the server learns a node has started', async () => {
    const h = makeHarness();
    seedNodeRun(h, { status: 'pending', startedAt: null, lastHeartbeatAt: null });

    await h.service.resolveNodeOutputKey(NODE_JOB);

    const row = h.rows.get('run-node');
    expect(row?.status).toBe('running');
    // `startedAt` is what the failure notification and every duration render;
    // leaving it NULL would make a node-taken dump look like it never began.
    expect(row?.startedAt).toBeInstanceOf(Date);
    expect(row?.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it('does not re-write a row that is already running — the second ask only reads', async () => {
    const h = makeHarness();
    seedNodeRun(h);
    h.prisma.databaseBackupRun.update.mockClear();

    await h.service.resolveNodeOutputKey(NODE_JOB);

    expect(h.prisma.databaseBackupRun.update).not.toHaveBeenCalled();
  });

  it('refuses when the job has no run row: there is nowhere legitimate for those bytes to go', async () => {
    const h = makeHarness();

    await expect(h.service.resolveNodeOutputKey(NODE_JOB)).rejects.toThrow(
      /no backup run row/
    );
  });

  it('refuses once the run has settled — a completed archive is not an upload target', async () => {
    const h = makeHarness();
    seedNodeRun(h, { status: 'completed' });

    await expect(h.service.resolveNodeOutputKey(NODE_JOB)).rejects.toThrow(/already "completed"/);
  });
});

describe('completeNodeRun: one write, two paths', () => {
  it('writes the SAME terminal row shape the server path writes', async () => {
    // The server path, for comparison — a real dump through the real engine.
    const server = makeHarness();
    await server.service.startBackup({ trigger: 'manual' });
    (await server.firstDump()).push(Buffer.from('archive'));
    (await server.firstDump()).finish();
    const serverRow = await server.settled;

    // The node path, with the numbers a node reported rather than ones this
    // process measured.
    const node = makeHarness();
    seedNodeRun(node);
    await node.service.completeNodeRun(NODE_JOB, nodeResult());
    const nodeRow = node.rows.get('run-node') as Record<string, unknown>;

    // ⚠ THE PROPERTY THIS WHOLE FILE'S NODE SECTION EXISTS FOR: the set of
    // columns a completion writes is identical, so nothing downstream — the
    // restore path, the retention sweep, the admin list — has to ask which
    // executor produced a row before trusting it.
    const terminal = (row: Record<string, unknown>) => ({
      status: row.status,
      hasFinishedAt: row.finishedAt instanceof Date,
      hasVerifiedAt: row.verifiedAt instanceof Date,
      bytesMatchSize: row.bytesWritten === row.sizeBytes,
      checksumIsHex: /^[0-9a-f]{64}$/.test(row.checksumSha256 as string),
      lastError: row.lastError,
      hasAppVersion: typeof row.appVersion === 'string',
    });

    expect(terminal(nodeRow)).toEqual(terminal(serverRow));
    expect(nodeRow.status).toBe('completed');
  });

  it('records the node’s provenance, including which pg_dump wrote the archive', async () => {
    const h = makeHarness();
    seedNodeRun(h);

    await h.service.completeNodeRun(NODE_JOB, nodeResult());

    const row = h.rows.get('run-node');
    expect(row?.dbVersion).toBe('PostgreSQL 17.4');
    expect(row?.pgDumpVersion).toBe('pg_dump (PostgreSQL) 17.2');
    expect(row?.migrationName).toBe('20260907160000_add_backup_run_pg_dump_version');
    // `appVersion` is THIS process's build, deliberately — it records which
    // application wrote the row, not which binary wrote the file.
    expect(typeof row?.appVersion).toBe('string');
  });

  it('round-trips a byte count above 2^53 into the BigInt columns, exactly', async () => {
    const h = makeHarness();
    seedNodeRun(h);

    // 2^53 + 1: the first integer JSON's number type cannot represent.
    await h.service.completeNodeRun(NODE_JOB, nodeResult({ bytes: '9007199254740993' }));

    const row = h.rows.get('run-node');
    expect(row?.sizeBytes).toBe(9007199254740993n);
    expect(row?.bytesWritten).toBe(9007199254740993n);
    // What sending it as a JSON number would have stored instead.
    expect(BigInt(Number('9007199254740993'))).not.toBe(row?.sizeBytes);
  });

  it('VERIFIES SERVER-SIDE before it writes: download, read the TOC, then complete', async () => {
    const h = makeHarness();
    seedNodeRun(h);

    await h.service.completeNodeRun(NODE_JOB, nodeResult());

    // The order is the assertion. `verified_at` may only be written after this
    // process has read what the BUCKET holds — a node vouching for its own
    // upload is not evidence (§6 of docs/specs/database-backup.md).
    expect(h.order).toEqual([
      'findUnique',
      'download',
      'readTocEntryCount',
      'update:completed',
      // #353: retention is queued, not awaited, and still strictly after the
      // verified completing write.
      'sweep',
    ]);
  });

  it('fails the run when the stored archive has an EMPTY table of contents', async () => {
    const h = makeHarness({ tocEntries: 0 });
    seedNodeRun(h);

    await expect(h.service.completeNodeRun(NODE_JOB, nodeResult())).rejects.toBeInstanceOf(
      DatabaseBackupVerificationError
    );

    const row = h.rows.get('run-node');
    expect(row?.status).toBe('failed');
    expect(row?.verifiedAt).toBeUndefined();
    // The object goes first, exactly as on the server's failure path: a
    // `failed` run must never leave an archive nothing points at.
    expect(h.order).toContain('delete');
    expect(h.order.indexOf('delete')).toBeLessThan(h.order.indexOf('update:failed'));
  });

  it('fails the run when the archive cannot be read back at all', async () => {
    const h = makeHarness({
      downloadImpl: jest.fn(async () => {
        throw new Error('NoSuchKey');
      }) as unknown as StorageProvider['download'],
    });
    seedNodeRun(h);

    await expect(h.service.completeNodeRun(NODE_JOB, nodeResult())).rejects.toThrow('NoSuchKey');
    expect(h.rows.get('run-node')?.status).toBe('failed');
  });

  it('REFUSES a key the server did not hand out, and records nothing about it', async () => {
    const h = makeHarness();
    seedNodeRun(h);

    await expect(
      h.service.completeNodeRun(NODE_JOB, nodeResult({ storageKey: 'backups/somebody-else.dump' }))
    ).rejects.toThrow(/may only report the key the server handed it/);

    const row = h.rows.get('run-node');
    expect(row?.status).toBe('failed');
    expect(row?.checksumSha256).toBeUndefined();
    // ⚠ AND IT NEVER LOOKED AT THE BYTES. A mismatch is refused before any
    // download, so a result naming an arbitrary key cannot make this server
    // fetch an arbitrary object.
    expect(h.order).not.toContain('download');
  });

  it('does not queue the sweep on any failure — old archives matter most when tonight’s backup failed', async () => {
    const h = makeHarness({ tocEntries: 0 });
    seedNodeRun(h);

    await expect(h.service.completeNodeRun(NODE_JOB, nodeResult())).rejects.toBeInstanceOf(
      DatabaseBackupVerificationError
    );

    expect(h.enqueueSweep).not.toHaveBeenCalled();
  });

  it('treats a resubmitted result for an already-completed run as a no-op', async () => {
    const h = makeHarness();
    seedNodeRun(h, { status: 'completed' });

    // A node whose result reached us but whose response was lost sends it
    // again. The work is done; refusing would fail a job whose archive is
    // sitting verified in the bucket.
    await expect(h.service.completeNodeRun(NODE_JOB, nodeResult())).resolves.toBeUndefined();
    expect(h.order).toEqual(['findUnique']);
  });

  it('refuses a result for a run that was given up on', async () => {
    const h = makeHarness();
    seedNodeRun(h, { status: 'stale' });

    await expect(h.service.completeNodeRun(NODE_JOB, nodeResult())).rejects.toThrow(
      /no longer holds the active backup slot/
    );
  });

  it('refuses a result for a job with no run row', async () => {
    const h = makeHarness();

    await expect(h.service.completeNodeRun(NODE_JOB, nodeResult())).rejects.toThrow(
      /no backup run row/
    );
  });
});
