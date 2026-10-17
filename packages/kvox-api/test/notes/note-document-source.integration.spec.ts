import {
  createFakeKvoxAi,
  createFakeKvoxJobs,
  createInMemoryKvoxObjectStore,
  type FakeKvoxAi,
  type InMemoryKvoxObjectStore,
} from '../../src/testing/index.js';
import { NoteGenerationService } from '../../src/notes/generation/note-generation.service.js';
import { NoteSourceService } from '../../src/notes/generation/note-source.service.js';
import { NoteGenerateHandler } from '../../src/notes/handlers/note-generate.handler.js';
import { NoteSourceExtractHandler } from '../../src/notes/handlers/note-source-extract.handler.js';
import { NoteObjectsService } from '../../src/notes/note-objects.service.js';
import { resolveNotesOptions } from '../../src/notes/notes.options.js';
import { EXTRACTION_METADATA_KEY } from '../../src/notes/source-metadata.js';
import { MARKDOWN_BODY, markdownFile, scannedPdf } from '../../src/notes/testing/document-fixtures.js';

const OWNER = 'owner-1';
const NOTE_ID = 'note-1';
const GENERATION_ID = 'gen-1';
const EXTRACT_JOB_ID = 'extract-job-1';

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
// over an in-memory object store, the REAL `NoteSourceService`, and the REAL
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

/** The completion the fake provider streams. */
const NOTE_TEXT = '# Deployment brief\n\nRun the migration, then restart the API.';

// -----------------------------------------------------------------------------
// An in-memory world: one object store, the note tables
// -----------------------------------------------------------------------------

interface World {
  /** Stands in for the object store (and the object rows the port describes). */
  store: InMemoryKvoxObjectStore;
  /** The uploaded document's object id. */
  sourceObjectId: string;
  note: Record<string, unknown>;
  generation: Record<string, unknown>;
  versions: Record<string, unknown>[];
  /** The prompt the provider was actually handed. */
  prompts: string[];
}

async function createWorld(sourceMimeType: string, sourceBytes: Buffer): Promise<World> {
  const store = createInMemoryKvoxObjectStore();

  const stored = await store.put({
    ownerId: OWNER,
    key: 'notes/sources/uploads/abc/source',
    body: sourceBytes,
    contentType: sourceMimeType,
    managedBy: 'notes',
    name: sourceMimeType === 'application/pdf' ? 'scan.pdf' : 'brief.md',
    metadata: { uploadedFilename: 'brief.md' },
  });
  const sourceObjectId = stored.objectId;

  return {
    store,
    sourceObjectId,
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
      sourceObjectId,
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
      sourceObjectId,
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

/**
 * A database stand-in over `world`.
 *
 * Hand-written rather than a deep mock, deliberately: every assertion in this file is about a
 * VALUE THAT LANDED, and a mock that only records calls would let the extraction "write" a
 * metadata key the generator never reads back.
 */
function createPrisma(world: World): Record<string, unknown> {
  const prisma: Record<string, unknown> = {
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

/**
 * CAPTURED SO THE TEST CAN LOOK AT IT. Whether the model was handed the extracted text or the
 * raw PDF bytes is visible in exactly one place, and this is it: the request the port
 * received, serialised.
 */
function capturingAi(world: World): FakeKvoxAi {
  const ai = createFakeKvoxAi({ script: { text: [NOTE_TEXT], target: { provider: 'openai', model: 'gpt-4o' } } });
  const generateText = ai.generateText.bind(ai);

  ai.generateText = (ctx, request) => {
    world.prompts.push(JSON.stringify({ system: request.system, user: request.user }));

    return generateText(ctx, request);
  };

  return ai;
}

function harness(world: World) {
  const prisma = createPrisma(world);
  const options = resolveNotesOptions({});
  const jobs = createFakeKvoxJobs();
  const objects = new NoteObjectsService(world.store);

  const extract = new NoteSourceExtractHandler(jobs, world.store, objects);

  const sources = new NoteSourceService(
    prisma as never,
    { materialize: jest.fn() } as never,
    { render: jest.fn() } as never,
    objects,
    world.store,
  );

  const generate = new NoteGenerateHandler(
    jobs,
    prisma as never,
    capturingAi(world),
    // The deployment's two spend caps (`ai.maxInputTokens`, `ai.maxOutputTokens`).
    { readSystem: jest.fn().mockResolvedValue({ value: { maxInputTokens: 100_000, maxOutputTokens: 4_000 }, version: 1 }) } as never,
    options,
    new NoteGenerationService(
      prisma as never,
      { notify: jest.fn().mockResolvedValue(undefined) } as never,
      { emit: jest.fn(), on: jest.fn() } as never,
      options,
      // The titling pass, stubbed: `null` is its "I changed nothing" answer.
      { titleNote: jest.fn().mockResolvedValue(null) } as never,
      // The semantic indexer, stubbed: a real one would queue a `search.index` job.
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    ),
    sources,
  );

  return { extract, generate, prisma };
}

const extractJob = (sourceObjectId: string) =>
  ({
    id: EXTRACT_JOB_ID,
    type: 'note.source.extract',
    subjectType: 'storage_object',
    subjectId: sourceObjectId,
    payload: { objectId: sourceObjectId },
    attempts: 1,
    orgId: null,
  }) as never;

const generateJob = () => ({ id: 'gen-job-1', payload: { generationId: GENERATION_ID } }) as never;

describe('a document becomes a note', () => {
  let world: World;

  beforeEach(async () => {
    world = await createWorld('text/markdown', markdownFile());

    const { extract, generate } = harness(world);

    await extract.process(extractJob(world.sourceObjectId));
    await generate.process(generateJob());
  });

  it('reaches `ready`, and the note\'s `sourceObjectId` survives', () => {
    expect(world.note.status).toBe('ready');
    expect(world.note.body).toBe(NOTE_TEXT);
    expect(world.note.currentVersion).toBe(1);
    // The link back to the uploaded document is untouched by generation — it
    // is what makes "regenerate from the same document" possible at all.
    expect(world.note.sourceObjectId).toBe(world.sourceObjectId);
  });

  it('stored the extracted text at the spec\'s key, linked from the SOURCE object', () => {
    const source = world.store.objects.get(world.sourceObjectId) as {
      metadata: Record<string, unknown>;
    };

    const extractedId = source.metadata.extractedObjectId as string;

    expect(typeof extractedId).toBe('string');

    const extracted = world.store.objects.get(extractedId) as { key: string; bytes: Buffer };

    expect(extracted.key).toBe(`notes/sources/${world.sourceObjectId}/extracted-${EXTRACT_JOB_ID}.txt`);
    expect(extracted.bytes.toString('utf8')).toBe(MARKDOWN_BODY);
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
    const world = await createWorld('application/pdf', await scannedPdf());
    const { extract, generate } = harness(world);

    await extract.process(extractJob(world.sourceObjectId));

    // A permanent condition settles the EXTRACTION normally — the job did its
    // job by determining an answer that cannot change.
    const source = world.store.objects.get(world.sourceObjectId) as {
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
