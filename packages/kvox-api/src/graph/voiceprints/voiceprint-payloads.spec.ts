import { NOOP_KVOX_VOICEPRINTS } from '../../ports/index.js';
import { readVoiceMatchPayload } from './handlers/kg-voice-match.handler.js';
import { readVoiceprintEnrollPayload } from './handlers/kg-voiceprint-enroll.handler.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('voiceprint job payloads (#825)', () => {
  it('reads a valid enroll payload and refuses an empty or malformed one', () => {
    expect(readVoiceprintEnrollPayload({ transcriptId: ID, links: [{ speakerId: ID, entityId: ID }] })).not.toBeNull();
    expect(readVoiceprintEnrollPayload({ transcriptId: ID, links: [] })).toBeNull();
    expect(readVoiceprintEnrollPayload({ transcriptId: 'x', links: [{ speakerId: ID, entityId: ID }] })).toBeNull();
  });

  it('reads a match payload', () => {
    expect(readVoiceMatchPayload({ transcriptId: ID })).toEqual({ transcriptId: ID });
    expect(readVoiceMatchPayload({})).toBeNull();
  });

  it('the default port is unavailable and decides nothing', async () => {
    expect(await NOOP_KVOX_VOICEPRINTS.available()).toBe(false);
    expect(NOOP_KVOX_VOICEPRINTS.decide([{ entityId: ID, score: 0.99 }])).toBeNull();
    expect(NOOP_KVOX_VOICEPRINTS.selectWindows([{ startMs: 0, endMs: 9000 }])).toEqual({ windows: [], speechMs: 0 });
  });
});
