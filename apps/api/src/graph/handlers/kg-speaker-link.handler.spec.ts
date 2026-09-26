// =============================================================================
// KgSpeakerLinkHandler (#356): the profile, server-only registration, and the
// thin delegation to SpeakerLinkReconciler.
// =============================================================================

import type { Job } from '@prisma/client';

import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { KG_EMBED_JOB_TYPE, KG_SPEAKER_LINK_JOB_TYPE } from '../job-types';
import { KgSpeakerLinkHandler, readSpeakerLinkPayload } from './kg-speaker-link.handler';

const TRANSCRIPT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

function job(payload: unknown): Job {
  return { id: 'job-1', type: KG_SPEAKER_LINK_JOB_TYPE, payload } as Job;
}

function setup(summary: Record<string, unknown> = {}, embedRegistered = false) {
  const registry = new JobHandlerRegistry();
  if (embedRegistered) registry.register({ type: KG_EMBED_JOB_TYPE, process: jest.fn() });
  const tx = { marker: 'tx' };
  const prisma = { $transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx)) };
  const reconciler = {
    reconcile: jest.fn().mockResolvedValue({
      skipped: null,
      ownerId: OWNER,
      linked: 1,
      created: 1,
      unlinked: 0,
      createdPersonIds: ['p-1'],
      ...summary,
    }),
  };
  const jobs = { enqueue: jest.fn().mockResolvedValue({}) };
  const handler = new KgSpeakerLinkHandler(registry, prisma as never, reconciler as never, jobs as never);
  handler.onModuleInit();
  return { registry, handler, prisma, reconciler, jobs, tx };
}

describe('KgSpeakerLinkHandler', () => {
  it('declares { maxRuntimeMs: 120000, maxAttempts: 3 }', () => {
    expect(setup().handler.profile).toEqual({ maxRuntimeMs: 120_000, maxAttempts: 3 });
  });

  it('self-registers as a server-only type (no nodeResultSchema/persistNodeResult)', () => {
    const { registry, handler } = setup();
    expect(registry.get(KG_SPEAKER_LINK_JOB_TYPE)).toBe(handler);
    const asHandler: JobHandler = handler;
    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
    expect(registry.serverOnlyTypes()).toContain(KG_SPEAKER_LINK_JOB_TYPE);
  });

  it('delegates to the reconciler on one transaction', async () => {
    const { handler, prisma, reconciler, tx } = setup();
    await handler.process(job({ transcriptId: TRANSCRIPT, actorUserId: OWNER }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcile).toHaveBeenCalledWith(tx, { transcriptId: TRANSCRIPT, actorUserId: OWNER });
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
