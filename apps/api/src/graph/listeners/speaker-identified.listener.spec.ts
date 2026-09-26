// =============================================================================
// SpeakerIdentifiedListener (#356): it only enqueues, with skipDedup, and an
// enqueue failure never escapes.
// =============================================================================

import { Logger } from '@nestjs/common';

import { TranscriptSpeakersIdentifiedEvent } from '../../transcripts/events/transcript-speakers-identified.event';
import { KG_SPEAKER_LINK_JOB_TYPE, KG_SUBJECT_TRANSCRIPT } from '../job-types';
import { SpeakerIdentifiedListener } from './speaker-identified.listener';

describe('SpeakerIdentifiedListener', () => {
  const event = new TranscriptSpeakersIdentifiedEvent('t-1', 'u-1', ['spk-a', 'spk-b']);

  it('enqueues kg.speaker_link with skipDedup and exactly the payload the handler reads', async () => {
    const jobs = { enqueue: jest.fn().mockResolvedValue({}) };
    await new SpeakerIdentifiedListener(jobs as never).handleSpeakersIdentified(event);

    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: KG_SPEAKER_LINK_JOB_TYPE,
      reason: 'rerun',
      subjectType: KG_SUBJECT_TRANSCRIPT,
      subjectId: 't-1',
      payload: { transcriptId: 't-1', actorUserId: 'u-1' },
      skipDedup: true,
    });
  });

  it('swallows and logs an enqueue failure', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const jobs = { enqueue: jest.fn().mockRejectedValue(new Error('queue down')) };

    await expect(
      new SpeakerIdentifiedListener(jobs as never).handleSpeakersIdentified(event),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('t-1'));

    warn.mockRestore();
  });
});
