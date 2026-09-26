// =============================================================================
// A full generation, end to end (issue #49, epic #45, docs/specs/notes.md §5)
// =============================================================================
//
// `note-generate.handler.spec.ts` next door checks the decisions; this file
// checks the WRITES — the handler, the real `NoteGenerationService`, the real
// prompt assembly and budget, and a fake streaming provider, over an in-memory
// stand-in for the five note tables.
//
// THE TWO ASSERTIONS THIS FILE EXISTS FOR:
//
//   1. THE BUFFER IS WRITTEN INCREMENTALLY, asserted MID-STREAM — from inside
//      the provider's own generator, before the completion has finished. An
//      implementation that collected the whole completion and wrote it once at
//      the end would pass every other test in this repository and destroy the
//      feature: #52's stream reads `note_generations.content`, so nothing would
//      appear on screen until the note was already finished.
//
//   2. THE JOB COMPLETES CORRECTLY WITH NO CONSUMER. Nothing in this file
//      subscribes to anything. The body, the `ai_generated` version and
//      `status: 'ready'` must all be there afterwards — "close the tab and walk
//      away" is not a UI feature, it is this property.
// =============================================================================

import { z } from 'zod';

import { AiProviderRegistry } from '../../src/ai/ai-provider.registry';
import type {
  AiDelta,
  AiGenerateRequest,
  AiProvider,
} from '../../src/ai/providers/ai-provider.interface';
import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { ProviderThrottleService } from '../../src/jobs/provider-throttle.service';
import { NoteGenerationService } from '../../src/notes/generation/note-generation.service';
import { NoteGenerateHandler } from '../../src/notes/handlers/note-generate.handler';

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

interface Db {
  generation: Record<string, unknown>;
  note: Record<string, unknown>;
  versions: Record<string, unknown>[];
}

/**
 * An in-memory stand-in for the tables this path writes.
 *
 * Deliberately hand-written rather than a deep mock: the assertions below are
 * about VALUES THAT LANDED, and a mock that only records calls would let a
 * handler "write" a version row whose body never matched the note's.
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

/** Records what the row held at each point the test asks. */
const observations: string[] = [];

/** `notes.status` at the moment the provider was actually called. */
let statusAtProviderCall: string | null = null;

class StreamingProvider implements AiProvider<unknown> {
  readonly id = 'openai';
  readonly label = 'OpenAI';
  readonly capabilities = {
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_000, structuredOutput: false, toolCalling: false },
    ],
    streaming: true as const,
    // #78: this fake implements no `listModels`, so it must not claim to — the
    // registry refuses that combination at boot.
    modelDiscovery: false,
  };
  readonly settingsSchema = z.unknown();
  readonly fieldDescriptors = [];

  constructor(private readonly db: Db) {}

  async testConnection(): Promise<never> {
    throw new Error('not used');
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async *generate(_ctx: unknown, _request: AiGenerateRequest): AsyncIterable<AiDelta> {
    // Spec §1.1: the job flips the note to `generating` BEFORE the first
    // provider call and not at enqueue time.
    statusAtProviderCall = this.db.note.status as string;

    for (const chunk of CHUNKS) {
      yield { kind: 'delta', text: chunk };

      // ⚠ READ FROM INSIDE THE STREAM. The `for await` body — flush included —
      // has already run for this chunk by the time the generator is resumed, so
      // this is what the database held mid-generation.
      observations.push(this.db.generation.content as string);
    }

    yield {
      kind: 'done',
      finishReason: 'stop',
      usage: { promptTokens: 1_200, completionTokens: 340 },
    };
  }
}

function harness(db: Db) {
  const prisma = createPrisma(db);
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue('https://app.example.com') };

  const generations = new NoteGenerationService(
    prisma as never,
    notifications as never,
    config as never,
    // #182's titling pass, stubbed. `null` is its "I changed nothing" answer,
    // so the note keeps the title these assertions already expect — the real
    // service's own three ranks are a unit concern, not this spec's.
    { titleNote: jest.fn().mockResolvedValue(null) } as never,
    // #188's semantic indexer, stubbed. Enqueueing is fire-and-forget at the
    // end of `commit()`, so these assertions never observe it — but the
    // constructor argument is required, and a real one here would queue a
    // `search.index` job these suites have nothing to run it with.
    { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    // #363's graph-extraction hook, stubbed: a silent no-op, as when the
    // deployment's graph switch is off.
    { enqueueForReadyNote: jest.fn().mockResolvedValue(null) } as never,
  );

  const providers = new AiProviderRegistry();
  providers.register(new StreamingProvider(db));

  const sources = {
    resolve: jest.fn().mockResolvedValue({
      text: '**Ana** · 00:00\n\nWe should ship on Friday.',
      describe: 'transcript transcript-1 at version 7',
    }),
  };

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
    sources as never,
    new ProviderThrottleService({ get: () => undefined } as never),
  );

  return { handler, prisma, notifications };
}

const job = () => ({ id: 'job-1', payload: { generationId: GENERATION_ID } }) as never;

describe('note.generate — a full generation with nobody watching', () => {
  let db: Db;
  let notifications: { notify: jest.Mock };

  beforeEach(async () => {
    observations.length = 0;
    statusAtProviderCall = null;
    db = freshDb();

    const built = harness(db);
    notifications = built.notifications;

    // ⚠ NOTHING SUBSCRIBES. No SSE controller, no emitter, no reader.
    await built.handler.process(job());
  });

  it('writes the buffer INCREMENTALLY — asserted mid-stream, not only at the end', () => {
    // One observation per chunk, taken from inside the provider's generator.
    expect(observations).toHaveLength(CHUNKS.length);

    // The first observation proves text reached the row while the model was
    // still producing: it is non-empty and SHORTER than the final note.
    expect(observations[0].length).toBeGreaterThan(0);
    expect(observations[0].length).toBeLessThan(FULL_TEXT.length);

    // And each observation is a strict prefix of the next — an append-only
    // buffer, never a rewrite.
    for (let index = 1; index < observations.length; index += 1) {
      expect(observations[index].startsWith(observations[index - 1])).toBe(true);
      expect(observations[index].length).toBeGreaterThan(observations[index - 1].length);
    }
  });

  it('bumps `lastEventId` with every write, so the SSE id sequence is gapless', () => {
    expect(db.generation.lastEventId).toBeGreaterThanOrEqual(CHUNKS.length);
  });

  it('settles the generation as succeeded, with the usage the provider reported', () => {
    expect(db.generation.status).toBe('succeeded');
    expect(db.generation.content).toBe(FULL_TEXT);
    expect(db.generation.promptTokens).toBe(1_200);
    expect(db.generation.completionTokens).toBe(340);
    expect(db.generation.startedAt).toBeInstanceOf(Date);
    expect(db.generation.completedAt).toBeInstanceOf(Date);
  });

  it('writes the note body and stamps the provenance and the version pointer', () => {
    expect(db.note.body).toBe(FULL_TEXT);
    expect(db.note.status).toBe('ready');
    expect(db.note.currentVersion).toBe(1);
    expect(db.note.provider).toBe('openai');
    expect(db.note.model).toBe('gpt-4o');
    expect(db.note.failureReason).toBeNull();
  });

  it('appends ONE `ai_generated` version whose author is null — meaning the AI', () => {
    expect(db.versions).toHaveLength(1);

    expect(db.versions[0]).toEqual(
      expect.objectContaining({
        noteId: NOTE_ID,
        version: 1,
        kind: 'ai_generated',
        body: FULL_TEXT,
        authorId: null,
        generationId: GENERATION_ID,
      }),
    );
  });

  it('holds §4.1\'s invariant: `notes.body` equals the version at `currentVersion`', () => {
    const current = db.versions.find((row) => row.version === db.note.currentVersion);

    expect(current?.body).toBe(db.note.body);
  });

  it('flipped the note to `generating` BEFORE the first provider call', () => {
    expect(statusAtProviderCall).toBe('generating');
  });

  it('tells the owner, after the commit and outside its transaction', () => {
    expect(notifications.notify).toHaveBeenCalledWith(
      'notes.note_ready',
      OWNER,
      expect.objectContaining({
        noteId: NOTE_ID,
        title: 'Kestrel weekly',
        templateName: 'Meeting notes',
        providerLabel: 'OpenAI',
        model: 'gpt-4o',
      }),
    );
  });
});

describe('note.generate — a terminal failure, with nobody watching', () => {
  it('fails the note, records the class, and tells the owner', async () => {
    const db = freshDb();
    const { handler, notifications, prisma } = harness(db);

    // No key saved for this user: an `AiAuthError`, the most ordinary failure
    // in this epic and entirely the user's own to fix.
    (handler as unknown as { credentials: { getSecret: jest.Mock } }).credentials = {
      getSecret: jest.fn().mockResolvedValue(null),
    };

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(db.generation.status).toBe('failed');
    expect(db.generation.errorClass).toBe('auth');
    expect(db.note.status).toBe('failed');
    expect(String(db.note.failureReason)).toContain('API key');
    expect(db.versions).toHaveLength(0);

    expect(notifications.notify).toHaveBeenCalledWith(
      'notes.note_failed',
      OWNER,
      expect.objectContaining({ noteId: NOTE_ID, category: 'Your API key' }),
    );

    // Nothing was written to the note's body on the way to failing.
    expect(db.note.body).toBe('');
    expect((prisma as { noteVersion: { create: jest.Mock } }).noteVersion.create)
      .not.toHaveBeenCalled();
  });
});
