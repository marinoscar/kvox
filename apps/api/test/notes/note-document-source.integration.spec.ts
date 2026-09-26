// =============================================================================
// A document becomes a note, end to end (issue #51, epic #45)
// =============================================================================
//
// THE ONE THING THIS FILE PROVES that no unit test can: the two halves of #51
// actually meet. `note.source.extract` writes a second storage object and
// records its id in the FIRST object's metadata (spec §4.7); `note.generate`
// reads that key, downloads that object, and generates from its contents. Each
// half is tested on its own next door, and each would keep passing if they
// disagreed about the key, the encoding, or which object to read.
//
// So this suite runs the REAL extraction handler, the REAL `NoteObjectsService`
// over an in-memory bucket, the REAL `NoteSourceService`, and the REAL
// `NoteGenerateHandler` against a fake streaming provider — and asserts what
// actually reached the note:
//
//   * the note reaches `ready`, and its `sourceObjectId` survives untouched;
//   * the model was given the EXTRACTED TEXT and never the raw PDF bytes —
//     asserted on the prompt the provider received, which is the only place
//     that mistake would ever be visible;
//   * a scanned PDF fails the generation with the SENTENCE the extraction
//     recorded, OCR statement included, rather than with a generic error.
// =============================================================================

import { Readable } from 'node:stream';
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
import { NoteSourceService } from '../../src/notes/generation/note-source.service';
import { NoteGenerateHandler } from '../../src/notes/handlers/note-generate.handler';
import { NoteSourceExtractHandler } from '../../src/notes/handlers/note-source-extract.handler';
import { NoteObjectsService } from '../../src/notes/note-objects.service';
import { EXTRACTION_METADATA_KEY } from '../../src/notes/source-metadata';
import { MARKDOWN_BODY, markdownFile, scannedPdf } from '../fixtures/documents.fixture';

const OWNER = 'owner-1';
const NOTE_ID = 'note-1';
const GENERATION_ID = 'gen-1';
const SOURCE_OBJECT_ID = 'source-object-1';
const EXTRACT_JOB_ID = 'extract-job-1';

/** The completion the fake provider streams. */
const NOTE_TEXT = '# Deployment brief\n\nRun the migration, then restart the API.';

// -----------------------------------------------------------------------------
// An in-memory world: one bucket, five tables
// -----------------------------------------------------------------------------

interface World {
  /** storageKey → bytes. Stands in for the object store. */
  bucket: Map<string, Buffer>;
  /** id → row. Stands in for `storage_objects`. */
  objects: Map<string, Record<string, unknown>>;
  note: Record<string, unknown>;
  generation: Record<string, unknown>;
  versions: Record<string, unknown>[];
  /** The prompt the provider was actually handed. */
  prompts: string[];
}

function createWorld(sourceMimeType: string, sourceBytes: Buffer): World {
  const sourceKey = 'notes/sources/uploads/abc/source';

  return {
    bucket: new Map([[sourceKey, sourceBytes]]),
    objects: new Map([
      [
        SOURCE_OBJECT_ID,
        {
          id: SOURCE_OBJECT_ID,
          name: sourceMimeType === 'application/pdf' ? 'scan.pdf' : 'brief.md',
          mimeType: sourceMimeType,
          storageKey: sourceKey,
          managedBy: 'notes',
          uploadedById: OWNER,
          metadata: { uploadedFilename: 'brief.md' },
          size: BigInt(sourceBytes.byteLength),
          status: 'ready',
        },
      ],
    ]),
    note: {
      id: NOTE_ID,
      ownerId: OWNER,
      title: 'Deployment brief',
      body: '',
      status: 'draft',
      currentVersion: 0,
      provider: null,
      model: null,
      failureReason: null,
      sourceObjectId: SOURCE_OBJECT_ID,
      deletedAt: null,
    },
    generation: {
      id: GENERATION_ID,
      noteId: NOTE_ID,
      kind: 'create',
      status: 'pending',
      templateId: 'template-1',
      templateNameSnapshot: 'Summary',
      contextText: null,
      sourceType: 'document',
      sourceTranscriptId: null,
      sourceNoteId: null,
      sourceObjectId: SOURCE_OBJECT_ID,
      providerId: 'openai',
      model: 'gpt-4o',
      content: '',
      lastEventId: 0,
      promptTokens: null,
      completionTokens: null,
      startedAt: null,
      completedAt: null,
    },
    versions: [],
    prompts: [],
  };
}

/** A storage provider backed by `world.bucket`. */
function createStorage(world: World) {
  return {
    upload: jest.fn(async (key: string, body: Readable) => {
      const chunks: Buffer[] = [];

      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }

      world.bucket.set(key, Buffer.concat(chunks));

      return { key, bucket: 'test-bucket', location: `s3://test/${key}`, eTag: '"e"' };
    }),
    download: jest.fn(async (key: string) => {
      const bytes = world.bucket.get(key);

      if (!bytes) throw new Error(`No object at ${key}`);

      return Readable.from([bytes]);
    }),
    exists: jest.fn(async (key: string) => world.bucket.has(key)),
    getBucket: jest.fn(() => 'test-bucket'),
  };
}

/**
 * A Prisma stand-in over `world`.
 *
 * Hand-written rather than a deep mock, deliberately: every assertion in this
 * file is about a VALUE THAT LANDED, and a mock that only records calls would
 * let the extraction "write" a metadata key the generator never reads back.
 */
function createPrisma(world: World): Record<string, unknown> {
  let nextObjectId = 2;

  const prisma: Record<string, unknown> = {
    storageObject: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = world.objects.get(where.id);

        return row ? { ...row } : null;
      }),
      findFirst: jest.fn(async ({ where }: { where: { storageKey?: string } }) => {
        for (const row of world.objects.values()) {
          if (row.storageKey === where.storageKey) return { ...row };
        }

        return null;
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `extracted-object-${nextObjectId}`;
        nextObjectId += 1;

        const row = { id, ...data };
        world.objects.set(id, row);

        return { ...row };
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = world.objects.get(where.id);

          if (!row) throw new Error('no such object');

          Object.assign(row, data);

          return { ...row };
        },
      ),
    },
    note: {
      findUnique: jest.fn(async () => ({ ...world.note })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(world.note, data);

        return { ...world.note };
      }),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(world.note, data);

        return { count: 1 };
      }),
    },
    noteGeneration: {
      findUnique: jest.fn(async () => ({
        ...world.generation,
        note: { ...world.note },
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && 'increment' in (value as object)) {
            world.generation[key] =
              (world.generation[key] as number) + (value as { increment: number }).increment;
            continue;
          }

          world.generation[key] = value;
        }

        return { ...world.generation };
      }),
    },
    noteVersion: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        world.versions.push({ ...data });

        return { ...data };
      }),
    },
    noteTemplate: {
      findUnique: jest.fn(async () => ({
        id: 'template-1',
        instructions: 'Summarize the document for somebody who has not read it.',
        outputFormat: 'Summary',
        structure: ['Overview'],
        tone: 'Neutral',
        length: 'Short',
      })),
    },
  };

  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);

  return prisma;
}

class FakeProvider implements AiProvider<unknown> {
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

  constructor(private readonly world: World) {}

  async testConnection(): Promise<never> {
    throw new Error('not used');
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async *generate(_ctx: unknown, request: AiGenerateRequest): AsyncIterable<AiDelta> {
    // ⚠ CAPTURED SO THE TEST CAN LOOK AT IT. Whether the model was handed the
    // extracted text or the raw PDF bytes is visible in exactly one place, and
    // this is it.
    this.world.prompts.push(JSON.stringify(request));

    yield { kind: 'delta', text: NOTE_TEXT };
    yield {
      kind: 'done',
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 40 },
    };
  }
}

function harness(world: World) {
  const prisma = createPrisma(world);
  const storage = createStorage(world);

  const objects = new NoteObjectsService(
    prisma as never,
    { deleteManagedObject: jest.fn() } as never,
    storage as never,
  );

  const extract = new NoteSourceExtractHandler(
    new JobHandlerRegistry(),
    prisma as never,
    objects,
    storage as never,
  );

  const sources = new NoteSourceService(
    prisma as never,
    { materialize: jest.fn() } as never,
    { render: jest.fn() } as never,
    objects,
  );

  const providers = new AiProviderRegistry();
  providers.register(new FakeProvider(world));

  const generate = new NoteGenerateHandler(
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
        maxDocumentBytes: 26_214_400,
      }),
    } as never,
    { getSecret: jest.fn().mockResolvedValue('sk-test') } as never,
    new NoteGenerationService(
      prisma as never,
      { notify: jest.fn().mockResolvedValue(undefined) } as never,
      { get: jest.fn().mockReturnValue('https://app.example.com') } as never,
      // #182's titling pass, stubbed. `null` is its "I changed nothing"
      // answer, so the note keeps the title these assertions already expect.
      { titleNote: jest.fn().mockResolvedValue(null) } as never,
      // #188's semantic indexer, stubbed. Enqueueing is fire-and-forget at the
      // end of `commit()`, so these assertions never observe it — but the
      // constructor argument is required, and a real one here would queue a
      // `search.index` job against a database these suites do not own.
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    ),
    sources,
    new ProviderThrottleService({ get: () => undefined } as never),
  );

  return { extract, generate, prisma, storage };
}

const extractJob = () =>
  ({
    id: EXTRACT_JOB_ID,
    type: 'note.source.extract',
    subjectType: 'storage_object',
    subjectId: SOURCE_OBJECT_ID,
    payload: { objectId: SOURCE_OBJECT_ID },
  }) as never;

const generateJob = () => ({ id: 'gen-job-1', payload: { generationId: GENERATION_ID } }) as never;

describe('a document becomes a note', () => {
  let world: World;

  beforeEach(async () => {
    world = createWorld('text/markdown', markdownFile());

    const { extract, generate } = harness(world);

    await extract.process(extractJob());
    await generate.process(generateJob());
  });

  it('reaches `ready`, and the note\'s `sourceObjectId` survives', () => {
    expect(world.note.status).toBe('ready');
    expect(world.note.body).toBe(NOTE_TEXT);
    expect(world.note.currentVersion).toBe(1);
    // The link back to the uploaded document is untouched by generation — it
    // is what makes "regenerate from the same document" possible at all.
    expect(world.note.sourceObjectId).toBe(SOURCE_OBJECT_ID);
  });

  it('stored the extracted text at the spec\'s key, linked from the SOURCE object', () => {
    const source = world.objects.get(SOURCE_OBJECT_ID) as {
      metadata: Record<string, unknown>;
    };

    const extractedId = source.metadata.extractedObjectId as string;

    expect(typeof extractedId).toBe('string');

    const extracted = world.objects.get(extractedId) as { storageKey: string };

    expect(extracted.storageKey).toBe(
      `notes/sources/${SOURCE_OBJECT_ID}/extracted-${EXTRACT_JOB_ID}.txt`,
    );
    expect(world.bucket.get(extracted.storageKey)?.toString('utf8')).toBe(MARKDOWN_BODY);
  });

  it('gave the model the EXTRACTED TEXT and never the raw uploaded bytes', () => {
    expect(world.prompts).toHaveLength(1);

    const prompt = world.prompts[0];

    // The document's own words reached the prompt...
    expect(prompt).toContain('npm run prisma:migrate');
    // ...and the fences survived the round trip through storage.
    expect(prompt).toContain('```bash');
    // A raw upload would have arrived as base64 or as a `%PDF` header. Neither
    // has any business in a prompt the user pays input tokens for.
    expect(prompt).not.toContain('%PDF');
  });
});

describe('a scanned document fails the generation with its own sentence', () => {
  it('reports "only images" and that OCR is not supported, not a generic error', async () => {
    const world = createWorld('application/pdf', await scannedPdf());
    const { extract, generate } = harness(world);

    await extract.process(extractJob());

    // A permanent condition settles the EXTRACTION normally — the job did its
    // job by determining an answer that cannot change.
    const source = world.objects.get(SOURCE_OBJECT_ID) as {
      metadata: Record<string, unknown>;
    };

    expect(source.metadata[EXTRACTION_METADATA_KEY]).toMatchObject({
      status: 'unextractable',
      reason: 'no_text_layer',
    });
    expect(source.metadata.extractedObjectId).toBeUndefined();

    // ...and the generation then fails with the sentence the user can act on,
    // rather than with "extraction failed" or a stack trace.
    await expect(generate.process(generateJob())).resolves.toBeUndefined();

    expect(world.note.status).toBe('failed');
    expect(String(world.note.failureReason)).toMatch(/images/i);
    expect(String(world.note.failureReason)).toMatch(/OCR/);
    expect(world.prompts).toHaveLength(0);
    expect(world.versions).toHaveLength(0);
  });
});
