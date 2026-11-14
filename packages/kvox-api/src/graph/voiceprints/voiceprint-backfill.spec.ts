// =============================================================================
// kg.voiceprint_backfill and its listener (#826): the listener only enqueues, and only on
// an opt-in; the handler only queries and enqueues, grouped per transcript.
// =============================================================================

import { Logger } from '@nestjs/common';

import { KG_SUBJECT_TRANSCRIPT, KG_SUBJECT_USER, KG_VOICEPRINT_BACKFILL_JOB_TYPE, KG_VOICEPRINT_ENROLL_JOB_TYPE } from '../job-types.js';
import { resolveGraphPreferences, changedGraphSections } from '../preferences/graph-preferences.defaults.js';
import { KgVoiceprintBackfillHandler } from './handlers/kg-voiceprint-backfill.handler.js';
import { VoiceprintBackfillListener } from './voiceprint-backfill.listener.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222221';
const T2 = '22222222-2222-4222-8222-222222222222';
const S = (n: number) => `33333333-3333-4333-8333-33333333333${n}`;
const E = (n: number) => `44444444-4444-4444-8444-44444444444${n}`;

function event(before: boolean | undefined, after: boolean | undefined) {
  const previous = resolveGraphPreferences({ voiceprints: before === undefined ? undefined : { enabled: before } });
  const next = resolveGraphPreferences({ voiceprints: after === undefined ? undefined : { enabled: after } });
  return { userId: OWNER, changed: changedGraphSections(previous, next), previous, next };
}

describe('VoiceprintBackfillListener', () => {
  const make = (registered = true) => {
    const jobs = { enqueue: jest.fn().mockResolvedValue({}), isRegistered: jest.fn().mockReturnValue(registered) };
    return { jobs, listener: new VoiceprintBackfillListener(jobs as never, { subscribe: jest.fn() } as never) };
  };

  it('enqueues one backfill when voiceprints go from off to on', async () => {
    const { jobs, listener } = make();
    await listener.handlePreferencesChanged(event(undefined, true));
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: KG_VOICEPRINT_BACKFILL_JOB_TYPE,
      reason: 'rerun',
      subjectType: KG_SUBJECT_USER,
      subjectId: OWNER,
      payload: { ownerId: OWNER },
    });
  });

  it.each([
    ['turning off', true, false],
    ['already on', true, true],
  ])('enqueues nothing when %s', async (_name, before, after) => {
    const { jobs, listener } = make();
    await listener.handlePreferencesChanged(event(before, after));
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it('ignores a change to another section, and an unregistered type', async () => {
    const a = make();
    const previous = resolveGraphPreferences(undefined);
    const next = resolveGraphPreferences({ extraction: { autoExtract: false } });
    await a.listener.handlePreferencesChanged({ userId: OWNER, changed: changedGraphSections(previous, next), previous, next });
    expect(a.jobs.enqueue).not.toHaveBeenCalled();

    const b = make(false);
    await b.listener.handlePreferencesChanged(event(false, true));
    expect(b.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('swallows an enqueue failure', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { jobs, listener } = make();
    jobs.enqueue.mockRejectedValue(new Error('queue down'));
    await expect(listener.handlePreferencesChanged(event(false, true))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('KgVoiceprintBackfillHandler', () => {
  const job = (payload: unknown) => ({ id: 'j-1', payload }) as never;
  const make = (enabled: boolean, rows: unknown[] = []) => {
    const jobs = { enqueue: jest.fn().mockResolvedValue({}), registerHandler: jest.fn() };
    const prisma = { $queryRaw: jest.fn().mockResolvedValue(rows) };
    const preferences = { voiceprintsEnabled: jest.fn().mockResolvedValue(enabled) };
    return { jobs, prisma, handler: new KgVoiceprintBackfillHandler(jobs as never, prisma as never, preferences as never) };
  };

  it('is server-only and declares a label and profile', () => {
    const { handler } = make(true);
    expect(handler.type).toBe(KG_VOICEPRINT_BACKFILL_JOB_TYPE);
    expect(handler.label).toBe('Learn voices from named speakers');
    expect(handler.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 3 });
    expect('nodeResultSchema' in handler).toBe(false);
    expect('persistNodeResult' in handler).toBe(false);
  });

  it('groups links per transcript into one enrol job each', async () => {
    const { handler, jobs } = make(true, [
      { transcript_id: T1, speaker_id: S(1), entity_id: E(1) },
      { transcript_id: T1, speaker_id: S(2), entity_id: E(2) },
      { transcript_id: T2, speaker_id: S(3), entity_id: E(1) },
    ]);
    await handler.process(job({ ownerId: OWNER }));
    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: KG_VOICEPRINT_ENROLL_JOB_TYPE,
      reason: 'rerun',
      subjectType: KG_SUBJECT_TRANSCRIPT,
      subjectId: T1,
      payload: { transcriptId: T1, links: [{ speakerId: S(1), entityId: E(1) }, { speakerId: S(2), entityId: E(2) }] },
      skipDedup: true,
    });
  });

  it('does nothing when the user opted out, or the payload is unreadable', async () => {
    const off = make(false, [{ transcript_id: T1, speaker_id: S(1), entity_id: E(1) }]);
    await off.handler.process(job({ ownerId: OWNER }));
    expect(off.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(off.jobs.enqueue).not.toHaveBeenCalled();

    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const bad = make(true);
    await bad.handler.process(job({ ownerId: 'nope' }));
    expect(bad.jobs.enqueue).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
