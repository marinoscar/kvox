import { ORDINAL_GAP } from '../editing';
import {
  buildExportDocument,
  formatDuration,
  formatTimestamp,
  speakerIndex,
} from './export-document';
import { fixtureDocument, fixtureSegment, fixtureSpeaker } from './__fixtures__/document';

// =============================================================================
// `ExportDocument` (issue #28, epic #19, spec §8.1)
// =============================================================================
//
// The builder is the one place talk time is computed and the one place reading
// order is fixed, so these are the assertions that stop the three renderers
// from being able to disagree about what the transcript says.
// =============================================================================

describe('buildExportDocument', () => {
  it('computes talk time per speaker and a share of the SPEECH, not of the recording', () => {
    const doc = fixtureDocument();

    // spk_a: 4s + 4s = 8s. spk_b: 12s + 4s = 16s. Total speech 24s.
    const [a, b] = doc.speakers;

    expect(a.talkTimeMs).toBe(8_000);
    expect(b.talkTimeMs).toBe(16_000);
    expect(a.talkTimePercent).toBeCloseTo(33.3, 1);
    expect(b.talkTimePercent).toBeCloseTo(66.7, 1);
    expect(a.talkTimePercent + b.talkTimePercent).toBeCloseTo(100, 0);
  });

  it('divides by total speech, so silence does not deflate the percentages', () => {
    // A ten-minute recording with twenty seconds of speech in it. Dividing by
    // `durationMs` would report 1.7% and 1.7%; the share of the conversation is
    // 50/50 and that is what a participants block is asking about.
    const doc = buildExportDocument({
      transcriptId: 't',
      title: 'Mostly silence',
      language: null,
      durationMs: 600_000,
      version: 1,
      createdAt: new Date(0),
      exportedAt: new Date(0),
      author: null,
      provider: null,
      state: {
        speakers: [fixtureSpeaker('a', 'A', 0), fixtureSpeaker('b', 'B', 1)],
        segments: [
          fixtureSegment('s1', 'a', 'one', 0, 10_000, ORDINAL_GAP),
          fixtureSegment('s2', 'b', 'two', 500_000, 510_000, ORDINAL_GAP * 2),
        ],
      },
    });

    expect(doc.durationMs).toBe(600_000);
    expect(doc.speakers.map((speaker) => speaker.talkTimePercent)).toEqual([50, 50]);
  });

  it('falls back to the last segment end when the transcript has no duration', () => {
    const doc = buildExportDocument({
      transcriptId: 't',
      title: 'No duration yet',
      language: null,
      durationMs: null,
      version: 1,
      createdAt: new Date(0),
      exportedAt: new Date(0),
      author: null,
      provider: null,
      state: {
        speakers: [fixtureSpeaker('a', 'A', 0)],
        segments: [fixtureSegment('s1', 'a', 'hello there', 0, 7_500, ORDINAL_GAP)],
      },
    });

    // Never null: the published JSON schema makes `durationMs` required.
    expect(doc.durationMs).toBe(7_500);
  });

  it('gives a speaker who never spoke a zero share rather than NaN', () => {
    const doc = buildExportDocument({
      transcriptId: 't',
      title: 'Nobody spoke',
      language: null,
      durationMs: 0,
      version: 1,
      createdAt: new Date(0),
      exportedAt: new Date(0),
      author: null,
      provider: null,
      state: { speakers: [fixtureSpeaker('a', 'A', 0)], segments: [] },
    });

    expect(doc.speakers[0].talkTimePercent).toBe(0);
    expect(doc.speakers[0].talkTimeMs).toBe(0);
  });

  it('orders segments in reading order and speakers by colour index', () => {
    const doc = buildExportDocument({
      transcriptId: 't',
      title: 'Out of order',
      language: null,
      durationMs: null,
      version: 1,
      createdAt: new Date(0),
      exportedAt: new Date(0),
      author: null,
      provider: null,
      state: {
        speakers: [fixtureSpeaker('b', 'B', 1), fixtureSpeaker('a', 'A', 0)],
        segments: [
          fixtureSegment('late', 'a', 'later', 9_000, 10_000, ORDINAL_GAP * 2),
          fixtureSegment('early', 'b', 'earlier', 1_000, 2_000, ORDINAL_GAP),
        ],
      },
    });

    expect(doc.segments.map((segment) => segment.id)).toEqual(['early', 'late']);
    expect(doc.speakers.map((speaker) => speaker.id)).toEqual(['a', 'b']);
  });

  it('renames the terse word keys to the published long ones', () => {
    const doc = fixtureDocument();

    expect(doc.segments[0].words[0]).toEqual({
      text: "Let's",
      startMs: expect.any(Number),
      endMs: expect.any(Number),
      confidence: 0.94,
    });
  });

  it('indexes speakers by id', () => {
    const doc = fixtureDocument();

    expect(speakerIndex(doc).get('spk_a')?.displayName).toBe('José Núñez');
  });
});

describe('formatTimestamp', () => {
  it.each([
    [0, '00:00:00'],
    [83_000, '00:01:23'],
    [3_723_000, '01:02:03'],
    [-5, '00:00:00'],
  ])('renders %d ms as %s', (ms, expected) => {
    expect(formatTimestamp(ms)).toBe(expected);
  });

  it('keeps all three fields for a short clip, so two exports stay comparable', () => {
    expect(formatTimestamp(30_000)).toBe('00:00:30');
  });
});

describe('formatDuration', () => {
  it.each([
    [12_000, '12s'],
    [252_000, '4m 12s'],
    [3_852_000, '1h 04m 12s'],
  ])('renders %d ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
