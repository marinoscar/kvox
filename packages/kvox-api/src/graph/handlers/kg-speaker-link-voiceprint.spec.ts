// =============================================================================
// kg.speaker_link -> kg.voiceprint_enroll (#825): the post-commit follow-up for `summary.links`.
// Enqueued only when the owner opted in, the port is bound (dimensions != 0) and the type is
// registered; contained like the embed follow-up.
// =============================================================================

import { Logger } from '@nestjs/common';

import { auditPortOver } from '../__fixtures__/audit-port.js';
import { jobsMock } from '../__fixtures__/jobs-mock.js';
import type { KvoxJob } from '../../ports/index.js';
import { KG_EMBED_JOB_TYPE, KG_SPEAKER_LINK_JOB_TYPE, KG_SUBJECT_TRANSCRIPT, KG_VOICEPRINT_ENROLL_JOB_TYPE } from '../job-types.js';
import { KgSpeakerLinkHandler } from './kg-speaker-link.handler.js';

const TRANSCRIPT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const link = (n: number) => ({ speakerId: `33333333-3333-4333-8333-3333333333${String(n).padStart(2, '0')}`, entityId: `44444444-4444-4444-8444-4444444444${String(n).padStart(2, '0')}` });

interface Options {
  registered?: boolean;
  enabled?: boolean;
  dimensions?: number;
  summary?: Record<string, unknown>;
  withPreferences?: boolean;
  withPort?: boolean;
}

function setup(opts: Options = {}) {
  const jobs = jobsMock(opts.registered === false ? [] : [KG_VOICEPRINT_ENROLL_JOB_TYPE]);
  const prisma = { $transaction: jest.fn().mockImplementation(async (fn: (t: unknown) => unknown) => fn({})) };
  const reconciler = {
    resolveContext: jest.fn().mockResolvedValue({}),
    reconcile: jest.fn().mockResolvedValue({
      skipped: null,
      ownerId: OWNER,
      linked: 1,
      created: 0,
      unlinked: 0,
      createdPersonIds: [],
      links: [link(1)],
      audit: [],
      ...opts.summary,
    }),
  };
  const preferences = { voiceprintsEnabled: jest.fn().mockResolvedValue(opts.enabled ?? true) };
  const voiceprints = { dimensions: opts.dimensions ?? 512 };
  const handler = new KgSpeakerLinkHandler(
    jobs as never,
    prisma as never,
    reconciler as never,
    auditPortOver({ auditEvent: { create: jest.fn().mockResolvedValue({}) } }),
    opts.withPreferences === false ? undefined : (preferences as never),
    opts.withPort === false ? undefined : (voiceprints as never),
  );
  return { handler, jobs, preferences };
}

const run = (handler: KgSpeakerLinkHandler) =>
  handler.process({ id: 'j-1', type: KG_SPEAKER_LINK_JOB_TYPE, payload: { transcriptId: TRANSCRIPT, actorUserId: OWNER } } as KvoxJob);

describe('KgSpeakerLinkHandler voiceprint follow-up (#825)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('enqueues kg.voiceprint_enroll with the linked pairs, after the transaction', async () => {
    const { handler, jobs } = setup({ summary: { links: [link(1), link(2)] } });
    await run(handler);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: KG_VOICEPRINT_ENROLL_JOB_TYPE,
      reason: 'rerun',
      subjectType: KG_SUBJECT_TRANSCRIPT,
      subjectId: TRANSCRIPT,
      skipDedup: true,
      payload: { transcriptId: TRANSCRIPT, links: [link(1), link(2)] },
    });
  });

  it('caps the payload at the 50 links the enrol job accepts', async () => {
    const many = Array.from({ length: 60 }, (_v, i) => link(i));
    const { handler, jobs } = setup({ summary: { links: many } });
    await run(handler);
    expect(jobs.enqueue.mock.calls[0]![0]).toMatchObject({ payload: { links: many.slice(0, 50) } });
  });

  it.each([
    ['the owner has not opted in', { enabled: false }],
    ['the port is the unbound default', { dimensions: 0 }],
    ['the type is not registered', { registered: false }],
    ['no preferences service is bound', { withPreferences: false }],
    ['no voiceprint port is bound', { withPort: false }],
    ['the run linked nothing', { summary: { links: [] } }],
    ['the run reports no links field (an older reconciler)', { summary: { links: undefined } }],
    ['the run was skipped', { summary: { skipped: 'not_owner' } }],
  ] as Array<[string, Options]>)('enqueues nothing when %s', async (_name, opts) => {
    const { handler, jobs } = setup(opts);
    await run(handler);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('checks the opt-in for the transcript owner, not the actor', async () => {
    const { handler, preferences } = setup();
    await run(handler);
    expect(preferences.voiceprintsEnabled).toHaveBeenCalledWith(OWNER);
  });

  it('is contained: a failed enqueue or preference read never fails the job', async () => {
    const a = setup();
    a.jobs.enqueue.mockRejectedValue(new Error('queue down'));
    await expect(run(a.handler)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(KG_VOICEPRINT_ENROLL_JOB_TYPE));

    const b = setup();
    b.preferences.voiceprintsEnabled.mockRejectedValue(new Error('settings down'));
    await expect(run(b.handler)).resolves.toBeUndefined();
    expect(b.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('a failed enrol enqueue does not stop the embed follow-up that ran before it, and vice versa', async () => {
    const jobs = jobsMock([KG_EMBED_JOB_TYPE, KG_VOICEPRINT_ENROLL_JOB_TYPE]);
    jobs.enqueue.mockImplementation(async (input?: unknown) => {
      if ((input as { type: string }).type === KG_EMBED_JOB_TYPE) throw new Error('embed down');
      return { id: 'j', deduplicated: false };
    });
    const handler = new KgSpeakerLinkHandler(
      jobs as never,
      { $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn({})) } as never,
      {
        resolveContext: jest.fn().mockResolvedValue({}),
        reconcile: jest.fn().mockResolvedValue({
          skipped: null, ownerId: OWNER, linked: 1, created: 1, unlinked: 0, createdPersonIds: ['p-1'], links: [link(1)], audit: [],
        }),
      } as never,
      auditPortOver({ auditEvent: { create: jest.fn() } }),
      { voiceprintsEnabled: jest.fn().mockResolvedValue(true) } as never,
      { dimensions: 512 } as never,
    );
    await run(handler);
    const types = jobs.enqueue.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toEqual([KG_EMBED_JOB_TYPE, KG_VOICEPRINT_ENROLL_JOB_TYPE]);
  });
});
