import { PassThrough } from 'node:stream';
import type { Job, KgExport } from '@prisma/client';

import { KG_EXPORT_MAX_RUNTIME_MS, KgExportHandler } from './kg-export.handler';
import type { GraphExportSource, RawEntityPageRow, RawItemPageRow } from './graph-export.source';

// =============================================================================
// kg.export (#386) with mocked storage and a mocked source: streaming into the
// upload, the stats and audit on ready, failure recording, the sensitive
// filter end to end, determinism, and the sweep mode.
// =============================================================================

const OWNER = '0b6e3c1a-4d2f-4a8b-9c7d-000000000001';
const EXPORT = '0b6e3c1a-4d2f-4a8b-9c7d-000000000099';
const PERSON = '0b6e3c1a-4d2f-4a8b-9c7d-000000000010';
const FACT = '0b6e3c1a-4d2f-4a8b-9c7d-000000000020';
const SECRET_FACT = '0b6e3c1a-4d2f-4a8b-9c7d-000000000021';
const EV = (n: number) => `0b6e3c1a-4d2f-4a8b-9c7d-0000000001${String(n).padStart(2, '0')}`;

function exportRow(overrides: Partial<KgExport> = {}): KgExport {
  return {
    id: EXPORT,
    ownerId: OWNER,
    format: 'turtle',
    status: 'pending',
    graphFingerprint: 'fp',
    ontologyVersion: '1.0.0',
    objectId: null,
    stats: {},
    errorMessage: null,
    jobId: 'job-1',
    expiresAt: new Date('2026-09-08T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

const job = (payload: unknown): Job => ({ id: 'job-1', payload, subjectType: 'kg_export', subjectId: EXPORT }) as unknown as Job;

function entityPage(): RawEntityPageRow[] {
  return [
    { id: PERSON, type: 'Person', label: 'Sarah Chen', props: {}, reviewStatus: 'accepted', occurredAt: null, ontologyVersion: '1.0.0' },
  ];
}

function itemPage(): RawItemPageRow[] {
  const base = {
    kind: 'person_fact',
    title: null,
    props: {},
    status: 'active',
    occurredAt: null,
    dueAt: null,
    validFrom: null,
    validTo: null,
    validPrecision: null,
    reviewStatus: 'accepted',
    confidence: null,
    ontologyVersion: '1.0.0',
    subjectId: PERSON,
    meetingId: null,
    ownerPersonId: null,
    counterpartyId: null,
  };
  return [
    { ...base, id: FACT, statement: 'Sarah prefers written updates.', sensitivity: 'personal' },
    { ...base, id: SECRET_FACT, statement: 'SECRET-HEALTH-DETAIL', sensitivity: 'sensitive' },
  ];
}

function setup(options: { failOn?: 'entityPage' | 'upload' } = {}) {
  const prisma = {
    kgExport: {
      findUnique: jest.fn().mockResolvedValue(exportRow()),
      update: jest.fn().mockResolvedValue(exportRow()),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({}),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const source = {
    attributeDefs: jest.fn().mockResolvedValue([]),
    fingerprintTables: jest.fn().mockResolvedValue({
      kg_attribute_defs: { count: 0, lastChangedAt: null },
      kg_entities: { count: 1, lastChangedAt: '2026-09-01T00:00:00.000Z' },
      kg_entity_aliases: { count: 1, lastChangedAt: null },
      kg_evidence: { count: 3, lastChangedAt: null },
      kg_items: { count: 2, lastChangedAt: null },
      kg_relations: { count: 0, lastChangedAt: null },
    }),
    entityPage: jest.fn().mockImplementation(async (_o: string, after: string | null) => {
      if (options.failOn === 'entityPage') throw new Error('database went away while reading Sarah Chen');
      return after === null ? entityPage() : [];
    }),
    aliasesFor: jest.fn().mockResolvedValue(new Map([[PERSON, ['Sarah Chen', 'Sarah']]])),
    evidenceIdsFor: jest.fn().mockImplementation(async (_o: string, kind: string) => {
      if (kind === 'entity') return new Map([[PERSON, [EV(1)]]]);
      if (kind === 'item') return new Map([[FACT, [EV(2)]], [SECRET_FACT, [EV(3)]]]);
      return new Map();
    }),
    outgoingRelations: jest.fn().mockResolvedValue([]),
    exportedEntityTypes: jest.fn().mockResolvedValue(new Map([[PERSON, 'Person']])),
    evidencePage: jest.fn().mockImplementation(async (_o: string, after: string | null) =>
      after === null
        ? [1, 2, 3].map((n) => ({
            id: EV(n),
            subjectKind: n === 1 ? 'entity' : 'item',
            subjectSensitivity: n === 3 ? 'sensitive' : n === 2 ? 'personal' : null,
            quote: n === 3 ? 'SECRET-HEALTH-QUOTE' : `quote ${n}`,
            segmentId: null,
            startMs: null,
            endMs: null,
            noteId: null,
            noteVersion: null,
            charStart: null,
            charEnd: null,
          }))
        : [],
    ),
    sourceTitles: jest.fn().mockResolvedValue({ segments: new Map(), notes: new Map() }),
    itemPage: jest.fn().mockImplementation(async (_o: string, after: string | null) => (after === null ? itemPage() : [])),
    supersededBy: jest.fn().mockResolvedValue(new Map()),
    relationPage: jest.fn().mockResolvedValue([]),
  };
  const uploads: string[] = [];
  const objects = {
    putStream: jest.fn().mockImplementation(() => {
      const body = new PassThrough();
      const chunks: Buffer[] = [];
      body.on('data', (c: Buffer) => chunks.push(c));
      const done = new Promise((resolve, reject) => {
        if (options.failOn === 'upload') {
          body.on('error', () => undefined);
          setImmediate(() => reject(new Error('storage refused the upload')));
          return;
        }
        body.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          uploads.push(text);
          resolve({ id: 'object-1', size: BigInt(Buffer.byteLength(text)) });
        });
      });
      done.catch(() => body.destroy());
      return { body, done };
    }),
    deleteIfPresent: jest.fn().mockResolvedValue(true),
  };
  const registry = { register: jest.fn() };
  const handler = new KgExportHandler(registry as never, prisma as never, source as unknown as GraphExportSource, objects as never);
  return { handler, prisma, source, objects, uploads, registry };
}

describe('KgExportHandler', () => {
  it('declares the spec §11 profile and is server-only (no node result members)', () => {
    const { handler, registry } = setup();
    expect(handler.type).toBe('kg.export');
    expect(handler.profile).toEqual({ maxRuntimeMs: KG_EXPORT_MAX_RUNTIME_MS, maxAttempts: 3 });
    expect(KG_EXPORT_MAX_RUNTIME_MS).toBe(600_000);
    expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>).persistNodeResult).toBeUndefined();
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('streams the export into a managed object and marks it ready with stats and an audit row', async () => {
    const { handler, prisma, objects, uploads } = setup();
    await handler.process(job({ mode: 'render', exportId: EXPORT }));

    expect(objects.putStream).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: `graph/${OWNER}/exports/${EXPORT}.ttl`,
        mimeType: 'text/turtle',
        ownerId: OWNER,
        name: expect.stringMatching(/-graph-2026-09-01\.ttl$/),
      }),
    );
    expect(prisma.kgExport.update).toHaveBeenNthCalledWith(1, { where: { id: EXPORT }, data: { status: 'running', errorMessage: null } });
    const ready = prisma.kgExport.update.mock.calls.at(-1)![0];
    expect(ready.data).toMatchObject({
      status: 'ready',
      objectId: 'object-1',
      stats: { entities: 1, relations: 0, items: 1, evidence: 2, excludedSensitive: 1, bytes: Buffer.byteLength(uploads[0]) },
    });
    expect(ready.data.graphFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: OWNER,
        action: 'graph.exported',
        targetType: 'kg_export',
        targetId: EXPORT,
        meta: expect.objectContaining({ exportId: EXPORT, format: 'turtle' }),
      }),
    });
    expect(uploads[0]).toContain('Sarah Chen');
    expect(uploads[0]).toContain('Sarah prefers written updates.');
  });

  it('⚠ never writes a sensitive fact or its evidence quote into the file', async () => {
    const { handler, uploads } = setup();
    await handler.process(job({ mode: 'render', exportId: EXPORT }));
    expect(uploads[0]).not.toContain('SECRET-HEALTH-DETAIL');
    expect(uploads[0]).not.toContain('SECRET-HEALTH-QUOTE');
    expect(uploads[0]).not.toContain(SECRET_FACT);
  });

  it('is deterministic: two runs over the same graph write identical bytes', async () => {
    const a = setup();
    const b = setup();
    await a.handler.process(job({ mode: 'render', exportId: EXPORT }));
    await b.handler.process(job({ mode: 'render', exportId: EXPORT }));
    expect(a.uploads[0]).toBe(b.uploads[0]);
  });

  it.each([
    ['jsonld', '.jsonld', 'application/ld+json'],
    ['nquads', '.nq', 'application/n-quads'],
  ] as const)('writes %s', async (format, extension, mimeType) => {
    const { handler, prisma, objects, uploads } = setup();
    prisma.kgExport.findUnique.mockResolvedValue(exportRow({ format }));
    await handler.process(job({ mode: 'render', exportId: EXPORT }));
    expect(objects.putStream).toHaveBeenCalledWith(expect.objectContaining({ mimeType, storageKey: expect.stringMatching(new RegExp(`\\${extension}$`)) }));
    expect(uploads[0]).toContain('Sarah Chen');
    if (format === 'jsonld') expect(() => JSON.parse(uploads[0])).not.toThrow();
  });

  it('records a short, row-free failure and rethrows so the queue counts the attempt', async () => {
    const { handler, prisma } = setup({ failOn: 'entityPage' });
    await expect(handler.process(job({ mode: 'render', exportId: EXPORT }))).rejects.toThrow('database went away');
    const failed = prisma.kgExport.update.mock.calls.at(-1)![0];
    expect(failed.data.status).toBe('failed');
    expect(failed.data.errorMessage).not.toContain('Sarah');
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it('fails the export when the upload fails, even though the render finished', async () => {
    const { handler, prisma } = setup({ failOn: 'upload' });
    await expect(handler.process(job({ mode: 'render', exportId: EXPORT }))).rejects.toThrow();
    expect(prisma.kgExport.update.mock.calls.at(-1)![0].data.status).toBe('failed');
  });

  it('does nothing for a missing export or one already ready', async () => {
    const missing = setup();
    missing.prisma.kgExport.findUnique.mockResolvedValue(null);
    await missing.handler.process(job({ mode: 'render', exportId: EXPORT }));
    expect(missing.objects.putStream).not.toHaveBeenCalled();

    const ready = setup();
    ready.prisma.kgExport.findUnique.mockResolvedValue(exportRow({ status: 'ready', objectId: 'object-1' }));
    await ready.handler.process(job({ mode: 'render', exportId: EXPORT }));
    expect(ready.objects.putStream).not.toHaveBeenCalled();
  });

  it('sweep mode deletes expired exports: reference, then file, then row', async () => {
    const { handler, prisma, objects } = setup();
    prisma.kgExport.findMany.mockResolvedValue([
      { id: 'e1', objectId: 'o1' },
      { id: 'e2', objectId: null },
    ]);
    await handler.process(job({ mode: 'sweep' }));
    expect(prisma.kgExport.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { expiresAt: { lt: expect.any(Date) } }, take: 500 }));
    expect(prisma.kgExport.update).toHaveBeenCalledWith({ where: { id: 'e1' }, data: { objectId: null } });
    expect(objects.deleteIfPresent).toHaveBeenCalledWith('o1');
    expect(objects.deleteIfPresent).toHaveBeenCalledTimes(1);
    expect(prisma.kgExport.delete).toHaveBeenCalledWith({ where: { id: 'e1' } });
    expect(prisma.kgExport.delete).toHaveBeenCalledWith({ where: { id: 'e2' } });
    expect(objects.putStream).not.toHaveBeenCalled();
  });
});
