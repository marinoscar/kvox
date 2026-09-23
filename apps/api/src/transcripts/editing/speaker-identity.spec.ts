// =============================================================================
// Speaker identification helpers (issue #323)
// =============================================================================
//
// Pure functions, table-driven, in the style of `reducers.spec.ts` and
// `snapshot-policy.spec.ts` — no database, no clock, and every case states the
// spec's own expected outcome (`identification` / `noop` / `versioned`) rather
// than merely "it did something".
// =============================================================================

import { segment, speaker, state } from './__fixtures__/state';
import {
  applyIdentities,
  classifyRename,
  defaultSpeakerName,
  identitiesFingerprint,
  isIdentificationBatch,
  isUnidentified,
  parseSpeakerIdentities,
} from './speaker-identity';
import { OP_TYPES, type RecordedOp } from './ops';

const rename = (speakerId: string, displayName: string, rev = 1) =>
  ({ op: OP_TYPES.RENAME_SPEAKER, speakerId, rev, displayName }) as RecordedOp;

describe('defaultSpeakerName', () => {
  it('is "Speaker <label>", the one spelling ingest and this file share', () => {
    expect(defaultSpeakerName('A')).toBe('Speaker A');
    expect(defaultSpeakerName('C')).toBe('Speaker C');
  });
});

describe('isUnidentified', () => {
  it('is true for a provider-labelled speaker still on its placeholder', () => {
    expect(isUnidentified({ label: 'A', displayName: 'Speaker A' })).toBe(true);
  });

  it('is false once the display name differs from the placeholder', () => {
    expect(isUnidentified({ label: 'A', displayName: 'Oscar' })).toBe(false);
  });

  it('is NEVER true for a speaker a person created (label: null), whatever the name', () => {
    expect(isUnidentified({ label: null, displayName: 'Oscar' })).toBe(false);
    // Even a name that happens to read like a placeholder for some other
    // label: there is no placeholder to replace when there was no label.
    expect(isUnidentified({ label: null, displayName: 'Speaker A' })).toBe(false);
  });
});

describe('classifyRename', () => {
  it('is an identification: unidentified speaker, a real new name', () => {
    expect(
      classifyRename({ label: 'A', displayName: 'Speaker A' }, { displayName: 'Oscar' }),
    ).toBe('identification');
  });

  it('is a noop: the trimmed new name is the name the speaker already has', () => {
    expect(
      classifyRename({ label: 'A', displayName: 'Oscar' }, { displayName: 'Oscar' }),
    ).toBe('noop');
  });

  it('is a noop even across whitespace — the comparison trims first', () => {
    expect(
      classifyRename({ label: 'A', displayName: 'Oscar' }, { displayName: '  Oscar  ' }),
    ).toBe('noop');
  });

  it('is versioned: correcting an already-identified speaker (Oscar -> Joe)', () => {
    expect(
      classifyRename({ label: 'A', displayName: 'Oscar' }, { displayName: 'Joe' }),
    ).toBe('versioned');
  });

  it('is versioned: putting an identified speaker back on its placeholder', () => {
    expect(
      classifyRename({ label: 'A', displayName: 'Oscar' }, { displayName: 'Speaker A' }),
    ).toBe('versioned');
  });

  it('is versioned for an empty (post-trim) name', () => {
    expect(
      classifyRename({ label: 'A', displayName: 'Speaker A' }, { displayName: '' }),
    ).toBe('versioned');
    expect(
      classifyRename({ label: 'A', displayName: 'Speaker A' }, { displayName: '   ' }),
    ).toBe('versioned');
  });

  it('is versioned for a speaker not in the state at all — the versioned path owns that 409', () => {
    expect(classifyRename(undefined, { displayName: 'Oscar' })).toBe('versioned');
  });
});

describe('isIdentificationBatch', () => {
  const A = speaker('A', 'Speaker A');
  const B = speaker('B', 'Speaker B', { colorIndex: 1 });
  const twoSpeakers = state([A, B], [segment('s1', 'A', 'hello there')]);

  it('is false for an empty batch', () => {
    expect(isIdentificationBatch(twoSpeakers, [])).toBe(false);
  });

  it('is false the moment any op is not a speaker.rename', () => {
    expect(
      isIdentificationBatch(twoSpeakers, [
        { op: OP_TYPES.UPDATE_TEXT, segmentId: 's1', rev: 1, text: 'x' } as RecordedOp,
      ]),
    ).toBe(false);
  });

  it('is false for [A -> Oscar, A -> Joe]: the second op corrects the first\'s own identification', () => {
    // Classified IN BATCH ORDER — the second op sees the name the first one
    // gave, exactly as the reducers would.
    expect(isIdentificationBatch(twoSpeakers, [rename('A', 'Oscar'), rename('A', 'Joe')])).toBe(
      false,
    );
  });

  it('is true when every op is an identification or a no-op', () => {
    expect(
      isIdentificationBatch(twoSpeakers, [rename('A', 'Oscar'), rename('B', 'Dana')]),
    ).toBe(true);
  });

  it('is true for an all-noop batch, which is what makes an idempotent retry route the same way', () => {
    const identified = state(
      [speaker('A', 'Oscar'), B],
      [segment('s1', 'A', 'hello there')],
    );

    expect(isIdentificationBatch(identified, [rename('A', 'Oscar')])).toBe(true);
  });
});

describe('applyIdentities', () => {
  const A = speaker('A', 'Speaker A');
  const B = speaker('B', 'Bob'); // already identified by a versioned rename
  const withTwoSpeakers = state([A, B], [segment('s1', 'A', 'hi')]);

  it('overlays only a speaker STILL carrying its placeholder', () => {
    const result = applyIdentities(withTwoSpeakers, { A: 'Oscar', B: 'Should not appear' });

    expect(result.speakers.find((s) => s.id === 'A')?.displayName).toBe('Oscar');
    // B was already identified by a versioned op — that correction outranks
    // the entry beside it.
    expect(result.speakers.find((s) => s.id === 'B')?.displayName).toBe('Bob');
  });

  it('never touches rev — the identification write does not either', () => {
    const result = applyIdentities(withTwoSpeakers, { A: 'Oscar' });

    expect(result.speakers.find((s) => s.id === 'A')?.rev).toBe(A.rev);
  });

  it('is idempotent: a second pass over its own output changes nothing further', () => {
    const once = applyIdentities(withTwoSpeakers, { A: 'Oscar' });
    const twice = applyIdentities(once, { A: 'Oscar' });

    expect(twice).toEqual(once);
  });

  it('ignores an entry for a speaker not present in the state', () => {
    const result = applyIdentities(withTwoSpeakers, { 'not-a-real-id': 'Ghost' });

    expect(result.speakers.map((s) => s.displayName)).toEqual(['Speaker A', 'Bob']);
  });

  it('returns the SAME state, by reference, for an empty map', () => {
    expect(applyIdentities(withTwoSpeakers, {})).toBe(withTwoSpeakers);
  });
});

describe('parseSpeakerIdentities', () => {
  it('is total over non-object input', () => {
    expect(parseSpeakerIdentities(null)).toEqual({});
    expect(parseSpeakerIdentities(undefined)).toEqual({});
    expect(parseSpeakerIdentities('Oscar')).toEqual({});
    expect(parseSpeakerIdentities(42)).toEqual({});
    expect(parseSpeakerIdentities(['Oscar'])).toEqual({});
  });

  it('drops a non-string value', () => {
    expect(parseSpeakerIdentities({ A: 42, B: null, C: { nested: true } })).toEqual({});
  });

  it('drops an empty or whitespace-only string', () => {
    expect(parseSpeakerIdentities({ A: '', B: '   ' })).toEqual({});
  });

  it('keeps a well-formed entry, untrimmed', () => {
    expect(parseSpeakerIdentities({ A: 'Oscar', B: ' Dana ' })).toEqual({
      A: 'Oscar',
      B: ' Dana ',
    });
  });
});

describe('identitiesFingerprint', () => {
  it('is null for an empty map — what keeps every pre-#323 hash byte for byte', () => {
    expect(identitiesFingerprint({})).toBeNull();
  });

  it('is a 12-hex-digit string once the map is non-empty', () => {
    expect(identitiesFingerprint({ A: 'Oscar' })).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is stable regardless of key insertion order', () => {
    expect(identitiesFingerprint({ A: 'Oscar', B: 'Dana' })).toBe(
      identitiesFingerprint({ B: 'Dana', A: 'Oscar' }),
    );
  });

  it('changes when a name changes', () => {
    expect(identitiesFingerprint({ A: 'Oscar' })).not.toBe(identitiesFingerprint({ A: 'Joe' }));
  });

  it('changes when the set of identified speakers changes', () => {
    expect(identitiesFingerprint({ A: 'Oscar' })).not.toBe(
      identitiesFingerprint({ A: 'Oscar', B: 'Dana' }),
    );
  });
});
