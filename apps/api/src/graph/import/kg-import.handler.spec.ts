import { Readable } from 'node:stream';

import { ONTOLOGY, ONTOLOGY_VERSION } from '@app/shared/ontology';

import { RateLimitError } from '../../jobs/rate-limit.error';
import { GRAPH_PREFERENCE_DEFAULTS } from '../preferences/graph-preferences.defaults';
import { importFixtureStream, type ImportFixture } from '../../../test/graph/rdf/import-fixtures';
import type { KgMigrateDefinition } from '../migrate/kg-migrate.plan';
import { KgImportHandler, KG_IMPORT_MAX_RUNTIME_MS } from './kg-import.handler';
import type { ShaclEngine, ShaclEngineReport } from './shacl-engine';

// =============================================================================
// kg.import — the pipeline with every collaborator faked (#387)
// =============================================================================
//
// Each failure reason marks the proposal `failed` with `stats.failureReason`,
// RETURNS (a permanent outcome is success), and writes no proposal row and no
// graph row. The success path writes rows (`origin: user`, flag `imported`,
// import evidence), runs every stage in order with `noteId: null` after
// registering the owner's throttle key, and finalizes a draft. A rate limit
// from a stage defers (rethrown, not failed); anything else fails and rethrows.
// The real SHACL engine and database run in `import-roundtrip.db.spec.ts`.
// =============================================================================

const PROPOSAL = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const OBJECT = '33333333-3333-4333-8333-333333333333';

const CONFORMS: ShaclEngineReport = { conforms: true, violationCount: 0, warningCount: 0, results: [] };

function setup(options: { fixture?: ImportFixture; text?: string; format?: 'turtle' | 'jsonld'; report?: ShaclEngineReport; definition?: KgMigrateDefinition; pending?: boolean } = {}) {
  const fixture = options.fixture ?? 'import-valid.ttl';
  let status = 'extracting';
  let stats: Record<string, unknown> = { filename: fixture, format: options.format ?? 'turtle', bytes: 100 };
  const writes: string[] = [];
  const prisma: Record<string, unknown> = {
    kgProposal: {
      findUnique: jest.fn(async () => ({ id: PROPOSAL, kind: 'import', status, ownerId: OWNER, stats })),
      update: jest.fn(async ({ data }: { data: { status?: string; stats?: Record<string, unknown> } }) => {
        if (data.status) status = data.status;
        if (data.stats) stats = data.stats;
        writes.push(`proposal.update:${data.status ?? 'stats'}`);
      }),
      updateMany: jest.fn(async ({ data }: { data: { status: string; stats: Record<string, unknown> } }) => {
        status = data.status;
        stats = data.stats;
        writes.push(`proposal.updateMany:${data.status}`);
        return { count: 1 };
      }),
    },
    kgProposalItem: {
      findMany: jest.fn(async () => []),
      createMany: jest.fn(async () => writes.push('items.createMany')),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    kgEvidence: {
      createMany: jest.fn(async () => writes.push('evidence.createMany')),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    kgEntity: { create: jest.fn() },
    kgRelation: { create: jest.fn() },
    kgItem: { create: jest.fn() },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));

  const engine: ShaclEngine = { validate: jest.fn(async () => options.report ?? CONFORMS) };
  const stageCalls: Array<{ name: string; ctx: Record<string, unknown> }> = [];
  const stage = (name: string, run?: () => Promise<void>) => ({
    name,
    order: 0,
    run: jest.fn(async (ctx: Record<string, unknown>) => {
      stageCalls.push({ name, ctx });
      await run?.();
    }),
  });
  const stages = [stage('resolution'), stage('work-item-dedup')];
  const throttle = { registerProviderKey: jest.fn() };
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job' })) };
  const migrations = { ownerHasPendingMigration: jest.fn(async () => options.pending ?? false) };

  const handler = new KgImportHandler(
    { register: jest.fn() } as never,
    prisma as never,
    {
      openStream: jest.fn(async () => ({
        stream: options.text !== undefined ? Readable.from([Buffer.from(options.text)]) : importFixtureStream(fixture),
        object: { id: OBJECT, uploadedById: OWNER },
      })),
    } as never,
    { attributeDefsFor: jest.fn(async () => []), effectiveSchemaFor: jest.fn(async () => ({ entityTypes: [], relationTypes: [] })) } as never,
    { get: jest.fn(async () => GRAPH_PREFERENCE_DEFAULTS) } as never,
    { ordered: () => stages } as never,
    throttle as never,
    jobs as never,
    migrations as never,
    options.definition,
    engine,
  );
  const run = () => handler.process({ id: 'job-1', payload: { proposalId: PROPOSAL, ownerId: OWNER, objectId: OBJECT, format: options.format ?? 'turtle' } } as never);
  return { handler, prisma: prisma as Record<string, Record<string, jest.Mock>>, engine, stages, stageCalls, throttle, jobs, run, writes, state: () => ({ status, stats }) };
}

/** No proposal row and no graph row was ever written. */
function expectNothingWritten(t: ReturnType<typeof setup>) {
  expect(t.prisma.kgProposalItem.createMany).not.toHaveBeenCalled();
  expect(t.prisma.kgEvidence.createMany).not.toHaveBeenCalled();
  expect(t.prisma.kgEntity.create).not.toHaveBeenCalled();
  expect(t.prisma.kgRelation.create).not.toHaveBeenCalled();
  expect(t.prisma.kgItem.create).not.toHaveBeenCalled();
}

describe('KgImportHandler', () => {
  it('declares a 30-minute, single-attempt, server-only profile', () => {
    const { handler } = setup();
    expect(handler.type).toBe('kg.import');
    expect(handler.profile).toEqual({ maxRuntimeMs: KG_IMPORT_MAX_RUNTIME_MS, maxAttempts: 1 });
    expect(KG_IMPORT_MAX_RUNTIME_MS).toBe(30 * 60_000);
    expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>).persistNodeResult).toBeUndefined();
  });

  it('is a no-op for an unreadable payload or a proposal that is not an extracting import', async () => {
    const t = setup();
    await t.handler.process({ id: 'j', payload: { nope: true } } as never);
    t.prisma.kgProposal.findUnique.mockResolvedValueOnce({ id: PROPOSAL, kind: 'extraction', status: 'extracting', ownerId: OWNER, stats: {} });
    await t.run();
    expect(t.engine.validate).not.toHaveBeenCalled();
    expect(t.writes).toEqual([]);
  });

  it('shacl_violations: stores the report, fails, writes nothing', async () => {
    const report: ShaclEngineReport = {
      conforms: false,
      violationCount: 1,
      warningCount: 0,
      results: [{ focusNode: 'https://s.example/x', path: 'http://www.w3.org/ns/prov#wasDerivedFrom', message: 'Less than 1 values', severity: 'Violation' }],
    };
    const t = setup({ report });
    await expect(t.run()).resolves.toBeUndefined();
    expect(t.state().status).toBe('failed');
    expect(t.state().stats).toMatchObject({
      failureReason: 'shacl_violations',
      validation: { conforms: false, violationCount: 1, violations: [expect.objectContaining({ message: 'Less than 1 values' })] },
      failure: { errorClass: 'shacl_violations' },
    });
    expectNothingWritten(t);
    expect(t.stages[0].run).not.toHaveBeenCalled();
  });

  it('ontology_version_newer: refused before validation', async () => {
    const t = setup({ fixture: 'import-newer-major.ttl' });
    await t.run();
    expect(t.state().stats).toMatchObject({ failureReason: 'ontology_version_newer', sourceOntologyVersion: '99.0.0' });
    expect(t.engine.validate).not.toHaveBeenCalled();
    expectNothingWritten(t);
  });

  it('migration_pending: queues kg.migrate for the owner and fails', async () => {
    const definition: KgMigrateDefinition = {
      registry: ONTOLOGY,
      migrations: [{ to: '9.0.0', description: 'x', steps: [{ op: 'drop_attribute', typeKey: 'Person', key: 'old' }] }],
      changelog: [],
      targetVersion: '9.0.0',
    };
    const t = setup({ definition, pending: true });
    await t.run();
    expect(t.state().stats).toMatchObject({ failureReason: 'migration_pending' });
    expect(t.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'kg.migrate', subjectType: 'user', subjectId: OWNER, payload: { ownerId: OWNER, targetVersion: '9.0.0' } }));
    expectNothingWritten(t);
  });

  it('migrates an older file in memory, reporting migratedFrom', async () => {
    const definition: KgMigrateDefinition = {
      registry: ONTOLOGY,
      migrations: [{ to: '1.0.1', description: 'x', steps: [{ op: 'drop_attribute', typeKey: 'Person', key: 'title' }] }],
      changelog: [],
      targetVersion: ONTOLOGY_VERSION,
    };
    const t = setup({ definition });
    await t.run();
    expect(t.state()).toMatchObject({ status: 'draft', stats: { sourceOntologyVersion: '1.0.0', migratedFrom: '1.0.0' } });
    const data = (t.prisma.kgProposalItem.createMany.mock.calls[0][0] as { data: Array<{ payload: { label?: string; props?: object } }> }).data;
    expect(data.find((r) => r.payload.label === 'Joe Smith')?.payload.props).toEqual({});
  });

  it.each([
    ['parse_error', { fixture: 'import-crm.jsonld' as ImportFixture }],
    ['empty', { text: '<https://s.example/a> a <https://schema.org/Person> .' }],
    ['too_large', { text: Array.from({ length: 200_001 }, (_, i) => `<https://s.example/${i}> <https://p.example/p> "v" .`).join('\n') }],
  ])('%s: fails with the reason, nothing written', async (reason, opts) => {
    const t = setup({ ...opts, format: 'turtle' });
    await t.run();
    expect(t.state()).toMatchObject({ status: 'failed', stats: { failureReason: reason } });
    expect(t.engine.validate).not.toHaveBeenCalled();
    expectNothingWritten(t);
  }, 60_000);

  it('success: writes user rows flagged imported with import evidence, runs every stage, finalizes a draft', async () => {
    const t = setup();
    await t.run();

    const items = (t.prisma.kgProposalItem.createMany.mock.calls[0][0] as { data: Array<Record<string, unknown>> }).data;
    expect(items).toHaveLength(6); // 3 entities, 2 relations, 1 commitment
    expect(items.every((r) => r.origin === 'user' && (r.flags as string[]).includes('imported') && r.proposalId === PROPOSAL)).toBe(true);
    const evidence = (t.prisma.kgEvidence.createMany.mock.calls[0][0] as { data: Array<Record<string, unknown>> }).data;
    expect(evidence).toHaveLength(6);
    expect(evidence.every((e) => e.importObjectId === OBJECT && e.subjectKind === 'proposal_item' && e.ownerId === OWNER)).toBe(true);
    expect(evidence.map((e) => e.subjectId).sort()).toEqual(items.map((r) => r.id).sort());

    expect(t.stageCalls.map((c) => c.name)).toEqual(['resolution', 'work-item-dedup']);
    expect(t.stageCalls[0].ctx).toMatchObject({ proposalId: PROPOSAL, userId: OWNER, noteId: null });
    expect(t.throttle.registerProviderKey).toHaveBeenCalledWith('kg.import', expect.stringContaining(OWNER));
    expect(t.state()).toMatchObject({
      status: 'draft',
      stats: { failureReason: null, triples: expect.any(Number), counts: { entities: 3, relations: 2, items: 1, skippedSensitive: 0 }, validation: { conforms: true } },
    });
    expect(t.state().stats).toHaveProperty('prechecked');
    expect(t.state().stats).toHaveProperty('resolution');
  });

  it('defers on a rate limit from a stage (rethrown, the proposal stays extracting)', async () => {
    const t = setup();
    t.stages[0].run.mockRejectedValueOnce(new RateLimitError('slow down'));
    await expect(t.run()).rejects.toBeInstanceOf(RateLimitError);
    expect(t.state().status).toBe('extracting');
  });

  it('fails and rethrows an unexpected error', async () => {
    const t = setup();
    t.stages[1].run.mockRejectedValueOnce(new TypeError('boom'));
    await expect(t.run()).rejects.toBeInstanceOf(TypeError);
    expect(t.state().status).toBe('failed');
    expect(t.state().stats).toMatchObject({ failureReason: null, failure: { errorClass: 'other' } });
    expect(t.state().stats).not.toHaveProperty('importPending');
  });
});
