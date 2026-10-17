import { NoteExportHandler } from '../../src/notes/handlers/note-export.handler.js';
import { NoteGenerateHandler } from '../../src/notes/handlers/note-generate.handler.js';
import { NotePurgeHandler } from '../../src/notes/handlers/note-purge.handler.js';
import { NoteRetitleHandler } from '../../src/notes/handlers/note-retitle.handler.js';
import { NoteSourceExtractHandler } from '../../src/notes/handlers/note-source-extract.handler.js';
import { NotesHousekeepingHandler } from '../../src/notes/handlers/notes-housekeeping.handler.js';
import {
  NOTE_EXPORT_JOB_TYPE,
  NOTE_GENERATE_JOB_TYPE,
  NOTE_JOB_TYPES,
  NOTE_PURGE_JOB_TYPE,
  NOTE_RETITLE_JOB_TYPE,
  NOTE_SOURCE_EXTRACT_JOB_TYPE,
  NOTE_SUBJECT_TYPE,
  NOTES_HOUSEKEEPING_JOB_TYPE,
  NOTES_MANAGED_BY,
} from '../../src/notes/job-types.js';
import type { KvoxJobHandler } from '../../src/ports/index.js';

// =============================================================================
// The six note job types (issue #49, epic #45; ported onto the job port by issue #495)
// =============================================================================
//
// These strings are PERMANENT: `Job.type` is a plain text column, so renaming one costs a data
// migration over every row already queued, running or in the history under the old name. Pinning
// them in a test is how a rename becomes a deliberate act rather than a refactor's side effect.
//
// All six are also asserted to declare a LABEL on their handler, so the admin job list never
// shows an operator a raw dotted key.
// =============================================================================

describe('note job type strings', () => {
  it('are exactly the six names the pipeline registers', () => {
    expect([...NOTE_JOB_TYPES]).toEqual([
      'note.generate',
      'note.source.extract',
      'note.export',
      'note.retitle',
      'note.purge',
      'notes.housekeeping',
    ]);
    expect(NOTE_GENERATE_JOB_TYPE).toBe('note.generate');
    expect(NOTE_SOURCE_EXTRACT_JOB_TYPE).toBe('note.source.extract');
    expect(NOTE_EXPORT_JOB_TYPE).toBe('note.export');
    expect(NOTE_RETITLE_JOB_TYPE).toBe('note.retitle');
    expect(NOTE_PURGE_JOB_TYPE).toBe('note.purge');
    expect(NOTES_HOUSEKEEPING_JOB_TYPE).toBe('notes.housekeeping');
  });

  it('are all distinct', () => {
    expect(new Set(NOTE_JOB_TYPES).size).toBe(NOTE_JOB_TYPES.length);
  });

  // The constructors only store their collaborators, so each handler is built bare: this reads the
  // declared `type` and `label`.
  const HANDLERS = [
    NoteGenerateHandler,
    NoteSourceExtractHandler,
    NoteExportHandler,
    NoteRetitleHandler,
    NotePurgeHandler,
    NotesHousekeepingHandler,
  ] as unknown as Array<new () => KvoxJobHandler>;

  it('has one handler per type, in the same order', () => {
    expect(HANDLERS.map((Handler) => new Handler().type)).toEqual([...NOTE_JOB_TYPES]);
  });

  it.each(HANDLERS.map((Handler) => [new Handler().type, Handler] as const))(
    '%s declares a friendly label, not a raw dotted key',
    (type, Handler) => {
      const handler = new Handler();

      expect(handler.label).toBeDefined();
      expect(handler.label).not.toBe(type);
      expect(handler.label?.length).toBeGreaterThan(0);
    },
  );

  it('names the subject type and the managed-by tag this module owns', () => {
    expect(NOTE_SUBJECT_TYPE).toBe('note');
    expect(NOTES_MANAGED_BY).toBe('notes');
  });
});
