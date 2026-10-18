// =============================================================================
// KgSpeakerLinkHandler (#356): the profile, server-only registration, and the
// thin delegation to SpeakerLinkReconciler.
// =============================================================================

import { auditPortOver } from '../__fixtures__/audit-port.js';
import { jobsMock } from '../__fixtures__/jobs-mock.js';
import type { KvoxJob, KvoxJobHandler } from '../../ports/index.js';
import { KG_EMBED_JOB_TYPE, KG_SPEAKER_LINK_JOB_TYPE } from '../job-types.js';
import { SpeakerLinkReconciler } from '../speaker-link/speaker-link.reconciler.js';
import { KgSpeakerLinkHandler, readSpeakerLinkPayload } from './kg-speaker-link.handler.js';

const TRANSCRIPT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

function job(payload: unknown): KvoxJob {
  return { id: 'job-1', type: KG_SPEAKER_LINK_JOB_TYPE, payload } as KvoxJob;
}

function setup(summary: Record<string, unknown> = {}, embedRegistered = false) {
  const jobs = jobsMock(embedRegistered ? [KG_EMBED_JOB_TYPE] : []);
  const tx = { marker: 'tx' };
  const prisma = { $transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)) };
  const context = { schema: { marker: 'schema' }, canWrite: true };
  const reconciler = {
    resolveContext: jest.fn().mockResolvedValue(context),
    reconcile: jest.fn().mockResolvedValue({
      skipped: null,
      ownerId: OWNER,
      linked: 1,
      created: 1,
      unlinked: 0,
      createdPersonIds: ['p-1'],
      audit: [],
      ...summary,
    }),
  };
  const audit = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };
  const handler = new KgSpeakerLinkHandler(jobs as never, prisma as never, reconciler as never, auditPortOver(audit));
  handler.onModuleInit();
  return { registry: jobs, handler, prisma, reconciler, jobs, tx, audit, context };
}

describe('KgSpeakerLinkHandler', () => {
  it('declares { maxRuntimeMs: 120000, maxAttempts: 3 }', () => {
    expect(setup().handler.profile).toEqual({ maxRuntimeMs: 120_000, maxAttempts: 3 });
  });

  it('self-registers as a server-only type (no nodeResultSchema/persistNodeResult)', () => {
    const { registry, handler } = setup();
    expect(registry.get(KG_SPEAKER_LINK_JOB_TYPE)).toBe(handler);
    const asHandler: KvoxJobHandler = handler;
    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
    expect(registry.serverOnlyTypes()).toContain(KG_SPEAKER_LINK_JOB_TYPE);
  });

  it('delegates to the reconciler on one transaction, with the context resolved before it', async () => {
    const { handler, prisma, reconciler, tx, context } = setup();
    await handler.process(job({ transcriptId: TRANSCRIPT, actorUserId: OWNER }));
    expect(reconciler.resolveContext).toHaveBeenCalledWith(OWNER);
    expect(reconciler.resolveContext.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$transaction.mock.invocationCallOrder[0],
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcile).toHaveBeenCalledWith(tx, { transcriptId: TRANSCRIPT, actorUserId: OWNER }, context);
  });

  // #612: on a one-connection pool (PGlite: KVox Desktop, the bare host's pglite leg) the
  // transaction holds the only connection, so any read through the root client, the ontology,
  // KVOX_SETTINGS or KVOX_IDENTITY inside its callback waits forever. Simulated: those throw
  // while the transaction is open, and the job, with the real reconciler, still completes.
  it('completes on a one-connection pool: nothing inside the transaction but tx (#612)', async () => {
    let inside = false;
    const outsideOnly = <T>(what: string, value: T) => {
      if (inside) throw new Error(`${what} called inside the transaction: it would wait for the only connection`);
      return value;
    };
    const SPEAKER = 'spk-a';
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      transcript: {
        findUnique: jest.fn().mockResolvedValue({
          ownerId: OWNER,
          speakerIdentities: { [SPEAKER]: 'Sarah Chen' },
          deletedAt: null,
        }),
      },
      transcriptSpeaker: {
        findMany: jest.fn().mockResolvedValue([{ id: SPEAKER, label: SPEAKER, displayName: `Speaker ${SPEAKER}` }]),
      },
      transcriptSegment: {
        findMany: jest.fn().mockResolvedValue([{ id: 'seg-1', rev: 1, startMs: 0, endMs: 900, text: 'hello' }]),
      },
      kgRelation: { findMany: jest.fn().mockResolvedValue([]) },
      kgEntity: { findMany: jest.fn().mockResolvedValue([]) },
    };
    // The root client: every model method throws while the transaction is open.
    const rootModel = () =>
      new Proxy({} as Record<string, jest.Mock>, {
        get: (_t, method) => jest.fn(async () => outsideOnly(`prisma.${String(method)}`, [])),
      });
    const prisma = {
      kgAttributeDef: rootModel(),
      transcript: rootModel(),
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
        inside = true;
        try {
          return await fn(tx);
        } finally {
          inside = false;
        }
      }),
    };
    const schema = { marker: 'schema' };
    const ontology = {
      // The real one reads kg_attribute_defs through the root client and KVOX_SETTINGS.
      effectiveSchemaFor: jest.fn(async () => {
        await prisma.kgAttributeDef.findMany();
        return outsideOnly('ontology.effectiveSchemaFor', schema);
      }),
    };
    const identity = { hasPermission: jest.fn(async () => outsideOnly('identity.hasPermission', true)) };
    const write = {
      createEntity: jest.fn().mockResolvedValue({ id: 'p-new' }),
      createRelation: jest.fn().mockResolvedValue({ id: 'e-new' }),
      addAliases: jest.fn().mockResolvedValue([]),
    };
    const reconciler = new SpeakerLinkReconciler(write as never, ontology as never, identity as never);
    const jobs = jobsMock([KG_EMBED_JOB_TYPE]);
    const audit = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };
    const handler = new KgSpeakerLinkHandler(jobs as never, prisma as never, reconciler, auditPortOver(audit));

    await expect(handler.process(job({ transcriptId: TRANSCRIPT, actorUserId: OWNER }))).resolves.toBeUndefined();

    expect(identity.hasPermission).toHaveBeenCalledWith(OWNER, 'graph:write');
    expect(write.createEntity).toHaveBeenCalledWith(tx, expect.objectContaining({ ownerId: OWNER }), schema);
    expect(write.createRelation).toHaveBeenCalledWith(tx, expect.objectContaining({ ownerId: OWNER }), schema);
    expect(audit.auditEvent.create).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: KG_EMBED_JOB_TYPE }));
  });

  it.each([[null], [{}], [{ transcriptId: 'not-a-uuid', actorUserId: OWNER }], [{ transcriptId: TRANSCRIPT }]])(
    'returns without throwing on an unreadable payload (%p)',
    async (payload) => {
      const { handler, prisma } = setup();
      await expect(handler.process(job(payload))).resolves.toBeUndefined();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(readSpeakerLinkPayload(payload)).toBeNull();
    },
  );

  it('enqueues kg.embed for created Persons only while its handler is registered', async () => {
    const off = setup();
    await off.handler.process(job({ transcriptId: TRANSCRIPT, actorUserId: OWNER }));
    expect(off.jobs.enqueue).not.toHaveBeenCalled();

    const on = setup({}, true);
    await on.handler.process(job({ transcriptId: TRANSCRIPT, actorUserId: OWNER }));
    expect(on.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: KG_EMBED_JOB_TYPE,
        skipDedup: true,
        payload: { userId: OWNER, subjectKind: 'entity', ids: ['p-1'] },
      }),
    );
  });

  it('enqueues nothing after a skipped run, or one that created no Person', async () => {
    const skipped = setup({ skipped: 'not_owner', createdPersonIds: [] }, true);
    await skipped.handler.process(job({ transcriptId: TRANSCRIPT, actorUserId: OWNER }));
    expect(skipped.jobs.enqueue).not.toHaveBeenCalled();

    const none = setup({ created: 0, createdPersonIds: [] }, true);
    await none.handler.process(job({ transcriptId: TRANSCRIPT, actorUserId: OWNER }));
    expect(none.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('never fails the job over a failed embed enqueue — the link has committed', async () => {
    const s = setup({}, true);
    s.jobs.enqueue.mockRejectedValue(new Error('queue down'));
    await expect(s.handler.process(job({ transcriptId: TRANSCRIPT, actorUserId: OWNER }))).resolves.toBeUndefined();
  });
});
