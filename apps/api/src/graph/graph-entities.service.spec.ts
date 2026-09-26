import type { EventEmitter2 } from '@nestjs/event-emitter';

import type { AiSettingsService } from '../ai/ai-settings.service';
import type { JobHandlerRegistry } from '../jobs/job-handler.registry';
import type { JobsService } from '../jobs/jobs.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GraphAccessService } from './access/graph-access.service';
import { FORGET_CONFIRMATION_MESSAGE, FORGET_NOT_PERSON_MESSAGE } from './dto/graph-forget.dto';
import {
  GRAPH_ENTITY_EDITED_ACTION,
  GRAPH_PERSON_FORGET_REQUESTED_ACTION,
  GraphEntitiesService,
} from './graph-entities.service';
import { KG_EMBED_JOB_TYPE, KG_ENTITY_DIGEST_JOB_TYPE, KG_PURGE_JOB_TYPE } from './job-types';
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
  const jobs = { enqueue: jest.fn(async (): Promise<{ id: string; status?: string }> => ({ id: 'job', status: 'pending' })) };
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
  const access = { require: jest.fn(async (): Promise<typeof entityRow> => entityRow) };
  const ontology = { effectiveSchemaFor: jest.fn(async () => ({})) };
  const events = { emit: jest.fn() };
  const service = new GraphEntitiesService(
    prisma as unknown as PrismaService,
    access as unknown as GraphAccessService,
    ontology as unknown as GraphOntologyService,
    write as unknown as GraphWriteService,
    jobs as unknown as JobsService,
    registry as unknown as JobHandlerRegistry,
    aiSettings as unknown as AiSettingsService,
    events as unknown as EventEmitter2,
  );
  return { service, registry, jobs, aiSettings, prisma, access, write, events };
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

  it('emits graph.changed (manual_edit) after a committed change, and not for a no-op', async () => {
    const changed = setup();
    await changed.service.patch(ENTITY, { label: 'Sarah' }, user);
    expect(changed.events.emit).toHaveBeenCalledWith('graph.changed', { ownerId: OWNER, reason: 'manual_edit' });
    // After the transaction, never inside it.
    expect(changed.events.emit.mock.invocationCallOrder[0]).toBeGreaterThan(
      changed.prisma.$transaction.mock.invocationCallOrder[0],
    );

    const unchanged = setup({ changed: false });
    await unchanged.service.patch(ENTITY, { label: 'Sarah' }, user);
    expect(unchanged.events.emit).not.toHaveBeenCalled();
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

describe('GraphEntitiesService.forget (#357)', () => {
  const confirm = { confirmation: 'FORGET' };

  it.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['a lowercase word', { confirmation: 'forget' }],
    ['another scope word', { confirmation: 'EVERYTHING' }],
  ])('refuses %s with the typed-confirmation 400, before any lookup', async (_label, body) => {
    const { service, access, jobs } = setup();

    await expect(service.forget(ENTITY, body, user)).rejects.toMatchObject({
      status: 400,
      message: FORGET_CONFIRMATION_MESSAGE,
    });
    expect(access.require).not.toHaveBeenCalled();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('authorises at edit level with the caller permissions (404/403 come from GraphAccessService)', async () => {
    const { service, access } = setup();

    await service.forget(ENTITY, confirm, user);

    expect(access.require).toHaveBeenCalledWith(OWNER, 'entity', ENTITY, 'edit', ['graph:write']);
  });

  it('refuses a non-Person with its own 400', async () => {
    const { service, access, jobs } = setup();
    access.require.mockResolvedValueOnce({ ...entityRow, type: 'Organization' });

    await expect(service.forget(ENTITY, confirm, user)).rejects.toMatchObject({
      status: 400,
      message: FORGET_NOT_PERSON_MESSAGE,
    });
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues kg.purge { scope: person } on the entity subject, with ordinary dedup', async () => {
    const { service, jobs } = setup();

    await expect(service.forget(ENTITY, confirm, user)).resolves.toEqual({
      jobId: 'job',
      entityId: ENTITY,
      status: 'pending',
    });
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: KG_PURGE_JOB_TYPE,
      reason: 'rerun',
      subjectType: 'kg_entity',
      subjectId: ENTITY,
      payload: { userId: OWNER, scope: 'person', entityId: ENTITY },
    });
  });

  it('reports a deduplicated, already-running job as running', async () => {
    const { service, jobs } = setup();
    jobs.enqueue.mockResolvedValueOnce({ id: 'live', status: 'running' });

    await expect(service.forget(ENTITY, confirm, user)).resolves.toEqual({
      jobId: 'live',
      entityId: ENTITY,
      status: 'running',
    });
  });

  it('audits the request with ids only', async () => {
    const { service, prisma } = setup();

    await service.forget(ENTITY, confirm, user);

    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: OWNER,
        action: GRAPH_PERSON_FORGET_REQUESTED_ACTION,
        targetType: 'kg_entity',
        targetId: ENTITY,
        meta: { entityId: ENTITY, jobId: 'job' },
      },
    });
  });
});
