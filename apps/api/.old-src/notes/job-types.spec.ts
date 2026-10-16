// =============================================================================
// The five note job types, and the per-user throttle key (issue #49, epic #45)
// =============================================================================
//
// These strings are PERMANENT: `Job.type` is a plain text column, so renaming
// one costs a data migration over every row already queued, running or in the
// history under the old name. Pinning them in a test is how a rename becomes a
// deliberate act rather than a refactor's side effect.
//
// All five are also asserted to declare a LABEL on their handler, so the admin
// job list never shows an operator a raw dotted key.
// =============================================================================

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
import { jobTypeLabel, JobHandlerRegistry, type JobHandler } from '@marinoscar/platform-api/jobs';

import { NoteExportHandler } from './handlers/note-export.handler';
import { NoteGenerateHandler } from './handlers/note-generate.handler';
import { NotePurgeHandler } from './handlers/note-purge.handler';
import { NoteSourceExtractHandler } from './handlers/note-source-extract.handler';
import { NotesHousekeepingHandler } from './handlers/notes-housekeeping.handler';

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

  // Since #468 a handler declares its own `label` and the platform registry records
  // it when the handler registers. The constructors only store their collaborators,
  // so each handler is built bare: this reads the declared `type` and `label`.
  const HANDLERS = [
    NoteGenerateHandler,
    NoteSourceExtractHandler,
    NoteExportHandler,
    NotePurgeHandler,
    NotesHousekeepingHandler,
  ] as unknown as Array<new () => JobHandler>;

  it('has one handler per type, in the same order', () => {
    expect(HANDLERS.map((Handler) => new Handler().type)).toEqual(ALL_FIVE);
  });

  it.each(HANDLERS.map((Handler) => [new Handler().type, Handler] as const))(
    '%s declares a friendly label, not a raw dotted key',
    (type, Handler) => {
      const handler = new Handler();

      expect(handler.label).toBeDefined();
      expect(handler.label).not.toBe(type);
      expect(handler.label?.length).toBeGreaterThan(0);

      new JobHandlerRegistry().register(handler);

      expect(jobTypeLabel(type)).toBe(handler.label);
    },
  );

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
