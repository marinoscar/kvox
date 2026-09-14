// =============================================================================
// The five note job types, and the per-user throttle key (issue #49, epic #45)
// =============================================================================
//
// These strings are PERMANENT: `Job.type` is a plain text column, so renaming
// one costs a data migration over every row already queued, running or in the
// history under the old name. Pinning them in a test is how a rename becomes a
// deliberate act rather than a refactor's side effect.
//
// All five are also asserted to have a LABEL even though four of them have no
// handler yet — a label is a display string, not a registration, and the point
// of adding them together is that the admin job list never shows an operator a
// raw dotted key the day one of those issues lands.
// =============================================================================

import { jobTypeLabel } from '../jobs/job-type-labels';
import {
  NOTES_HOUSEKEEPING_JOB_TYPE,
  NOTES_MANAGED_BY,
  NOTE_EXPORT_JOB_TYPE,
  NOTE_GENERATE_JOB_TYPE,
  NOTE_PURGE_JOB_TYPE,
  NOTE_SOURCE_EXTRACT_JOB_TYPE,
  NOTE_SUBJECT_TYPE,
  aiProviderThrottleKey,
} from './job-types';

const ALL_FIVE = [
  NOTE_GENERATE_JOB_TYPE,
  NOTE_SOURCE_EXTRACT_JOB_TYPE,
  NOTE_EXPORT_JOB_TYPE,
  NOTE_PURGE_JOB_TYPE,
  NOTES_HOUSEKEEPING_JOB_TYPE,
];

describe('note job type strings', () => {
  it('are exactly the five names issue #49 fixes', () => {
    expect(ALL_FIVE).toEqual([
      'note.generate',
      'note.source.extract',
      'note.export',
      'note.purge',
      'notes.housekeeping',
    ]);
  });

  it('are all distinct', () => {
    expect(new Set(ALL_FIVE).size).toBe(ALL_FIVE.length);
  });

  it.each(ALL_FIVE)('%s has a friendly label, not a raw dotted key', (type) => {
    expect(jobTypeLabel(type)).not.toBe(type);
    expect(jobTypeLabel(type).length).toBeGreaterThan(0);
  });

  it('names the subject type and the managed-by tag this module owns', () => {
    expect(NOTE_SUBJECT_TYPE).toBe('note');
    expect(NOTES_MANAGED_BY).toBe('notes');
  });
});

describe('aiProviderThrottleKey', () => {
  it('is per user, in the documented shape', () => {
    expect(aiProviderThrottleKey('user-1')).toBe('ai-provider:user-1');
  });

  it('gives two users two buckets — the inverse of the transcription key', () => {
    expect(aiProviderThrottleKey('user-1')).not.toBe(aiProviderThrottleKey('user-2'));
  });
});
