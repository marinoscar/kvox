import type { AiSettingsService } from '../ai/ai-settings.service';
import type { JobHandlerRegistry } from '../jobs/job-handler.registry';
import type { JobsService } from '../jobs/jobs.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GraphAccessService } from './access/graph-access.service';
import { GRAPH_ENTITY_EDITED_ACTION, GraphEntitiesService } from './graph-entities.service';
import { KG_EMBED_JOB_TYPE, KG_ENTITY_DIGEST_JOB_TYPE } from './job-types';
import type { GraphOntologyService } from './ontology/graph-ontology.service';
import { GraphValidationError } from './write/graph-write.errors';
import type { GraphWriteService } from './write/graph-write.service';

// =============================================================================
// GraphEntitiesService — the PATCH envelope: audit, and the GUARDED enqueues
// =============================================================================

const OWNER = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';

const entityRow = {
  id: ENTITY,
  ownerId: OWNER,
  type: 'Person',
  label: 'Sarah',
  props: {},
  reviewStatus: 'edited',
  mergedIntoId: null,
  occurredAt: null,
  ontologyVersion: '1.0.0',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-02T00:00:00Z'),
};

function setup(opts: { registered?: string[]; graphEnabled?: boolean; changed?: boolean } = {}) {
  const registered = new Set(opts.registered ?? []);
  const registry = { get: jest.fn((type: string) => (registered.has(type) ? { type } : undefined)) };
  const jobs = { enqueue: jest.fn(async () => ({ id: 'job' })) };
  const aiSettings = { get: jest.fn(async () => (opts.graphEnabled === undefined ? {} : { graphEnabled: opts.graphEnabled })) };
  const tx = { kgEntityAlias: { findMany: jest.fn(async () => []) } };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    auditEvent: { create: jest.fn(async () => ({})) },
  };
  const write = {
    updateEntityDetailed: jest.fn(async () => ({
      entity: entityRow,
      changed: opts.changed ?? true,
      changedKeys: ['title'],
      labelChanged: true,
      aliasesAdded: 1,
      aliasesRemoved: 0,
    })),
  };
  const access = { require: jest.fn(async () => entityRow) };
  const ontology = { effectiveSchemaFor: jest.fn(async () => ({})) };
  const service = new GraphEntitiesService(
    prisma as unknown as PrismaService,
    access as unknown as GraphAccessService,
    ontology as unknown as GraphOntologyService,
    write as unknown as GraphWriteService,
    jobs as unknown as JobsService,
    registry as unknown as JobHandlerRegistry,
    aiSettings as unknown as AiSettingsService,
  );
  return { service, registry, jobs, aiSettings, prisma, access, write };
}

const user = { id: OWNER, permissions: ['graph:write'] } as never;

describe('GraphEntitiesService', () => {
  it('authorises with edit level and the caller permissions before writing', async () => {
    const { service, access } = setup();
    await service.patch(ENTITY, { label: 'Sarah' }, user);
    expect(access.require).toHaveBeenCalledWith(OWNER, 'entity', ENTITY, 'edit', ['graph:write']);
  });

  it('audits graph.entity_edited with keys and counts only', async () => {
    const { service, prisma } = setup();
    await service.patch(ENTITY, { label: 'Sarah' }, user);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: OWNER,
        action: GRAPH_ENTITY_EDITED_ACTION,
        targetType: 'kg_entity',
        targetId: ENTITY,
        meta: { changedKeys: ['title'], labelChanged: true, aliasesAdded: 1, aliasesRemoved: 0 },
      },
    });
  });

  it('enqueues nothing while neither handler is registered', async () => {
    const { service, jobs, aiSettings } = setup({ registered: [], graphEnabled: true });
    await service.patch(ENTITY, { label: 'Sarah' }, user);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(aiSettings.get).not.toHaveBeenCalled();
  });

  it('enqueues exactly one kg.embed once its handler is registered, in the #364 shape', async () => {
    const { service, jobs } = setup({ registered: [KG_EMBED_JOB_TYPE] });
    await service.patch(ENTITY, { label: 'Sarah' }, user);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: 'kg.embed',
      reason: 'rerun',
      subjectType: 'user',
      subjectId: OWNER,
      skipDedup: true,
      payload: { userId: OWNER, subjectKind: 'entity', ids: [ENTITY] },
    });
  });

  it('enqueues kg.entity_digest only when registered AND ai.graphEnabled, in the #372 shape', async () => {
    const off = setup({ registered: [KG_ENTITY_DIGEST_JOB_TYPE] });
    await off.service.patch(ENTITY, { label: 'Sarah' }, user);
    expect(off.jobs.enqueue).not.toHaveBeenCalled();

    const on = setup({ registered: [KG_ENTITY_DIGEST_JOB_TYPE], graphEnabled: true });
    await on.service.patch(ENTITY, { label: 'Sarah' }, user);
    expect(on.jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(on.jobs.enqueue).toHaveBeenCalledWith({
      type: 'kg.entity_digest',
      reason: 'backfill',
      subjectType: 'kg_entity',
      subjectId: ENTITY,
      payload: { entityId: ENTITY, ownerId: OWNER },
    });
  });

  it('neither audits nor enqueues when nothing changed', async () => {
    const { service, jobs, prisma } = setup({ registered: [KG_EMBED_JOB_TYPE], changed: false });
    await service.patch(ENTITY, { label: 'Sarah' }, user);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it('does not fail the edit when a follow-up enqueue throws', async () => {
    const { service, jobs } = setup({ registered: [KG_EMBED_JOB_TYPE] });
    jobs.enqueue.mockRejectedValueOnce(new Error('queue down'));
    await expect(service.patch(ENTITY, { label: 'Sarah' }, user)).resolves.toMatchObject({ id: ENTITY });
  });

  it('maps a domain validation error to a 400', async () => {
    const { service, write } = setup();
    write.updateEntityDetailed.mockRejectedValueOnce(new GraphValidationError('bad', { issues: [] }));
    await expect(service.patch(ENTITY, { label: 'Sarah' }, user)).rejects.toMatchObject({ status: 400 });
  });
});
