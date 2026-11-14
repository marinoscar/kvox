// =============================================================================
// VoiceprintReadyListener (#825): `transcript.ready` -> `kg.voice_match`, enqueue only, and only
// when the owner opted in, the port is bound, the owner has a voiceprint and the type is
// registered. A failure is contained.
// =============================================================================

import { Logger } from '@nestjs/common';

import { TRANSCRIPT_READY_BUS_EVENT, TranscriptReadyBusEvent } from '../../transcripts/index.js';
import { jobsMock } from '../__fixtures__/jobs-mock.js';
import { KG_SUBJECT_TRANSCRIPT, KG_VOICE_MATCH_JOB_TYPE } from '../job-types.js';
import { VoiceprintReadyListener } from './voiceprint-ready.listener.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TRANSCRIPT = '22222222-2222-4222-8222-222222222221';

interface Options {
  registered?: boolean;
  enabled?: boolean;
  dimensions?: number;
  hasVoiceprint?: boolean;
}

function setup(opts: Options = {}) {
  const jobs = jobsMock(opts.registered === false ? [] : [KG_VOICE_MATCH_JOB_TYPE]);
  const subscribers = new Map<string, (payload: unknown) => unknown>();
  const events = { emit: jest.fn(), subscribe: jest.fn((name: string, fn: (payload: unknown) => unknown) => void subscribers.set(name, fn)) };
  const prisma = { $queryRaw: jest.fn().mockResolvedValue(opts.hasVoiceprint === false ? [] : [{ ok: 1 }]) };
  const voiceprints = { dimensions: opts.dimensions ?? 512, modelId: 'model-x' };
  const preferences = { voiceprintsEnabled: jest.fn().mockResolvedValue(opts.enabled ?? true) };
  const listener = new VoiceprintReadyListener(jobs as never, events as never, prisma as never, voiceprints as never, preferences as never);
  return { listener, jobs, events, subscribers, prisma, preferences };
}

const ready = new TranscriptReadyBusEvent(TRANSCRIPT, OWNER);

describe('VoiceprintReadyListener', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('subscribes to transcript.ready on module init, and the subscription enqueues', async () => {
    const { listener, events, subscribers, jobs } = setup();
    listener.onModuleInit();
    expect(events.subscribe).toHaveBeenCalledWith(TRANSCRIPT_READY_BUS_EVENT, expect.any(Function));
    await subscribers.get(TRANSCRIPT_READY_BUS_EVENT)!(ready);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it('enqueues one kg.voice_match for the transcript, ids only', async () => {
    const { listener, jobs } = setup();
    await listener.handleReady(ready);
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: KG_VOICE_MATCH_JOB_TYPE,
      reason: 'rerun',
      subjectType: KG_SUBJECT_TRANSCRIPT,
      subjectId: TRANSCRIPT,
      payload: { transcriptId: TRANSCRIPT },
    });
  });

  it('asks the database about the owner and the port model, not about audio', async () => {
    const { listener, prisma } = setup();
    await listener.handleReady(ready);
    const call = prisma.$queryRaw.mock.calls[0]!;
    expect((call[0] as string[]).join('?')).toContain('FROM kg_person_voiceprints');
    expect(call.slice(1)).toEqual([OWNER, 'model-x']);
  });

  it.each([
    ['the owner has not opted in', { enabled: false }],
    ['the port is the unbound default (0 dimensions)', { dimensions: 0 }],
    ['the type is not registered', { registered: false }],
    ['the owner has no voiceprints yet', { hasVoiceprint: false }],
  ] as Array<[string, Options]>)('enqueues nothing when %s', async (_name, opts) => {
    const { listener, jobs } = setup(opts);
    await listener.handleReady(ready);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('does not even read the preference when the type is not registered', async () => {
    const { listener, preferences } = setup({ registered: false });
    await listener.handleReady(ready);
    expect(preferences.voiceprintsEnabled).not.toHaveBeenCalled();
  });

  it('contains an enqueue failure: logged with ids, never thrown', async () => {
    const { listener, jobs } = setup();
    jobs.enqueue.mockRejectedValue(new Error('queue down'));
    await expect(listener.handleReady(ready)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(TRANSCRIPT));
  });

  it('contains a preference or database failure', async () => {
    const a = setup();
    a.preferences.voiceprintsEnabled.mockRejectedValue(new Error('settings down'));
    await expect(a.listener.handleReady(ready)).resolves.toBeUndefined();
    expect(a.jobs.enqueue).not.toHaveBeenCalled();

    const b = setup();
    b.prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(b.listener.handleReady(ready)).resolves.toBeUndefined();
    expect(b.jobs.enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
