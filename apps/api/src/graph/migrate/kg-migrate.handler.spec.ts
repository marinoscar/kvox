import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { buildMigrationTestDefinition } from '../../../test/ontology/fixtures/migration-fixtures';
import { KG_MIGRATE_JOB_TYPE } from '../job-types';
import { KG_MIGRATE_BATCH_SIZE, KgMigrateHandler } from './kg-migrate.handler';
import { DEFAULT_KG_MIGRATE_DEFINITION, type KgMigrateDefinition, type KgMigrateTable } from './kg-migrate.plan';
import type { KgMigrateRepository, KgMigrateRow, KgMigrateUpdate } from './kg-migrate.repository';

// =============================================================================
// `kg.migrate` handler (#384) — profile, server-only, batching, the
// validation-failure path, dropped-value counting and stale-draft flagging,
// against a mocked repository and the issue's fixture migrations:
//   1.1.0 rename Project.startDate → start;  2.0.0 retag OldType → NewType.
// The SQL itself is covered by test/graph/kg-migrate.db.spec.ts.
// =============================================================================

const OWNER = '11111111-1111-4111-8111-111111111111';

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function row(n: number, type: string, props: Record<string, unknown>, ontologyVersion = '1.0.0'): KgMigrateRow {
  return { id: uuid(n), type, kind: null, status: null, props, ontologyVersion };
}

function fixtureDefinition(): KgMigrateDefinition {
  const def = buildMigrationTestDefinition();
  return { registry: def.registry, migrations: def.migrations, changelog: def.changelog, targetVersion: def.targetVersion };
}

function harness(opts: { definition?: KgMigrateDefinition; pages?: Partial<Record<KgMigrateTable, KgMigrateRow[][]>> } = {}) {
  const registry = new JobHandlerRegistry();
  const pages = opts.pages ?? {};
  const cursors: Record<string, number> = {};
  const writes: Array<{ table: KgMigrateTable; updates: KgMigrateUpdate[] }> = [];
  const repository = {
    attributeDefsFor: jest.fn().mockResolvedValue([]),
    selectBatch: jest.fn(async (...args: Parameters<KgMigrateRepository['selectBatch']>) => {
      const [table] = args;
      const i = cursors[table] ?? 0;
      cursors[table] = i + 1;
      return pages[table]?.[i] ?? [];
    }),
    writeBatch: jest.fn(async (table: KgMigrateTable, _owner: string, updates: KgMigrateUpdate[]) => {
      writes.push({ table, updates });
      return updates.map((u) => u.id);
    }),
    flagStaleDrafts: jest.fn().mockResolvedValue(0),
  };
  const handler = new KgMigrateHandler(
    registry,
    repository as unknown as KgMigrateRepository,
    opts.definition ?? fixtureDefinition(),
  );
  return { handler, registry, repository, writes };
}

describe('KgMigrateHandler — registration and profile', () => {
  it('registers under kg.migrate with { maxRuntimeMs: 60m, maxAttempts: 3 }', () => {
    const { handler, registry } = harness();
    handler.onModuleInit();

    expect(handler.type).toBe(KG_MIGRATE_JOB_TYPE);
    expect(registry.get(KG_MIGRATE_JOB_TYPE)).toBe(handler);
    expect(handler.profile).toEqual({ maxRuntimeMs: 60 * 60_000, maxAttempts: 3 });
  });

  it('is server-only — no node members, listed in serverOnlyTypes()', () => {
    const { handler, registry } = harness();
    handler.onModuleInit();

    const asRecord = handler as unknown as Record<string, unknown>;
    expect(asRecord.nodeResultSchema).toBeUndefined();
    expect(asRecord.persistNodeResult).toBeUndefined();
    expect(asRecord.nodeSecretBroker).toBeUndefined();
    expect(registry.serverOnlyTypes()).toContain(KG_MIGRATE_JOB_TYPE);
  });
});

describe('KgMigrateHandler.process', () => {
  it.each([
    ['null', null],
    ['no owner', { targetVersion: '2.0.0' }],
    ['a non-uuid owner', { ownerId: 'nope', targetVersion: '2.0.0' }],
  ])('returns without touching anything for an unreadable payload (%s)', async (_name, payload) => {
    const { handler, repository } = harness();

    await expect(handler.process({ id: 'job-1', payload } as never)).resolves.toBeUndefined();
    expect(repository.selectBatch).not.toHaveBeenCalled();
  });

  it('runs the owner named in the payload', async () => {
    const { handler, repository } = harness();

    await handler.process({ id: 'job-1', payload: { ownerId: OWNER, targetVersion: '2.0.0' } } as never);

    expect(repository.attributeDefsFor).toHaveBeenCalledWith(OWNER);
    expect(repository.selectBatch).toHaveBeenCalledWith('entity', OWNER, '2.0.0', expect.anything(), null, KG_MIGRATE_BATCH_SIZE);
  });
});

describe('KgMigrateHandler.migrate', () => {
  it('does nothing — not even a query — while no migration is declared (the shipped 1.x state)', async () => {
    const { handler, repository } = harness({ definition: DEFAULT_KG_MIGRATE_DEFINITION });

    const result = await handler.migrate(OWNER, DEFAULT_KG_MIGRATE_DEFINITION.targetVersion);

    expect(result).toMatchObject({ scanned: 0, changed: 0, needsAttention: 0 });
    expect(repository.attributeDefsFor).not.toHaveBeenCalled();
    expect(repository.selectBatch).not.toHaveBeenCalled();
  });

  it('never migrates past the version this build knows', async () => {
    const { handler } = harness();

    expect((await handler.migrate(OWNER, '9.0.0')).targetVersion).toBe('2.0.0');
  });

  it('skips tables no step can touch (the fixture only touches entities)', async () => {
    const { handler, repository } = harness();

    await handler.migrate(OWNER, '2.0.0');

    expect(repository.selectBatch.mock.calls.map((c) => c[0])).toEqual(['entity']);
  });

  it('walks keyset pages until a short page, writing one batch per page', async () => {
    const full = Array.from({ length: KG_MIGRATE_BATCH_SIZE }, (_, i) => row(i + 1, 'OldType', { note: `n${i}` }));
    const short = [row(KG_MIGRATE_BATCH_SIZE + 1, 'Project', { startDate: '2026-01-02' })];
    const { handler, repository, writes } = harness({ pages: { entity: [full, short] } });

    const result = await handler.migrate(OWNER, '2.0.0');

    expect(repository.selectBatch).toHaveBeenCalledTimes(2);
    // The second page resumes after the last id of the first.
    expect(repository.selectBatch.mock.calls[1][4]).toBe(uuid(KG_MIGRATE_BATCH_SIZE));
    expect(writes.map((w) => w.updates.length)).toEqual([KG_MIGRATE_BATCH_SIZE, 1]);
    expect(result).toMatchObject({ scanned: KG_MIGRATE_BATCH_SIZE + 1, changed: KG_MIGRATE_BATCH_SIZE + 1, needsAttention: 0 });
    expect(writes[0].updates[0]).toEqual({
      id: uuid(1),
      before: { type: 'OldType', status: null, props: { note: 'n0' }, ontologyVersion: '1.0.0' },
      after: { type: 'NewType', status: null, props: { note: 'n0' }, ontologyVersion: '2.0.0' },
    });
    expect(writes[1].updates[0].after).toEqual({ type: 'Project', status: null, props: { start: '2026-01-02' }, ontologyVersion: '2.0.0' });
  });

  it('leaves a row that fails validation untouched and counts it', async () => {
    const { handler, writes } = harness({
      pages: {
        entity: [[row(1, 'OldType', { note: 'x'.repeat(5000) }), row(2, 'OldType', { note: 'fine' }), row(3, 'OldType', { undeclared: 1 })]],
      },
    });

    const result = await handler.migrate(OWNER, '2.0.0');

    expect(result).toMatchObject({ scanned: 3, changed: 1, needsAttention: 2 });
    expect(writes).toHaveLength(1);
    expect(writes[0].updates.map((u) => u.id)).toEqual([uuid(2)]);
  });

  it('counts dropped values only for rows actually written', async () => {
    const { handler, repository } = harness({
      pages: {
        entity: [[row(1, 'Project', { startDate: '2026-01-01', start: '2026-02-02' }), row(2, 'Project', { startDate: '2026-01-01', start: '2026-03-03' })]],
      },
    });
    // The optimistic guard rejects row 2 (edited since it was read).
    repository.writeBatch.mockImplementationOnce(async () => [uuid(1)]);

    const result = await handler.migrate(OWNER, '2.0.0');

    expect(result).toMatchObject({ changed: 1, droppedValues: 1 });
  });

  it('re-versions a selected row whose steps were no-ops, props untouched', async () => {
    const def = fixtureDefinition();
    const definition: KgMigrateDefinition = {
      ...def,
      migrations: [
        def.migrations[0],
        {
          to: '2.0.0',
          description: 'coerce',
          steps: [{ op: 'coerce_attribute', typeKey: 'Project', key: 'status', to: 'select', map: { Active: 'active' } }],
        },
      ],
    };
    const { handler, writes } = harness({
      definition,
      pages: { entity: [[row(1, 'Project', { status: 'active' }, '1.1.0')]] },
    });

    const result = await handler.migrate(OWNER, '2.0.0');

    expect(result).toMatchObject({ changed: 1 });
    expect(writes[0].updates[0].after).toEqual({ type: 'Project', status: null, props: { status: 'active' }, ontologyVersion: '2.0.0' });
  });

  it('counts a row with a malformed stored version as needing attention', async () => {
    const { handler, writes } = harness({ pages: { entity: [[row(1, 'OldType', { note: 'x' }, '01.0.0')]] } });

    const result = await handler.migrate(OWNER, '2.0.0');

    expect(result).toMatchObject({ needsAttention: 1, changed: 0 });
    expect(writes).toEqual([]);
  });

  it('flags drafts older than the end of the major migration\'s CHANGELOG day', async () => {
    const { handler, repository } = harness();
    repository.flagStaleDrafts.mockResolvedValue(4);

    const result = await handler.migrate(OWNER, '2.0.0');

    expect(repository.flagStaleDrafts).toHaveBeenCalledWith(OWNER, new Date('2026-09-28T00:00:00.000Z'));
    expect(result.staleDraftItems).toBe(4);
  });

  it('does not flag drafts when no major migration is in range', async () => {
    const { handler, repository } = harness();

    await handler.migrate(OWNER, '1.1.0');

    expect(repository.flagStaleDrafts).not.toHaveBeenCalled();
  });

  it('validates with every domain, so a row of a domain the owner switched off still migrates', async () => {
    // Trip is a `personal` type (off by default); its row must still validate.
    const def = fixtureDefinition();
    const definition: KgMigrateDefinition = {
      ...def,
      migrations: [
        def.migrations[0],
        { to: '2.0.0', description: 'drop', steps: [{ op: 'drop_attribute', typeKey: 'Trip', key: 'destination' }] },
      ],
    };
    const { handler, writes } = harness({
      definition,
      pages: { entity: [[row(1, 'Trip', { destination: 'Lisbon', startDate: '2026-05-01' })]] },
    });

    const result = await handler.migrate(OWNER, '2.0.0');

    expect(result).toMatchObject({ changed: 1, needsAttention: 0, droppedValues: 1 });
    expect(writes[0].updates[0].after.props).toEqual({ startDate: '2026-05-01' });
  });
});
