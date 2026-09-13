import type { PrismaService } from '../prisma/prisma.service';
import type { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import type { StorageProvider } from '../storage/providers/storage-provider.interface';
import type { SystemDatabaseBackupValue } from '../common/schemas/settings.schema';
import { DatabaseBackupRetentionService } from './db-backup-retention.service';

// =============================================================================
// Retention's acceptance criteria (issue #282, epic #254)
// =============================================================================
//
// Two rules over two populations, and one deletion order. Everything here runs
// against a tiny Prisma double and a fake provider, because what is under test
// is WHICH rows each rule selects and IN WHAT ORDER their two halves are
// deleted — none of which needs a database or a bucket to be true.
//
// The single shared `calls` log is what makes the ordering criteria testable
// at all: "object then row" is a statement about the interleaving of two
// different collaborators, which per-mock call counts cannot express.
// =============================================================================

const POLICY: SystemDatabaseBackupValue = {
  enabled: true,
  frequency: 'daily',
  dayOfWeek: 0,
  dayOfMonth: 1,
  timeOfDay: '02:00',
  timezone: 'UTC',
  retentionCount: 3,
  storageProvider: 's3',
  runStaleMinutes: 120,
  compressionLevel: 6,
  restoreRollbackMode: 'retain_database',
  oldDatabaseRetentionHours: 48,
  nodeOffloadEnabled: false,
};

const NOW = new Date('2026-09-07T12:00:00.000Z');

interface Row {
  id: string;
  storageKey: string;
  status: string;
  trigger: string;
  createdAt: Date;
}

/** A backup row, newest-first ordering supplied by the double below. */
function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    storageKey: `backups/${id}.dump`,
    status: 'completed',
    trigger: 'scheduled',
    createdAt: new Date('2026-09-01T02:00:00.000Z'),
    ...overrides,
  };
}

interface HarnessOptions {
  rows?: Row[];
  policy?: Partial<SystemDatabaseBackupValue>;
  deleteImpl?: (key: string) => Promise<void>;
  deleteRowImpl?: (id: string) => Promise<void>;
  settingsImpl?: () => Promise<SystemDatabaseBackupValue>;
}

/**
 * A Prisma double that actually applies the `where`, the `orderBy` and the
 * `skip` it is given.
 *
 * Emulated rather than asserted-on, because the criteria are about the ROWS
 * that survive — "the newest three, and never a `pre_restore` one" — and an
 * assertion on the query object would pass just as happily with a `skip` that
 * counts the wrong population.
 */
function makeHarness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const table = new Map((options.rows ?? []).map((entry) => [entry.id, entry]));

  const findMany = jest.fn(async (args: any) => {
    calls.push('findMany');

    const { where, orderBy, skip } = args;
    let rows = [...table.values()].filter((entry) => {
      if (where.status !== undefined && entry.status !== where.status) return false;
      if (typeof where.trigger === 'string' && entry.trigger !== where.trigger) return false;
      if (where.trigger?.not !== undefined && entry.trigger === where.trigger.not) return false;
      if (where.createdAt?.lt !== undefined && !(entry.createdAt < where.createdAt.lt)) {
        return false;
      }

      return true;
    });

    rows.sort((a, b) =>
      orderBy.createdAt === 'desc'
        ? b.createdAt.getTime() - a.createdAt.getTime()
        : a.createdAt.getTime() - b.createdAt.getTime()
    );

    if (typeof skip === 'number') rows = rows.slice(skip);

    return rows.map((entry) => ({ ...entry }));
  });

  const deleteRow = jest.fn(async ({ where }: { where: { id: string } }) => {
    calls.push(`row:${where.id}`);
    if (options.deleteRowImpl) await options.deleteRowImpl(where.id);
    table.delete(where.id);

    return {};
  });

  const prisma = {
    databaseBackupRun: { findMany, delete: deleteRow },
  } as unknown as PrismaService;

  const settings = {
    getDatabaseBackupPolicy: jest.fn(
      options.settingsImpl ?? (async () => ({ ...POLICY, ...options.policy }))
    ),
  } as unknown as SystemSettingsService;

  const deleteObject = jest.fn(async (key: string) => {
    calls.push(`object:${key}`);
    if (options.deleteImpl) await options.deleteImpl(key);
  });

  const storage = { delete: deleteObject } as unknown as StorageProvider;

  return {
    service: new DatabaseBackupRetentionService(prisma, settings, storage),
    calls,
    table,
    findMany,
    deleteRow,
    deleteObject,
    /** The ids still in the table, oldest-first. */
    remaining(): string[] {
      return [...table.values()]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((entry) => entry.id);
    },
  };
}

/** `n` completed scheduled runs, one day apart, oldest first. */
function nightlies(count: number): Row[] {
  return Array.from({ length: count }, (_, index) =>
    row(`night-${index + 1}`, {
      createdAt: new Date(Date.UTC(2026, 8, index + 1, 2, 0, 0)),
    })
  );
}

describe('retention by count (ordinary runs)', () => {
  it('keeps the newest N completed runs and deletes the rest', async () => {
    const h = makeHarness({ rows: nightlies(6) });

    const result = await h.service.prune(NOW);

    expect(result.prunedByCount).toBe(3);
    expect(h.remaining()).toEqual(['night-4', 'night-5', 'night-6']);
  });

  it('deletes OLDEST FIRST, so an interrupted prune still leaves the newest intact', async () => {
    // The query has to hand them back newest-first — that is what makes `skip`
    // mean "the keepers" — so the loop must reverse them. Deleting in query
    // order would eat the archive from the recent end whenever a prune broke
    // half way through.
    const h = makeHarness({ rows: nightlies(6) });

    await h.service.prune(NOW);

    expect(h.calls.filter((call) => call.startsWith('row:'))).toEqual([
      'row:night-1',
      'row:night-2',
      'row:night-3',
    ]);
  });

  it('leaves the newest N-ish intact when a delete fails half way through', async () => {
    const h = makeHarness({
      rows: nightlies(6),
      deleteImpl: async (key) => {
        if (key.includes('night-2')) throw new Error('bucket unreachable');
      },
    });

    const result = await h.service.prune(NOW);

    expect(result.prunedByCount).toBe(2);
    expect(result.keptAfterFailedDelete).toBe(1);
    // night-2 survived; every run the operator asked to keep survived too.
    expect(h.remaining()).toEqual(['night-2', 'night-4', 'night-5', 'night-6']);
  });

  it('does nothing when there are fewer runs than the retention count', async () => {
    const h = makeHarness({ rows: nightlies(2) });

    const result = await h.service.prune(NOW);

    expect(result.prunedByCount).toBe(0);
    expect(h.deleteObject).not.toHaveBeenCalled();
    expect(h.deleteRow).not.toHaveBeenCalled();
  });

  it('never prunes a failed or stale run — their objects are already gone and their rows are the evidence', async () => {
    const h = makeHarness({
      rows: [
        ...nightlies(4),
        row('broken-1', {
          status: 'failed',
          createdAt: new Date('2026-08-01T02:00:00.000Z'),
        }),
        row('zombie-1', {
          status: 'stale',
          createdAt: new Date('2026-08-02T02:00:00.000Z'),
        }),
      ],
    });

    await h.service.prune(NOW);

    expect(h.remaining()).toContain('broken-1');
    expect(h.remaining()).toContain('zombie-1');
  });
});

describe('retention never counts a pre_restore run', () => {
  it('does not delete one under the count rule, however old it is', async () => {
    const h = makeHarness({
      rows: [
        ...nightlies(4),
        // Recent enough that the AGE rule does not reach it either.
        row('rollback', {
          trigger: 'pre_restore',
          createdAt: new Date('2026-09-07T06:00:00.000Z'),
        }),
      ],
    });

    const result = await h.service.prune(NOW);

    expect(result.prunedByCount).toBe(1);
    expect(result.prunedByAge).toBe(0);
    expect(h.remaining()).toEqual(['night-2', 'night-3', 'night-4', 'rollback']);
  });

  it('does not consume one of the N slots either', async () => {
    // ⚠ THE CRITERION THAT CATCHES A POST-FILTER. With `retentionCount: 3` and
    // three nightlies plus one recent rollback, a rule that merely refused to
    // DELETE pre-restore runs would still have counted the rollback as one of
    // the three keepers and evicted the oldest nightly. Nothing may be deleted
    // here.
    const h = makeHarness({
      rows: [
        ...nightlies(3),
        row('rollback', {
          trigger: 'pre_restore',
          createdAt: new Date('2026-09-07T06:00:00.000Z'),
        }),
      ],
    });

    const result = await h.service.prune(NOW);

    expect(result.prunedByCount).toBe(0);
    expect(h.remaining()).toEqual(['night-1', 'night-2', 'night-3', 'rollback']);
  });
});

describe('retention by age (pre_restore runs)', () => {
  it('deletes a rollback backup once it is past oldDatabaseRetentionHours', async () => {
    const h = makeHarness({
      rows: [
        // 49 hours old, against the shipped 48.
        row('rollback-old', {
          trigger: 'pre_restore',
          createdAt: new Date('2026-09-05T11:00:00.000Z'),
        }),
        // 47 hours old.
        row('rollback-fresh', {
          trigger: 'pre_restore',
          createdAt: new Date('2026-09-05T13:00:00.000Z'),
        }),
      ],
    });

    const result = await h.service.prune(NOW);

    expect(result.prunedByAge).toBe(1);
    expect(h.remaining()).toEqual(['rollback-fresh']);
  });

  it('follows the operator when the rollback window is widened', async () => {
    // The same setting that decides how long a DISPLACED DATABASE survives
    // under `retain_database`: the two expressions of "the way back" expire
    // together, which is why there is no second settings field.
    const h = makeHarness({
      policy: { oldDatabaseRetentionHours: 720 },
      rows: [
        row('rollback-old', {
          trigger: 'pre_restore',
          createdAt: new Date('2026-09-05T11:00:00.000Z'),
        }),
      ],
    });

    const result = await h.service.prune(NOW);

    expect(result.prunedByAge).toBe(0);
    expect(h.remaining()).toEqual(['rollback-old']);
  });

  it('never ages out an ordinary run, however old', async () => {
    const h = makeHarness({
      rows: [row('ancient', { createdAt: new Date('2019-01-01T02:00:00.000Z') })],
    });

    const result = await h.service.prune(NOW);

    // One run, retentionCount 3 — the count rule keeps it, and the age rule
    // must not see it at all.
    expect(result.prunedByAge).toBe(0);
    expect(h.remaining()).toEqual(['ancient']);
  });
});

describe('deletion order', () => {
  it('deletes the OBJECT first and the ROW second, for every victim', async () => {
    const h = makeHarness({ rows: nightlies(5) });

    await h.service.prune(NOW);

    // One shared log, so the interleaving itself is the assertion.
    expect(h.calls.filter((call) => !call.startsWith('findMany'))).toEqual([
      'object:backups/night-1.dump',
      'row:night-1',
      'object:backups/night-2.dump',
      'row:night-2',
    ]);
  });

  it('KEEPS THE ROW when the object delete fails', async () => {
    // The row is the only index of what exists in the bucket. Deleting it
    // anyway would leave a multi-gigabyte object nothing points at, billed
    // forever and invisible; keeping it means the next prune tries again.
    const h = makeHarness({
      rows: nightlies(4),
      deleteImpl: async () => {
        throw new Error('AccessDenied');
      },
    });

    const result = await h.service.prune(NOW);

    expect(result.prunedByCount).toBe(0);
    expect(result.keptAfterFailedDelete).toBe(1);
    expect(h.deleteRow).not.toHaveBeenCalled();
    expect(h.remaining()).toEqual(['night-1', 'night-2', 'night-3', 'night-4']);
  });

  it('reports a row delete that failed after its object was removed, and self-heals next time', async () => {
    let failRowDelete = true;
    const h = makeHarness({
      rows: nightlies(4),
      deleteRowImpl: async () => {
        if (failRowDelete) throw new Error('deadlock detected');
      },
    });

    const first = await h.service.prune(NOW);

    expect(first.prunedByCount).toBe(0);
    expect(first.keptAfterFailedDelete).toBe(1);

    // The next prune re-deletes an already-absent key (a no-op on every
    // provider this interface targets) and then removes the row.
    failRowDelete = false;
    const second = await h.service.prune(NOW);

    expect(second.prunedByCount).toBe(1);
    expect(h.remaining()).toEqual(['night-2', 'night-3', 'night-4']);
  });
});

describe('retention never throws', () => {
  it('swallows a settings read failure', async () => {
    const h = makeHarness({
      settingsImpl: async () => {
        throw new Error('connection reset');
      },
    });

    await expect(h.service.prune(NOW)).resolves.toEqual({
      prunedByCount: 0,
      prunedByAge: 0,
      keptAfterFailedDelete: 0,
    });
  });

  it('swallows a failed candidate query and reports what it managed', async () => {
    const h = makeHarness({ rows: nightlies(5) });
    // The count rule succeeds, the age rule's query blows up. What the first
    // rule achieved must still be reported: a caller that logged "0 pruned"
    // after deleting two archives is worse than no log at all.
    h.findMany.mockImplementationOnce(h.findMany.getMockImplementation() as never);
    h.findMany.mockImplementationOnce(async () => {
      throw new Error('statement timeout');
    });

    const result = await h.service.prune(NOW);

    expect(result.prunedByCount).toBe(2);
    expect(result.prunedByAge).toBe(0);
  });
});
