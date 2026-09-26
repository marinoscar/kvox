import { z } from 'zod';

import { AiProviderRegistry } from '../../src/ai/ai-provider.registry';
import type {
  AiDelta,
  AiGenerateRequest,
  AiProvider,
} from '../../src/ai/providers/ai-provider.interface';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { ProviderThrottleService } from '../../src/jobs/provider-throttle.service';
import { NoteGenerationStreamService } from '../../src/notes/generation/note-generation-stream.service';
import { NoteGenerationService } from '../../src/notes/generation/note-generation.service';
import type { NoteStreamMessage } from '../../src/notes/generation/note-stream';
import { NoteGenerateHandler } from '../../src/notes/handlers/note-generate.handler';

// =============================================================================
// THE STREAM IS ADDITIVE (issue #52, epic #45, docs/specs/notes.md §5)
// =============================================================================
//
// The single constraint the whole design is arranged around, asserted the only
// way it can be honestly asserted: RUN THE SAME GENERATION TWICE — once with a
// reader attached for its entire life, once with nobody connected at all — and
// require the committed note to be IDENTICAL.
//
// `note-generation.integration.spec.ts` already proves a generation completes
// with no consumer. What it cannot prove, because it has no reader, is that
// ATTACHING one changes nothing: that the poll does not perturb the write path,
// that a subscriber does not become load-bearing, and that the text a watcher
// saw is the text the note ends up with rather than a parallel rendering of it.
//
// This file runs the REAL `note.generate` handler, the REAL flusher and the
// REAL `NoteGenerationStreamService` over one in-memory stand-in for the note
// tables, so the reader and the writer meet on the same rows they meet on in
// production. Nothing here is mocked except the database and the model.
// =============================================================================

const OWNER = 'user-1';
const GENERATION_ID = 'gen-1';
const NOTE_ID = 'note-1';

/** Long enough that each delta crosses the flusher's character threshold. */
const CHUNKS = [
  `# Kestrel weekly\n\n${'Overview text. '.repeat(30)}`,
  `\n\n## Decisions\n\n${'We ship on Friday. '.repeat(30)}`,
  `\n\n## Action items\n\n${'Ana to confirm the date. '.repeat(30)}`,
];

const FULL_TEXT = CHUNKS.join('');

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface Db {
  generation: Record<string, unknown>;
  note: Record<string, unknown>;
  versions: Record<string, unknown>[];
}

function freshDb(): Db {
  return {
    generation: {
      id: GENERATION_ID,
      noteId: NOTE_ID,
      kind: 'create',
      status: 'pending',
      templateId: 'template-1',
      templateNameSnapshot: 'Meeting notes',
      contextText: 'Attendees: Ana, Bo.',
      sourceType: 'transcript',
      sourceTranscriptId: 'transcript-1',
      sourceNoteId: null,
      sourceObjectId: null,
      providerId: 'openai',
      model: 'gpt-4o',
      content: '',
      lastEventId: 0,
      errorClass: null,
      errorDetail: null,
      promptTokens: null,
      completionTokens: null,
      startedAt: null,
      completedAt: null,
    },
    note: {
      id: NOTE_ID,
      ownerId: OWNER,
      title: 'Kestrel weekly',
      body: '',
      status: 'draft',
      currentVersion: 0,
      provider: null,
      model: null,
      failureReason: null,
      deletedAt: null,
    },
    versions: [],
  };
}

/**
 * An in-memory stand-in for the tables this path touches.
 *
 * ⚠ ONE STORE, TWO PARTIES. The handler writes into it and — in the watched run
 * — the stream service reads out of it, concurrently, exactly as they share one
 * `note_generations` row in production. A mock per party would have proved
 * nothing about the property this file is for.
 */
function createPrisma(db: Db): Record<string, unknown> {
  const prisma: Record<string, unknown> = {
    noteGeneration: {
      findUnique: jest.fn(async () => ({ ...db.generation, note: { ...db.note } })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && 'increment' in (value as object)) {
            db.generation[key] =
              (db.generation[key] as number) + (value as { increment: number }).increment;
            continue;
          }

          db.generation[key] = value;
        }

        return { ...db.generation };
      }),
    },
    note: {
      findUnique: jest.fn(async () => ({ ...db.note })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(db.note, data);

        return { ...db.note };
      }),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(db.note, data);

        return { count: 1 };
      }),
    },
    noteVersion: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        db.versions.push({ ...data });

        return { ...data };
      }),
    },
    noteTemplate: {
      findUnique: jest.fn(async () => ({
        id: 'template-1',
        instructions: 'Write meeting notes a person who missed the meeting can act on.',
        outputFormat: 'Meeting notes',
        structure: ['Overview', 'Decisions', 'Action items'],
        tone: 'Neutral',
        length: 'About 400 words',
      })),
    },
  };

  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);

  return prisma;
}

/**
 * A model that thinks between chunks.
 *
 * The pause is what makes the watched run a real test: without it the whole
 * completion would land inside one macrotask and the reader would only ever see
 * the finished buffer, which is the one case this file must NOT be limited to.
 */
class StreamingProvider implements AiProvider<unknown> {
  readonly id = 'openai';
  readonly label = 'OpenAI';
  readonly capabilities = {
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_000, structuredOutput: false },
    ],
    streaming: true as const,
    // #78: this fake implements no `listModels`, so it must not claim to — the
    // registry refuses that combination at boot.
    modelDiscovery: false,
  };
  readonly settingsSchema = z.unknown();
  readonly fieldDescriptors = [];

  async testConnection(): Promise<never> {
    throw new Error('not used');
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async *generate(_ctx: unknown, _request: AiGenerateRequest): AsyncIterable<AiDelta> {
    for (const chunk of CHUNKS) {
      await delay(12);

      yield { kind: 'delta', text: chunk };
    }

    yield {
      kind: 'done',
      finishReason: 'stop',
      usage: { promptTokens: 1_200, completionTokens: 340 },
    };
  }
}

function harness(db: Db): { handler: NoteGenerateHandler; prisma: Record<string, unknown> } {
  const prisma = createPrisma(db);

  const generations = new NoteGenerationService(
    prisma as never,
    { notify: jest.fn().mockResolvedValue(undefined) } as never,
    { get: jest.fn().mockReturnValue('https://app.example.com') } as never,
    // #182's titling pass, stubbed. `null` is its "I changed nothing" answer,
    // so the note keeps the title these assertions already expect.
    { titleNote: jest.fn().mockResolvedValue(null) } as never,
    // #188's semantic indexer, stubbed. Enqueueing is fire-and-forget at the
    // end of `commit()`, so these assertions never observe it — but the
    // constructor argument is required, and a real one here would queue a
    // `search.index` job these suites have nothing to run it with.
    { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
  );

  const providers = new AiProviderRegistry();
  providers.register(new StreamingProvider());

  const handler = new NoteGenerateHandler(
    new JobHandlerRegistry(),
    prisma as never,
    providers,
    {
      get: jest.fn().mockResolvedValue({
        enabled: true,
        providers: {
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            allowedModels: ['gpt-4o'],
            defaultModel: 'gpt-4o',
          },
        },
        maxInputTokens: 100_000,
        maxOutputTokens: 4_000,
        requestTimeoutMs: 60_000,
      }),
    } as never,
    { getSecret: jest.fn().mockResolvedValue('sk-test') } as never,
    generations,
    {
      resolve: jest.fn().mockResolvedValue({
        text: '**Ana** · 00:00\n\nWe should ship on Friday.',
        describe: 'transcript transcript-1 at version 7',
      }),
    } as never,
    new ProviderThrottleService({ get: () => undefined } as never),
  );

  return { handler, prisma };
}

const job = () => ({ id: 'job-1', payload: { generationId: GENERATION_ID } }) as never;

/** What a run committed — the only thing a watcher is allowed to influence. */
interface Outcome {
  generationStatus: unknown;
  generationContent: unknown;
  noteBody: unknown;
  noteStatus: unknown;
  noteVersion: unknown;
  versionBodies: unknown[];
  promptTokens: unknown;
  completionTokens: unknown;
}

const outcomeOf = (db: Db): Outcome => ({
  generationStatus: db.generation.status,
  generationContent: db.generation.content,
  noteBody: db.note.body,
  noteStatus: db.note.status,
  noteVersion: db.note.currentVersion,
  versionBodies: db.versions.map((version) => version.body),
  promptTokens: db.generation.promptTokens,
  completionTokens: db.generation.completionTokens,
});

describe('The generation stream is additive (#52)', () => {
  let unwatched: Outcome;
  let watched: Outcome;
  let messages: NoteStreamMessage[];

  beforeAll(async () => {
    // ---------------------------------------------------------------------
    // RUN 1 — NOBODY IS WATCHING. No subscriber, no controller, no reader.
    // ---------------------------------------------------------------------
    const quietDb = freshDb();

    await harness(quietDb).handler.process(job());

    unwatched = outcomeOf(quietDb);

    // ---------------------------------------------------------------------
    // RUN 2 — A READER ATTACHED FOR THE WHOLE GENERATION, over the same store.
    // ---------------------------------------------------------------------
    const watchedDb = freshDb();
    const built = harness(watchedDb);

    const streams = new NoteGenerationStreamService(built.prisma as never, {
      pollIntervalMs: 2,
      heartbeatIntervalMs: 10_000,
      durationCapMs: 10_000,
    });

    messages = [];

    const closed = new Promise<void>((resolve, reject) => {
      streams.stream(GENERATION_ID).subscribe({
        next: (message) => messages.push(message),
        error: reject,
        complete: resolve,
      });
    });

    await built.handler.process(job());
    await closed;

    watched = outcomeOf(watchedDb);
  });

  // ==========================================================================
  // The assertion the file is named for
  // ==========================================================================

  it('commits a byte-identical note whether or not anybody was connected', () => {
    expect(watched).toEqual(unwatched);
  });

  it('completes the note fully in the run nobody watched', () => {
    // Stated separately so a regression that broke BOTH runs identically — the
    // one way the comparison above could pass while the feature is broken —
    // still fails here.
    expect(unwatched.generationStatus).toBe('succeeded');
    expect(unwatched.generationContent).toBe(FULL_TEXT);
    expect(unwatched.noteBody).toBe(FULL_TEXT);
    expect(unwatched.noteStatus).toBe('ready');
    expect(unwatched.noteVersion).toBe(1);
    expect(unwatched.versionBodies).toEqual([FULL_TEXT]);
  });

  // ==========================================================================
  // And what the watcher saw was the note itself, not a parallel rendering
  // ==========================================================================

  it('delivers deltas whose concatenation equals the committed body exactly', () => {
    const deltas = messages
      .filter((message) => message.type === 'delta')
      .map((message) => (message.data as { delta: string }).delta);

    expect(deltas.join('')).toBe(FULL_TEXT);
    expect(deltas.join('')).toBe(watched.noteBody);
  });

  it('saw the text ARRIVE — more than one delta, so it was a stream, not a snapshot', () => {
    const deltas = messages.filter((message) => message.type === 'delta');

    expect(deltas.length).toBeGreaterThan(1);
  });

  it('closes with done naming the version the generation produced', () => {
    const last = messages.filter((message) => message.comment === undefined).at(-1);

    expect(last?.type).toBe('done');
    expect(last?.data).toEqual({
      status: 'succeeded',
      offset: FULL_TEXT.length,
      currentVersion: 1,
    });
  });

  it('never wrote anything — every id is an offset the WRITER produced', () => {
    // The reader's own frames are derived entirely from `content`'s length, so
    // a bug here can cost a live view and can never cost a note.
    const ids = messages
      .filter((message) => message.id !== undefined)
      .map((message) => Number(message.id));

    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids.at(-1)).toBe(FULL_TEXT.length);
  });
});
