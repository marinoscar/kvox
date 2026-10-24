// =============================================================================
// Job-type snapshot (issue #468 step 1, epic #467)
// =============================================================================
//
// A `jobs` row names its handler by the `type` STRING. Rows outlive code: a
// `pending` row written before a deploy is claimed by whatever the new code
// registers. If a type string changes, or a handler stops registering, every
// queued row of that type is stranded as an "unknown job type" permanent
// failure. This spec pins every string KVox has ever registered, so the move
// of the queue onto `@marinoscar/platform-api/jobs` (and every later handler
// move) cannot silently drop or rename one.
//
// WRITTEN BEFORE THE PORT, AND MEANT TO PASS BEFORE AND AFTER IT. Only the
// IMPORT LINES and the two small accessor helpers below know where the registry
// and the label table live; the assertions do not. When the jobs slice moves to
// `@marinoscar/platform-api/jobs`, change those lines and nothing else.
//
// The strings below are LITERALS on purpose. Resolving them from the handlers'
// own constants would make the test follow a rename instead of catching it.
// They were resolved from the real `readonly type` constants
// (`transcripts/job-types.ts`, `notes/job-types.ts`, `@marinoscar/kvox-api/graph`'s `job-types.ts`,
// `@marinoscar/kvox-api/ask`'s `job-types.ts`, `search/indexing/job-types.ts`, `kvox-objects/job-types.ts`
// and each handler file), not typed from memory.
// =============================================================================

import '../../src/kvox.manifest';

// --- The only lines that change when the jobs slice moves to the platform ----
// ------------------------------------------------------------------------------

import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';
import { JobHandlerRegistry, jobTypeLabels } from '@marinoscar/platform-api/jobs';

/** Every type the booted app has a handler registered for. */
function registeredTypes(context: TestContext): string[] {
  return context.module.get(JobHandlerRegistry, { strict: false }).types();
}

/** Every `type -> label` pair the app has registered. */
function registeredLabels(): Record<string, string> {
  return Object.fromEntries(jobTypeLabels());
}

/**
 * Every type string KVox registers (or, for the retired ones, registered).
 * Grouped by owner. NEVER edit a string in this list: a type is permanent
 * once a row of that type exists.
 */
const KVOX_JOB_TYPES = [
  // transcripts
  'media.audio.transcode',
  'transcription.submit',
  'transcription.poll',
  'transcription.ingest',
  'transcript.snapshot',
  'transcript.export',
  'transcript.purge',
  'transcript.name_check',
  'transcripts.housekeeping',
  // notes
  'note.generate',
  'note.source.extract',
  'note.import.format',
  'note.library.import',
  'note.export',
  'note.purge',
  'note.retitle',
  'notes.housekeeping',
  // graph
  'kg.purge',
  'kg.resolve',
  'kg.embed',
  'kg.extract',
  'kg.speaker_link',
  'kg.export',
  'kg.import',
  'kg.graph_layout',
  'kg.entity_digest',
  'kg.migrate',
  'kg.topics_promote',
  'kg.library_reconcile',
  'kg.autocommit',
  // ask, search, user data
  'ask.respond',
  'search.index',
  'user.data.purge',
  // queue and fleet housekeeping (platform-owned after #468)
  'job.history.purge',
  'nodes.fleet.sweep',
  'nodes.fleet.prune',
  // storage, notifications, backup (platform-owned after #469, #470, #471)
  'storage.cleanup.stale-uploads',
  // this app's storage handler (#480): the Danger Zone's `files` category
  'files.purge_unmanaged',
  'admin.broadcast.start',
  'admin.broadcast.chunk',
  'db.backup.run',
  'db.backup.sweep',
  'db.restore.run',
  'db.restore.old-db-drop',
  // platform identity (#465): registered through IDENTITY_JOBS, strings unchanged
  'auth.token.cleanup',
  'device-auth.code.cleanup',
  // platform AI slice (#473): registered by `AiModule.forRoot`, strings are the platform's.
  // Added deliberately by #473; the snapshot is a superset check, so this is a pin, not a gate.
  'ai.catalog.refresh',
  'ai.keys.recheck',
  'ai.response.run',
  'ai.image.generate',
  'ai.audio.transcribe',
  'ai.audio.speech',
  'ai.runs.purge',
  'ai.usage.purge',
  // retired by #468 step 6: handlers deleted, labels kept
  'example.echo',
  'example.checksum',
] as const;

/**
 * Types whose handlers are deleted by the port but whose rows may still exist.
 * The handler may or may not be registered; the LABEL must always be, so the
 * admin job list keeps rendering old rows as a phrase instead of a bare key.
 */
const RETIRED_TYPES: ReadonlyArray<{ readonly type: string; readonly reason: string }> = [
  {
    type: 'example.echo',
    reason: 'Template demonstration handler (no-op echo); retired in #468. Kept only so historical rows render.',
  },
  {
    type: 'example.checksum',
    reason: 'Template demonstration of a node-eligible job (checksum of a stored object); retired in #468. Kept only so historical rows render.',
  },
];

describe('job type snapshot (issue #468)', () => {
  let context: TestContext;
  let registered: string[];

  beforeAll(async () => {
    context = await createTestApp();
    registered = registeredTypes(context);
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  it('commits a list with no duplicates', () => {
    expect(new Set(KVOX_JOB_TYPES).size).toBe(KVOX_JOB_TYPES.length);
  });

  it('registers every type string KVox has ever registered (superset)', () => {
    const retired = new Set(RETIRED_TYPES.map((entry) => entry.type));
    const missing = KVOX_JOB_TYPES.filter(
      (type) => !retired.has(type) && !registered.includes(type),
    );

    expect(missing).toEqual([]);
  });

  describe('retired types', () => {
    it.each(RETIRED_TYPES.map((entry) => [entry.type, entry.reason] as const))(
      '%s is either registered or has a label (%s)',
      (type) => {
        expect(registered.includes(type) || type in registeredLabels()).toBe(true);
      },
    );

    it.each(RETIRED_TYPES.map((entry) => entry.type))(
      '%s keeps a non-empty label so old rows render as a phrase',
      (type) => {
        const label = registeredLabels()[type];

        expect(typeof label).toBe('string');
        expect(label.trim().length).toBeGreaterThan(0);
      },
    );

    it('gives every retired type a reason', () => {
      for (const entry of RETIRED_TYPES) {
        expect(entry.reason.trim().length).toBeGreaterThan(0);
      }
    });

    it('lists only types that are in the committed list', () => {
      for (const entry of RETIRED_TYPES) {
        expect(KVOX_JOB_TYPES).toContain(entry.type);
      }
    });
  });
});
