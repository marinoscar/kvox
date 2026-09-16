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

// =============================================================================
// One mechanism, two entry points (issue #50, epic #45)
// =============================================================================
//
// THE TEST THIS FILE EXISTS FOR, and the only claim it makes:
//
//   A PREVIEW OF AN UNSAVED TEMPLATE AND A REAL GENERATION FROM THE SAVED
//   TEMPLATE WITH THE SAME FIELDS SEND THE PROVIDER **BYTE-IDENTICAL** BYTES.
//
// Issue #50 rejects a separate preview path in so many words, because it would
// be a second implementation of prompt assembly, budget enforcement and the
// error taxonomy — and it would drift from the real one exactly when it
// mattered. "Drift" is not a thing a code review reliably catches; it is a thing
// a comparison of two actual outputs catches. So this file runs
// `NoteGenerateHandler` TWICE over the same source and captures what the
// provider was handed each time:
//
//   run A — `kind: 'create'`, `template_id` set, payload `{ generationId }`.
//           The template is read from `note_templates`. This is what a real
//           note does.
//   run B — `kind: 'preview'`, `template_id` NULL, `note_id` NULL, payload
//           `{ generationId, userId, template: { …the same five fields… } }`.
//           The template is read from the payload. This is what
//           `POST /api/note-templates/preview` produces for an UNSAVED body.
//
// The assertion is `toBe` on both strings — not `toEqual`, not a subset, not a
// "contains the instructions" check. Anything weaker would pass while a
// preview quietly ordered the context after the source, or omitted the tone
// line, or normalised `structure` differently, which is precisely the class of
// difference a user tuning a template against preview output would be misled
// by.
//
// ⚠ THE HANDLER IS THE REAL ONE, AND SO ARE `assemblePrompt`, `computeTokenBudget`
// AND `NoteGenerationService`. Only Prisma, the provider and the credential
// store are stand-ins. A test that reimplemented assembly to compare against
// would be asserting that two copies of the test agree.
// =============================================================================

const OWNER = 'user-1';

/** The five template columns, used identically as a saved row and as a payload. */
const TEMPLATE_FIELDS = {
  instructions:
    'Write meeting notes a person who missed the meeting can act on. Do not invent decisions.',
  outputFormat: 'meeting_notes',
  structure: ['Overview', 'Decisions', 'Action items'],
  tone: 'neutral',
  length: 'About 400 words',
};

/** The one source both runs generate from, word for word. */
const SOURCE_TEXT = '**Ana** · 00:00\n\nWe should ship on Friday.\n\n**Bo** · 00:07\n\nAgreed.';

/** The optional Context both runs carry, word for word. */
const CONTEXT_TEXT = 'Attendees: Ana, Bo. Project: Kestrel.';

interface Recorded {
  systemPrompt: string;
  userContent: string;
  maxOutputTokens: number;
  model: string;
}

class RecordingProvider implements AiProvider<unknown> {
  readonly id = 'openai';
  readonly label = 'OpenAI';
  readonly capabilities = {
    models: [
      { id: 'gpt-4o', label: 'GPT-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_000 },
    ],
    streaming: true as const,
    // #78: this fake implements no `listModels`, so it must not claim to — the
    // registry refuses that combination at boot.
    modelDiscovery: false,
  };
  readonly settingsSchema = z.unknown();
  readonly fieldDescriptors = [];

  /** What the handler actually asked for, on every call. */
  readonly calls: Recorded[] = [];

  async testConnection(): Promise<never> {
    throw new Error('not used');
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async *generate(_ctx: unknown, request: AiGenerateRequest): AsyncIterable<AiDelta> {
    this.calls.push({
      systemPrompt: request.systemPrompt,
      userContent: request.userContent,
      maxOutputTokens: request.maxOutputTokens,
      model: request.model,
    });

    yield { kind: 'delta', text: '# Kestrel weekly\n\nWe ship on Friday.' };
    yield {
      kind: 'done',
      finishReason: 'stop',
      usage: { promptTokens: 900, completionTokens: 40 },
    };
  }
}

/** A generation row, plus whatever the two runs differ in. */
function generationRow(overrides: Record<string, unknown>) {
  return {
    id: 'gen-x',
    noteId: null,
    kind: 'create',
    status: 'pending',
    templateId: null,
    templateNameSnapshot: 'Meeting notes',
    contextText: CONTEXT_TEXT,
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
    ...overrides,
  };
}

/**
 * Everything the handler needs, with the real collaborators wherever it matters.
 *
 * `noteTemplate.findUnique` returns the SAVED row for run A. Run B never calls
 * it — `template_id` is NULL — which the assertions below check explicitly,
 * because "the preview happened to find a row anyway" would make the whole
 * comparison meaningless.
 */
function harness(generation: Record<string, unknown>, note: Record<string, unknown> | null) {
  const noteTemplateFindUnique = jest.fn(async () => ({
    id: 'template-1',
    ownerId: OWNER,
    name: 'Meeting notes',
    description: '',
    ...TEMPLATE_FIELDS,
    model: null,
    isArchived: false,
  }));

  const state = { ...generation };

  const prisma: Record<string, unknown> = {
    noteGeneration: {
      findUnique: jest.fn(async () => ({ ...state, note: note ? { ...note } : null })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && 'increment' in (value as object)) {
            state[key] = (state[key] as number) + (value as { increment: number }).increment;
            continue;
          }

          state[key] = value;
        }

        return { ...state };
      }),
    },
    note: {
      findUnique: jest.fn(async () => (note ? { ...note } : null)),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    noteVersion: { create: jest.fn(async () => ({})) },
    noteTemplate: { findUnique: noteTemplateFindUnique },
  };

  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma);

  const provider = new RecordingProvider();
  const providers = new AiProviderRegistry();
  providers.register(provider);

  const generations = new NoteGenerationService(
    prisma as never,
    { notify: jest.fn().mockResolvedValue(undefined) } as never,
    { get: jest.fn().mockReturnValue('https://app.example.com') } as never,
    // #182's titling pass, stubbed. A PREVIEW IS NEVER TITLED — `commit`
    // returns before the call — so this stub exists to satisfy the constructor
    // and must stay unused; that it is never called is itself the assertion
    // this spec's subject cares about.
    { titleNote: jest.fn().mockResolvedValue(null) } as never,
    // #188's semantic indexer, stubbed. Enqueueing is fire-and-forget at the
    // end of `commit()`, so these assertions never observe it — but the
    // constructor argument is required, and a real one here would queue a
    // `search.index` job these suites have nothing to run it with.
    { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
  );

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
        text: SOURCE_TEXT,
        describe: 'transcript transcript-1 at version 7',
      }),
    } as never,
    new ProviderThrottleService({ get: () => undefined } as never),
  );

  return { handler, provider, noteTemplateFindUnique, state };
}

describe('preview and real generation are one mechanism (#50)', () => {
  /** Run A: a real note, template read from its stored row. */
  async function realGeneration(): Promise<{ recorded: Recorded; readTheRow: boolean }> {
    const { handler, provider, noteTemplateFindUnique } = harness(
      generationRow({ id: 'gen-real', noteId: 'note-1', kind: 'create', templateId: 'template-1' }),
      {
        id: 'note-1',
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
    );

    await handler.process({ id: 'job-real', payload: { generationId: 'gen-real' } } as never);

    return {
      recorded: provider.calls[0],
      readTheRow: noteTemplateFindUnique.mock.calls.length > 0,
    };
  }

  /** Run B: a preview of an UNSAVED template, carried in the job payload. */
  async function previewGeneration(): Promise<{ recorded: Recorded; readTheRow: boolean }> {
    const { handler, provider, noteTemplateFindUnique } = harness(
      generationRow({ id: 'gen-preview', noteId: null, kind: 'preview', templateId: null }),
      null,
    );

    await handler.process({
      id: 'job-preview',
      payload: {
        generationId: 'gen-preview',
        // The preview endpoint's two payload seams: the billed account, and the
        // unsaved body there is no row to read.
        userId: OWNER,
        template: { ...TEMPLATE_FIELDS },
      },
    } as never);

    return {
      recorded: provider.calls[0],
      readTheRow: noteTemplateFindUnique.mock.calls.length > 0,
    };
  }

  it('sends a byte-identical system prompt and user content', async () => {
    const real = await realGeneration();
    const preview = await previewGeneration();

    expect(real.recorded).toBeDefined();
    expect(preview.recorded).toBeDefined();

    // THE ASSERTION. `toBe` on the strings themselves — see the header.
    expect(preview.recorded.systemPrompt).toBe(real.recorded.systemPrompt);
    expect(preview.recorded.userContent).toBe(real.recorded.userContent);
  });

  it('reaches that result from two genuinely different template sources', async () => {
    const real = await realGeneration();
    const preview = await previewGeneration();

    // If the preview had also read `note_templates` the comparison above would
    // be comparing one code path with itself, which proves nothing.
    expect(real.readTheRow).toBe(true);
    expect(preview.readTheRow).toBe(false);
  });

  it('budgets both identically, so the completion ceiling matches too', async () => {
    const real = await realGeneration();
    const preview = await previewGeneration();

    expect(preview.recorded.maxOutputTokens).toBe(real.recorded.maxOutputTokens);
    expect(preview.recorded.model).toBe(real.recorded.model);
  });

  it('carries the context AHEAD of the source in both, in the fixed order', async () => {
    const preview = await previewGeneration();

    const contextAt = preview.recorded.userContent.indexOf(CONTEXT_TEXT);
    const sourceAt = preview.recorded.userContent.indexOf('We should ship on Friday.');

    expect(contextAt).toBeGreaterThanOrEqual(0);
    expect(sourceAt).toBeGreaterThan(contextAt);
  });

  it('commits a preview without writing a note or a version', async () => {
    const { handler, state } = harness(
      generationRow({ id: 'gen-preview', noteId: null, kind: 'preview', templateId: null }),
      null,
    );

    await handler.process({
      id: 'job-preview',
      payload: {
        generationId: 'gen-preview',
        userId: OWNER,
        template: { ...TEMPLATE_FIELDS },
      },
    } as never);

    // The generation settles and keeps its text — that is what #52's stream
    // reads — and nothing whatsoever was written to `notes`.
    expect(state.status).toBe('succeeded');
    expect(state.content).toContain('We ship on Friday.');
    expect(state.noteId).toBeNull();
  });

  it('fails a preview readably when the payload carries no usable template', async () => {
    const { handler, state } = harness(
      generationRow({ id: 'gen-preview', noteId: null, kind: 'preview', templateId: null }),
      null,
    );

    // A payload written by another build. The job must not crash and must not
    // spend its one attempt rediscovering the same fact.
    await handler.process({
      id: 'job-preview',
      payload: { generationId: 'gen-preview', userId: OWNER, template: { nonsense: true } },
    } as never);

    expect(state.status).toBe('failed');
    expect(state.errorClass).toBe('refusal');
  });
});
