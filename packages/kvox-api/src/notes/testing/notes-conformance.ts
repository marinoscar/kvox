import { randomUUID } from 'node:crypto';

import type { KvoxEventsPort, KvoxJobHandler, KvoxNotifyPort, KvoxSettingsPort } from '../../ports/index.js';
import { createFakeKvoxAi, createFakeKvoxJobs, type FakeKvoxAi } from '../../testing/index.js';
import type { NoteGenerationRow, NoteRow, NoteTemplateRow } from '../data/notes-db.js';
import { NoteGenerateHandler } from '../handlers/note-generate.handler.js';
import { NOTE_READY_EVENT } from '../notes.events.js';
import { resolveNotesOptions } from '../notes.options.js';
import { NoteGenerationService } from '../generation/note-generation.service.js';
import type { NoteSourceService } from '../generation/note-source.service.js';
import type { NoteTitleService } from '../generation/note-title.service.js';
import type { SearchIndexService } from '../../search/index.js';
import { createInMemoryNotesDb, type InMemoryNotesDb } from './in-memory-notes-db.js';

// =============================================================================
// The notes conformance suite (issue #495, epic #491)
// =============================================================================
//
// `describeNotesConformance` states, once, the invariants of the notes pipeline that a host's
// binding must not break, and a fork that changes the pipeline must keep:
//
//   • the job types and their execution posture: `note.generate` and `note.retitle` are
//     server-only (they spend the owner's own key) and are tried ONCE; `note.source.extract` is
//     the one node-eligible type, with both members; nothing else is node-eligible;
//   • a note completes with NOBODY WATCHING: the generation handler writes every delta to
//     `note_generations.content` on the way past, so a run that never opens a stream still ends
//     with a complete note (the stream is a view over the row, never the delivery mechanism);
//   • an over-budget prompt is REFUSED, with numbers, before the provider is touched, and is
//     never truncated;
//   • `kvox.notes.note_ready` is published exactly once, AFTER the transaction that marks the
//     note `ready` has committed and never inside it.
//
// The pipeline invariants run the real handler and generation service over fakes (a scripted
// model, a fake job queue, an in-memory copy of the tables the pipeline writes), so they hold
// for any host; the first group reads the handlers the host's binding registered.
// =============================================================================

/**
 * The test runner's functions, so the suite runs under Jest or Vitest.
 *
 * @stability experimental
 */
export interface NotesConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: (...args: any[]) => any): void;
  /** Starts an assertion. */
  expect(actual: any): any;
}

/**
 * What the suite needs from a host's binding.
 *
 * @stability experimental
 */
export interface NotesConformanceTarget {
  /** Every job handler the binding registered (the notes types are picked out by name). */
  handlers: readonly KvoxJobHandler[];
}

/** The job types the slice registers (`note.library.import`, #715, and `note.import.format`, #729, are server-only). */
const PINNED_JOB_TYPES = [
  'note.export',
  'note.generate',
  'note.import.format',
  'note.library.import',
  'note.purge',
  'note.retitle',
  'note.source.extract',
  'notes.housekeeping',
] as const;

/** The node-eligible one. */
const NODE_ELIGIBLE = 'note.source.extract';

/** The two that spend the owner's own key. */
const AI_TYPES = ['note.generate', 'note.retitle'] as const;

const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const NOTE_ID = '33333333-3333-4333-8333-333333333333';
const GENERATION_ID = '44444444-4444-4444-8444-444444444444';

/** Everything one pipeline run is wired from. */
interface Scenario {
  tables: InMemoryNotesDb;
  ai: FakeKvoxAi;
  handler: NoteGenerateHandler;
  events: Array<{ name: string; payload: unknown; inTransaction: boolean; noteStatus: string | undefined }>;
  notifications: Array<{ key: string; userId: string }>;
  job: { id: string; type: string; subjectType: string; subjectId: string; payload: unknown; attempts: number; orgId: null };
}

function template(): NoteTemplateRow {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    ownerId: null,
    name: 'Concise Meeting Notes',
    description: 'A short summary.',
    instructions: 'Write a short summary.',
    outputFormat: 'summary',
    bodyFormat: 'markdown',
    structure: ['Overview'],
    tone: null,
    length: null,
    model: null,
    isArchived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function noteRow(): NoteRow {
  return {
    id: NOTE_ID,
    ownerId: OWNER_ID,
    title: 'Concise Meeting Notes',
    titleSource: 'template',
    body: '',
    bodyFormat: 'markdown',
    status: 'draft',
    currentVersion: 0,
    provider: null,
    model: null,
    currentGenerationId: GENERATION_ID,
    sourceType: 'note',
    sourceTranscriptId: null,
    sourceNoteId: randomUUID(),
    sourceObjectId: null,
    templateId: template().id,
    contextText: null,
    failureReason: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function generationRow(): NoteGenerationRow {
  return {
    id: GENERATION_ID,
    noteId: NOTE_ID,
    kind: 'create',
    status: 'pending',
    errorClass: null,
    errorDetail: null,
    templateId: template().id,
    templateNameSnapshot: 'Concise Meeting Notes',
    contextText: null,
    sourceType: 'note',
    sourceTranscriptId: null,
    sourceNoteId: randomUUID(),
    sourceObjectId: null,
    providerId: 'fake',
    model: 'fake-model',
    content: '',
    lastEventId: 0,
    promptTokens: null,
    completionTokens: null,
    systemPrompt: null,
    userContent: null,
    sourceVersion: null,
    contextCapturedAt: null,
    jobId: null,
    expiresAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
  };
}

function scenario(options: { sourceText?: string; flushChars?: number } = {}): Scenario {
  const tables = createInMemoryNotesDb({
    notes: [noteRow()],
    generations: [generationRow()],
    templates: [template()],
  });
  const ai = createFakeKvoxAi();
  const events: Scenario['events'] = [];
  const notifications: Scenario['notifications'] = [];

  const eventsPort: KvoxEventsPort = {
    emit(name, payload) {
      events.push({ name, payload, inTransaction: tables.inTransaction(), noteStatus: tables.notes[0]?.status });
    },
    subscribe: () => () => undefined,
  };
  const notify: KvoxNotifyPort = {
    registerEvents: () => undefined,
    notify(key, userId) {
      notifications.push({ key, userId });
    },
  };
  const settings = {
    readSystem: async () => ({ value: {}, version: 1 }),
  } as unknown as KvoxSettingsPort;
  const resolved = resolveNotesOptions({
    stream: options.flushChars !== undefined ? { flushChars: options.flushChars } : {},
  });
  const titles = { titleNote: async () => null } as unknown as NoteTitleService;
  const searchIndex = { enqueue: async () => undefined } as unknown as SearchIndexService;
  const generations = new NoteGenerationService(
    tables.db,
    notify,
    eventsPort,
    resolved,
    titles,
    searchIndex,
  );
  const sources = {
    resolve: async () => ({
      text: options.sourceText ?? 'The team agreed to ship the export feature.',
      describe: 'a conformance source',
      sourceVersion: 1,
    }),
  } as unknown as NoteSourceService;
  const handler = new NoteGenerateHandler(createFakeKvoxJobs(), tables.db, ai, settings, resolved, generations, sources);

  return {
    tables,
    ai,
    handler,
    events,
    notifications,
    job: {
      id: randomUUID(),
      type: 'note.generate',
      subjectType: 'note',
      subjectId: NOTE_ID,
      payload: { generationId: GENERATION_ID, userId: OWNER_ID },
      attempts: 1,
      orgId: null,
    },
  };
}

/**
 * Declares the notes conformance tests.
 *
 * @param name - the name of the group (the binding under test).
 * @param build - builds the target; called once, on the first test. May be asynchronous, so a
 *   host can boot its application module first.
 * @param harness - the runner's `describe`, `it` and `expect`.
 * @stability experimental
 */
export function describeNotesConformance(
  name: string,
  build: () => NotesConformanceTarget | Promise<NotesConformanceTarget>,
  harness: NotesConformanceHarness,
): void {
  const { describe, it, expect } = harness;

  describe(`notes conformance: ${name}`, () => {
    let built: Promise<NotesConformanceTarget> | undefined;

    const targetOf = (): Promise<NotesConformanceTarget> => (built ??= Promise.resolve(build()));

    // The slice's own types by name: a host passes every handler it registered, which also
    // holds the other slices'.
    const owned = (handler: KvoxJobHandler): boolean => handler.type.startsWith('note');

    const handlersOf = async (): Promise<Map<string, KvoxJobHandler>> =>
      new Map((await targetOf()).handlers.filter(owned).map((handler) => [handler.type, handler]));

    it('registers exactly the pinned job types', async () => {
      const byType = await handlersOf();

      expect([...byType.keys()].sort()).toEqual([...PINNED_JOB_TYPES].sort());
    });

    it('keeps note.generate and note.retitle server-only, AI-flagged, and tries each once', async () => {
      const byType = await handlersOf();

      for (const type of AI_TYPES) {
        const handler = byType.get(type);

        expect({ type, attempts: handler?.profile?.maxAttempts }).toEqual({ type, attempts: 1 });
        expect({ type, node: handler?.nodeResultSchema !== undefined }).toEqual({ type, node: false });
        expect({ type, node: handler?.persistNodeResult !== undefined }).toEqual({ type, node: false });
        expect({ type, usesAi: handler?.usesAi }).toEqual({ type, usesAi: true });
      }
    });

    it('keeps note.source.extract node-eligible: both members and the output key', async () => {
      const handler = (await handlersOf()).get(NODE_ELIGIBLE);

      expect(handler?.nodeResultSchema).toBeDefined();
      expect(typeof handler?.persistNodeResult).toBe('function');
      expect(typeof handler?.deriveOutputKey).toBe('function');
      expect(handler?.profile?.maxAttempts).toBe(3);
    });

    it('keeps every other type server-only', async () => {
      for (const handler of (await targetOf()).handlers.filter(owned)) {
        if (handler.type === NODE_ELIGIBLE) continue;

        expect({ type: handler.type, node: handler.nodeResultSchema !== undefined }).toEqual({
          type: handler.type,
          node: false,
        });
        expect({ type: handler.type, node: handler.persistNodeResult !== undefined }).toEqual({
          type: handler.type,
          node: false,
        });
      }
    });

    it('completes a note with nobody watching: every delta reaches the row before the run ends', async () => {
      const run = scenario({ flushChars: 1 });
      const seenInRow: string[] = [];
      const real = run.ai.generateText.bind(run.ai);

      // Observe the ROW between deltas: a stream reader polls it, so what it holds at each point is
      // everything a client could ever have seen.
      run.ai.generateText = (ctx, req) =>
        (async function* () {
          for await (const event of real(ctx, req)) {
            seenInRow.push(run.tables.generations[0].content);
            yield event;
          }
        })();
      run.ai.script = { text: ['Overview: ', 'the team ', 'shipped it.'] };

      await run.handler.process(run.job);

      const generation = run.tables.generations[0];
      const note = run.tables.notes[0];

      // No stream service exists in this scenario: nothing ever read or relayed a delta.
      expect(generation.status).toBe('succeeded');
      expect(generation.content).toBe('Overview: the team shipped it.');
      expect(note.status).toBe('ready');
      expect(note.body).toBe('Overview: the team shipped it.');
      expect(note.currentVersion).toBe(1);
      expect(run.tables.versions.map((version) => version.kind)).toEqual(['ai_generated']);
      // Before the second delta was yielded the row already held the first.
      expect(seenInRow[1]).toBe('Overview: ');
      expect(seenInRow[2]).toBe('Overview: the team ');
    });

    it('refuses an over-budget prompt with numbers, before the provider is touched, and never truncates', async () => {
      const run = scenario({ sourceText: 'word '.repeat(40_000) });

      run.ai.script = { target: { contextWindowTokens: 4_000, maxOutputTokens: 1_000 } };

      await run.handler.process(run.job);

      const generation = run.tables.generations[0];

      expect(generation.status).toBe('failed');
      expect(generation.errorClass).toBe('refusal');
      expect(generation.errorDetail).toMatch(/approximately [\d,]+ tokens; fake-model allows [\d,]+ for input/);
      expect(run.ai.calls.some((call) => call.method === 'generateText')).toBe(false);
      expect(run.tables.versions.length).toBe(0);
      expect(run.notifications.map((entry) => entry.key)).toEqual(['notes.note_failed']);
    });

    it('publishes kvox.notes.note_ready exactly once, after the commit and never inside the transaction', async () => {
      const run = scenario();

      run.ai.script = { text: 'A finished note.' };

      await run.handler.process(run.job);

      const ready = run.events.filter((event) => event.name === NOTE_READY_EVENT);

      expect(ready.length).toBe(1);
      expect(ready[0].payload).toEqual({ noteId: NOTE_ID, ownerId: OWNER_ID, version: 1 });
      expect(ready[0].inTransaction).toBe(false);
      // The note was already `ready` in the committed row when the event went out.
      expect(ready[0].noteStatus).toBe('ready');
    });

    it('publishes no ready event for a generation that fails', async () => {
      const run = scenario();

      run.ai.script = { failWith: 'refusal' };

      await run.handler.process(run.job);

      expect(run.tables.generations[0].status).toBe('failed');
      expect(run.events.filter((event) => event.name === NOTE_READY_EVENT).length).toBe(0);
    });
  });
}
