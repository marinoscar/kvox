// =============================================================================
// `note.generate` (issue #49, epic #45, docs/specs/notes.md §1-§5)
// =============================================================================
//
// Four assertions in this file are the ones a later refactor is most likely to
// break without noticing:
//
//   1. THE BUDGET IS CHECKED BEFORE THE PROVIDER IS TOUCHED. Asserted with the
//      REAL `OpenAiProvider` over a fetch seam that fails the test if it is
//      ever invoked — a check that ran "during" would still refuse the job, but
//      the user would already have been billed for the input tokens.
//   2. EVERY DOMAIN CLASS RETURNS, IT DOES NOT THROW. A thrown domain error
//      spends the generation's single attempt rediscovering a fact that cannot
//      change.
//   3. A 429 THROWS, and marks NOTHING failed. A rate limit is an invisible
//      deferral, not an outcome the user should be told about.
//   4. THE THROTTLE BUCKET IS PER USER. One busy account must never park
//      another account's notes behind its own exhausted quota.
// =============================================================================

import { z } from 'zod';

import { AiInputError } from '../../ai/ai-errors';
import { AiProviderRegistry } from '../../ai/ai-provider.registry';
import type {
  AiDelta,
  AiGenerateRequest,
  AiProvider,
  AiProviderContext,
} from '../../ai/providers/ai-provider.interface';
import { OPENAI_PROVIDER_ID, OpenAiProvider } from '../../ai/providers/openai.provider';
import {
  resolveJobProfile,
  resolveMaxAttempts,
} from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { NOTE_GENERATE_JOB_TYPE, aiProviderThrottleKey } from '../job-types';
import {
  NOTE_GENERATE_MAX_RUNTIME_MS,
  NoteGenerateHandler,
  classify,
  describe as describeError,
  readAllowedModelEntries,
} from './note-generate.handler';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const OWNER_A = 'user-a';
const OWNER_B = 'user-b';

const policy = {
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
};

const template = {
  id: 'template-1',
  instructions: 'Write meeting notes.',
  outputFormat: 'Meeting notes',
  structure: ['Overview'],
  tone: null,
  length: null,
};

function generationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const noteId = 'note-1';

  return {
    id: 'gen-1',
    noteId,
    kind: 'create',
    status: 'pending',
    templateId: template.id,
    templateNameSnapshot: 'Meeting notes',
    contextText: null,
    sourceType: 'transcript',
    sourceTranscriptId: 'transcript-1',
    sourceNoteId: null,
    sourceObjectId: null,
    providerId: OPENAI_PROVIDER_ID,
    model: 'gpt-4o',
    content: '',
    lastEventId: 0,
    note: {
      id: noteId,
      ownerId: OWNER_A,
      title: 'Kestrel weekly',
      status: 'draft',
      currentVersion: 0,
      deletedAt: null,
    },
    ...overrides,
  };
}

const job = (payload: unknown = { generationId: 'gen-1' }) =>
  ({ id: 'job-1', payload }) as never;

/** A provider whose stream is scripted by the test. */
class FakeProvider implements AiProvider<unknown> {
  readonly id = OPENAI_PROVIDER_ID;
  readonly label = 'OpenAI';
  readonly capabilities = {
    models: [
      {
        id: 'gpt-4o',
        label: 'GPT-4o',
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        structuredOutput: false,
      },
    ],
    streaming: true as const,
    // #78: the fake implements no `listModels`, so it declares none.
    modelDiscovery: false,
  };
  readonly settingsSchema = z.unknown();
  readonly fieldDescriptors = [];

  calls = 0;
  lastRequest: AiGenerateRequest | null = null;

  constructor(
    private readonly script: () => AsyncIterable<AiDelta>,
  ) {}

  async testConnection(): Promise<never> {
    throw new Error('not used');
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  generate(_ctx: AiProviderContext<unknown>, request: AiGenerateRequest): AsyncIterable<AiDelta> {
    this.calls += 1;
    this.lastRequest = request;

    return this.script();
  }
}

/** The three deltas and a clean `done`. */
async function* helloStream(): AsyncIterable<AiDelta> {
  yield { kind: 'delta', text: '# Kestrel\n\n' };
  yield { kind: 'delta', text: 'We ship on Friday.' };
  yield {
    kind: 'done',
    finishReason: 'stop',
    usage: { promptTokens: 120, completionTokens: 8 },
  };
}

interface Harness {
  handler: NoteGenerateHandler;
  providers: AiProviderRegistry;
  throttle: ProviderThrottleService;
  generations: {
    loadForJob: jest.Mock;
    recordContext: jest.Mock;
    markStreaming: jest.Mock;
    flush: jest.Mock;
    commit: jest.Mock;
    markFailed: jest.Mock;
  };
  sources: { resolve: jest.Mock };
  credentials: { getSecret: jest.Mock };
  settings: { get: jest.Mock };
  prisma: { noteTemplate: { findUnique: jest.Mock } };
}

function harness(options: {
  provider?: AiProvider<unknown>;
  generation?: Record<string, unknown>;
  policyOverride?: Record<string, unknown>;
  apiKey?: string | null;
  sourceText?: string;
} = {}): Harness {
  const providers = new AiProviderRegistry();
  providers.register(options.provider ?? new FakeProvider(helloStream));

  const throttle = new ProviderThrottleService({
    get: () => undefined,
  } as never);

  const generations = {
    loadForJob: jest.fn().mockResolvedValue(options.generation ?? generationRow()),
    recordContext: jest.fn().mockResolvedValue(undefined),
    markStreaming: jest.fn().mockResolvedValue(undefined),
    flush: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };

  const sources = {
    resolve: jest.fn().mockResolvedValue({
      text: options.sourceText ?? 'Ana: we ship on Friday.',
      describe: 'transcript transcript-1 at version 7',
      sourceVersion: 7,
    }),
  };

  const credentials = {
    getSecret: jest
      .fn()
      .mockResolvedValue(options.apiKey === undefined ? 'sk-test' : options.apiKey),
  };

  const settings = {
    get: jest.fn().mockResolvedValue({ ...policy, ...(options.policyOverride ?? {}) }),
  };

  const prisma = {
    noteTemplate: { findUnique: jest.fn().mockResolvedValue(template) },
  };

  const handler = new NoteGenerateHandler(
    new JobHandlerRegistry(),
    prisma as never,
    providers,
    settings as never,
    credentials as never,
    generations as never,
    sources as never,
    throttle,
  );

  return { handler, providers, throttle, generations, sources, credentials, settings, prisma };
}

// -----------------------------------------------------------------------------
// Registration and shape
// -----------------------------------------------------------------------------

describe('NoteGenerateHandler — registration and profile', () => {
  it('registers itself under the permanent type string', () => {
    const registry = new JobHandlerRegistry();
    const { handler } = harness();

    (handler as unknown as { registry: JobHandlerRegistry }).registry = registry;
    handler.onModuleInit();

    expect(registry.get(NOTE_GENERATE_JOB_TYPE)).toBe(handler);
    expect(handler.type).toBe('note.generate');
  });

  it('declares ONE attempt and a ten-minute ceiling', () => {
    const { handler } = harness();

    expect(handler.profile).toEqual({
      maxRuntimeMs: NOTE_GENERATE_MAX_RUNTIME_MS,
      maxAttempts: 1,
    });
    expect(NOTE_GENERATE_MAX_RUNTIME_MS).toBe(10 * 60 * 1000);
  });

  it('carries no lease or heartbeat of its own — both are derived from maxRuntimeMs', () => {
    const { handler } = harness();

    expect(Object.keys(handler.profile ?? {}).sort()).toEqual(['maxAttempts', 'maxRuntimeMs']);
  });

  it('the QUEUE reads that one attempt — a failed run is never re-claimed', () => {
    const { handler } = harness();

    // The real resolvers the worker uses, rather than a restatement of the
    // profile: a `maxAttempts` the queue ignored would leave this type quietly
    // retrying on the deployment default and billing the user twice.
    const config = { get: jest.fn().mockReturnValue(5) };

    expect(resolveJobProfile(handler)).toEqual({
      maxRuntimeMs: NOTE_GENERATE_MAX_RUNTIME_MS,
      maxAttempts: 1,
    });
    expect(resolveMaxAttempts(config as never, handler)).toBe(1);
    // The deployment-wide default is deliberately NOT consulted.
    expect(config.get).not.toHaveBeenCalled();
  });

  it('is SERVER-ONLY: absent from the registry\'s node-eligible types', () => {
    const registry = new JobHandlerRegistry();
    const { handler } = harness();

    (handler as unknown as { registry: JobHandlerRegistry }).registry = registry;
    handler.onModuleInit();

    // Eligibility is DERIVED from these two members, never declared — and the
    // class does not even carry them, which is why they are read through the
    // interface rather than off the concrete type.
    const asHandler: JobHandler = handler;

    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
    expect(asHandler.nodeSecretBroker).toBeUndefined();

    const nodeEligible = registry
      .types()
      .filter((type) => !registry.serverOnlyTypes().includes(type));

    expect(registry.serverOnlyTypes()).toContain(NOTE_GENERATE_JOB_TYPE);
    expect(nodeEligible).not.toContain(NOTE_GENERATE_JOB_TYPE);
  });

  it('does NOT register a static throttle key at module init — the bucket is per user', () => {
    const registry = new JobHandlerRegistry();
    const { handler, throttle } = harness();

    (handler as unknown as { registry: JobHandlerRegistry }).registry = registry;
    handler.onModuleInit();

    expect(throttle.resolveKey(NOTE_GENERATE_JOB_TYPE)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The happy path
// -----------------------------------------------------------------------------

describe('NoteGenerateHandler — a successful generation', () => {
  it('streams, flushes and commits the full text', async () => {
    const provider = new FakeProvider(helloStream);
    const { handler, generations } = harness({ provider });

    await handler.process(job());

    expect(generations.markStreaming).toHaveBeenCalled();
    expect(provider.calls).toBe(1);
    expect(generations.commit).toHaveBeenCalledWith(
      expect.objectContaining({ content: '# Kestrel\n\nWe ship on Friday.' }),
    );
    expect(generations.markFailed).not.toHaveBeenCalled();
  });

  it('asks the provider for the policy-narrowed output allowance and timeout', async () => {
    const provider = new FakeProvider(helloStream);
    const { handler } = harness({ provider });

    await handler.process(job());

    expect(provider.lastRequest?.maxOutputTokens).toBe(4_000);
    expect(provider.lastRequest?.timeoutMs).toBe(60_000);
    expect(provider.lastRequest?.model).toBe('gpt-4o');
  });

  it('sends the template in the system role and the source in the user role', async () => {
    const provider = new FakeProvider(helloStream);
    const { handler } = harness({ provider, sourceText: 'Ana: we ship on Friday.' });

    await handler.process(job());

    expect(provider.lastRequest?.systemPrompt).toContain('Write meeting notes.');
    expect(provider.lastRequest?.userContent).toContain('Ana: we ship on Friday.');
  });

  // -----------------------------------------------------------------------------
  // `template.bodyFormat` (issue #334) — one value, two destinations
  // -----------------------------------------------------------------------------
  //
  // The template snapshot's bodyFormat is passed BOTH into `assemblePrompt`
  // (as `templateBodyFormat`, which shapes the system prompt's instructions)
  // AND into `commit` (which snapshots it onto the note). One read of the
  // template, two consumers — never re-derived at the second site.

  it('passes the template\'s bodyFormat into assemblePrompt as templateBodyFormat', async () => {
    const provider = new FakeProvider(helloStream);
    const { handler, prisma } = harness({ provider });

    prisma.noteTemplate.findUnique.mockResolvedValue({ ...template, bodyFormat: 'plain_text' });

    await handler.process(job());

    // `plain_text` instructions steer the model away from Markdown syntax
    // (`prompt.spec.ts` pins the exact wording); this just pins that the value
    // travelled from the template row into the assembled prompt at all.
    expect(provider.lastRequest?.systemPrompt).not.toContain('in Markdown');
    expect(provider.lastRequest?.systemPrompt).toContain('no Markdown syntax');
  });

  it('passes the template\'s bodyFormat into commit, unchanged', async () => {
    const provider = new FakeProvider(helloStream);
    const { handler, generations, prisma } = harness({ provider });

    prisma.noteTemplate.findUnique.mockResolvedValue({ ...template, bodyFormat: 'plain_text' });

    await handler.process(job());

    expect(generations.commit).toHaveBeenCalledWith(
      expect.objectContaining({ bodyFormat: 'plain_text' }),
    );
  });

  it('a template row with no bodyFormat (a build from before #334) reads as markdown in commit', async () => {
    const provider = new FakeProvider(helloStream);
    const { handler, generations } = harness({ provider });

    await handler.process(job());

    expect(generations.commit).toHaveBeenCalledWith(
      expect.objectContaining({ bodyFormat: undefined }),
    );
  });

  it('does nothing for a job naming no generation, and for one already settled', async () => {
    const { handler, generations } = harness();

    generations.loadForJob.mockResolvedValueOnce(null);
    await handler.process(job({}));

    generations.loadForJob.mockResolvedValueOnce(generationRow({ status: 'succeeded' }));
    await handler.process(job());

    expect(generations.commit).not.toHaveBeenCalled();
    expect(generations.markFailed).not.toHaveBeenCalled();
  });

  it('is a no-op for a note the owner is deleting', async () => {
    const { handler, generations } = harness({
      generation: generationRow({
        note: {
          id: 'note-1',
          ownerId: OWNER_A,
          title: 'Gone',
          status: 'deleting',
          currentVersion: 0,
          deletedAt: null,
        },
      }),
    });

    await handler.process(job());

    expect(generations.markStreaming).not.toHaveBeenCalled();
    expect(generations.commit).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// The budget, checked BEFORE any provider call
// -----------------------------------------------------------------------------

describe('NoteGenerateHandler — the token budget', () => {
  it('refuses an over-budget prompt WITHOUT touching the provider', async () => {
    // The REAL OpenAI provider over a fetch seam that fails the test if called.
    const fetchSeam = jest.fn(() => {
      throw new Error('the provider must not be called for an over-budget prompt');
    });

    const provider = new OpenAiProvider(new AiProviderRegistry(), fetchSeam as never);

    const { handler, generations } = harness({
      provider,
      // A deployment ceiling far under the assembled prompt.
      policyOverride: { maxInputTokens: 256 },
      sourceText: 'word '.repeat(5_000),
    });

    await handler.process(job());

    expect(fetchSeam).not.toHaveBeenCalled();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal', category: 'Too large' }),
    );
    // NEVER TRUNCATED: nothing was committed at all.
    expect(generations.commit).not.toHaveBeenCalled();
  });

  it('names the actual and the permitted sizes in the reason', async () => {
    const fetchSeam = jest.fn(() => {
      throw new Error('must not be called');
    });

    const { handler, generations } = harness({
      provider: new OpenAiProvider(new AiProviderRegistry(), fetchSeam as never),
      policyOverride: { maxInputTokens: 256 },
      sourceText: 'word '.repeat(5_000),
    });

    await handler.process(job());

    const reason = generations.markFailed.mock.calls[0][0].reason as string;

    expect(reason).toMatch(/\d/);
    expect(reason).toContain('gpt-4o');
  });

  it('never marks the generation streaming when the budget refuses', async () => {
    const fetchSeam = jest.fn();
    const { handler, generations } = harness({
      provider: new OpenAiProvider(new AiProviderRegistry(), fetchSeam as never),
      policyOverride: { maxInputTokens: 256 },
      sourceText: 'word '.repeat(5_000),
    });

    await handler.process(job());

    expect(generations.markStreaming).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Failure classes
// -----------------------------------------------------------------------------

describe('NoteGenerateHandler — domain failures return, they do not throw', () => {
  it('AiAuthError: no stored key for this user', async () => {
    const { handler, generations } = harness({ apiKey: null });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'auth', category: 'Your API key' }),
    );
  });

  it('AiInputError: a model this deployment does not permit', async () => {
    const { handler, generations } = harness({
      generation: generationRow({ model: 'gpt-5-ultra' }),
    });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal' }),
    );
    expect(generations.markFailed.mock.calls[0][0].reason).toContain('gpt-5-ultra');
  });

  it('AiInputError: AI switched off for the deployment', async () => {
    const { handler, generations } = harness({ policyOverride: { enabled: false } });

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal' }),
    );
  });

  it('AiInputError: the template was deleted between the request and the job', async () => {
    const { handler, generations, prisma } = harness();

    prisma.noteTemplate.findUnique.mockResolvedValue(null);

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(generations.markFailed.mock.calls[0][0].reason).toContain('Meeting notes');
  });

  it('AiRefusedError: a content-filter finish reason is not a note', async () => {
    async function* filtered(): AsyncIterable<AiDelta> {
      yield { kind: 'delta', text: 'I cannot' };
      yield {
        kind: 'done',
        finishReason: 'content_filter',
        usage: { promptTokens: 10, completionTokens: 2 },
      };
    }

    const { handler, generations } = harness({ provider: new FakeProvider(filtered) });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal', category: 'Declined by the provider' }),
    );
    expect(generations.commit).not.toHaveBeenCalled();
  });

  it('AiRefusedError: an empty completion is never committed as a ready note', async () => {
    async function* empty(): AsyncIterable<AiDelta> {
      yield {
        kind: 'done',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 0 },
      };
    }

    const { handler, generations } = harness({ provider: new FakeProvider(empty) });

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(generations.commit).not.toHaveBeenCalled();
    expect(generations.markFailed).toHaveBeenCalled();
  });

  it('a domain failure raised by source resolution is recorded, not thrown', async () => {
    const { handler, generations, sources } = harness();

    sources.resolve.mockRejectedValue(new AiInputError('The transcript is gone.'));

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(generations.markFailed.mock.calls[0][0].reason).toBe('The transcript is gone.');
  });
});

describe('NoteGenerateHandler — rate limits and unexpected errors', () => {
  it('rethrows a 429 and marks NOTHING failed', async () => {
    async function* limited(): AsyncIterable<AiDelta> {
      throw new RateLimitError('Rate limited by the provider', 30_000);
      // eslint-disable-next-line no-unreachable
      yield { kind: 'delta', text: 'unreachable' };
    }

    const { handler, generations } = harness({ provider: new FakeProvider(limited) });

    await expect(handler.process(job())).rejects.toBeInstanceOf(RateLimitError);

    expect(generations.markFailed).not.toHaveBeenCalled();
    expect(generations.commit).not.toHaveBeenCalled();
  });

  it('records AND rethrows an unrecognised failure, with no vendor text in the reason', async () => {
    async function* broken(): AsyncIterable<AiDelta> {
      throw new Error('socket hang up at postgres://user:pw@host/db');
      // eslint-disable-next-line no-unreachable
      yield { kind: 'delta', text: 'unreachable' };
    }

    const { handler, generations } = harness({ provider: new FakeProvider(broken) });

    await expect(handler.process(job())).rejects.toThrow('socket hang up');

    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'other' }),
    );
    expect(generations.markFailed.mock.calls[0][0].reason).not.toContain('postgres://');
  });
});

// -----------------------------------------------------------------------------
// The throttle bucket is PER USER
// -----------------------------------------------------------------------------

describe('NoteGenerateHandler — the per-user throttle key', () => {
  it('registers `ai-provider:<userId>` for the owner of the note being generated', async () => {
    const { handler, throttle } = harness();

    await handler.process(job());

    expect(throttle.resolveKey(NOTE_GENERATE_JOB_TYPE)).toBe(aiProviderThrottleKey(OWNER_A));
  });

  it('two users do NOT share a bucket', async () => {
    const { handler, throttle, generations } = harness();

    await handler.process(job());
    expect(throttle.resolveKey(NOTE_GENERATE_JOB_TYPE)).toBe('ai-provider:user-a');

    // User A's account is throttled. Their bucket cools down.
    throttle.trip(NOTE_GENERATE_JOB_TYPE, 60_000);
    expect(throttle.isCoolingDown(NOTE_GENERATE_JOB_TYPE)).toBe(true);

    // User B's generation runs against their OWN vendor account.
    generations.loadForJob.mockResolvedValue(
      generationRow({
        id: 'gen-2',
        note: {
          id: 'note-2',
          ownerId: OWNER_B,
          title: "B's note",
          status: 'draft',
          currentVersion: 0,
          deletedAt: null,
        },
      }),
    );

    await handler.process(job({ generationId: 'gen-2' }));

    expect(throttle.resolveKey(NOTE_GENERATE_JOB_TYPE)).toBe('ai-provider:user-b');
    // ⚠ THE ASSERTION: A's exhausted quota does not park B's work.
    expect(throttle.isCoolingDown(NOTE_GENERATE_JOB_TYPE)).toBe(false);
  });

  it('derives distinct keys per user', () => {
    expect(aiProviderThrottleKey(OWNER_A)).toBe('ai-provider:user-a');
    expect(aiProviderThrottleKey(OWNER_A)).not.toBe(aiProviderThrottleKey(OWNER_B));
  });

  it('registers the key only after the budget check has passed', async () => {
    const { handler, throttle } = harness({
      provider: new OpenAiProvider(new AiProviderRegistry(), jest.fn() as never),
      policyOverride: { maxInputTokens: 256 },
      sourceText: 'word '.repeat(5_000),
    });

    await handler.process(job());

    expect(throttle.resolveKey(NOTE_GENERATE_JOB_TYPE)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// recordContext() — the snapshot of what was about to be sent (issue #307)
// -----------------------------------------------------------------------------

describe('NoteGenerateHandler — recordContext (#307)', () => {
  it('records the EXACT systemPrompt/userContent the provider receives, plus sourceVersion', async () => {
    const provider = new FakeProvider(helloStream);
    const { handler, generations } = harness({ provider, sourceText: 'Ana: we ship on Friday.' });

    await handler.process(job());

    expect(generations.recordContext).toHaveBeenCalledWith('gen-1', {
      systemPrompt: provider.lastRequest?.systemPrompt,
      userContent: provider.lastRequest?.userContent,
      sourceVersion: 7,
    });
  });

  it('is called BEFORE the provider — recordContext precedes provider.generate', async () => {
    const order: string[] = [];
    const provider = new FakeProvider(helloStream);
    const { handler, generations } = harness({ provider });

    generations.recordContext.mockImplementation(async () => {
      order.push('recordContext');
    });

    const originalGenerate = provider.generate.bind(provider);
    jest.spyOn(provider, 'generate').mockImplementation((...args) => {
      order.push('provider.generate');

      return originalGenerate(...args);
    });

    await handler.process(job());

    expect(order).toEqual(['recordContext', 'provider.generate']);
  });

  it('is called BEFORE markStreaming too', async () => {
    const order: string[] = [];
    const { handler, generations } = harness();

    generations.recordContext.mockImplementation(async () => {
      order.push('recordContext');
    });
    generations.markStreaming.mockImplementation(async () => {
      order.push('markStreaming');
    });

    await handler.process(job());

    expect(order).toEqual(['recordContext', 'markStreaming']);
  });

  it('is still recorded when the provider then fails (an auth-shaped refusal)', async () => {
    async function* filtered(): AsyncIterable<AiDelta> {
      yield { kind: 'delta', text: 'I cannot' };
      yield {
        kind: 'done',
        finishReason: 'content_filter',
        usage: { promptTokens: 10, completionTokens: 2 },
      };
    }

    const { handler, generations } = harness({ provider: new FakeProvider(filtered) });

    await handler.process(job());

    expect(generations.recordContext).toHaveBeenCalled();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal' }),
    );
  });

  it('is still recorded when the provider stream throws mid-flight (an unrecognised/timeout-ish failure)', async () => {
    async function* broken(): AsyncIterable<AiDelta> {
      yield { kind: 'delta', text: 'partial' };
      throw new Error('stream timed out');
      // eslint-disable-next-line no-unreachable
      yield { kind: 'delta', text: 'unreachable' };
    }

    const { handler, generations } = harness({ provider: new FakeProvider(broken) });

    await expect(handler.process(job())).rejects.toThrow('stream timed out');

    expect(generations.recordContext).toHaveBeenCalled();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'other' }),
    );
  });

  it('is NOT called when an AiBudgetError is thrown — a refusal sends nothing, so it records nothing', async () => {
    const fetchSeam = jest.fn(() => {
      throw new Error('the provider must not be called for an over-budget prompt');
    });

    const { handler, generations } = harness({
      provider: new OpenAiProvider(new AiProviderRegistry(), fetchSeam as never),
      policyOverride: { maxInputTokens: 256 },
      sourceText: 'word '.repeat(5_000),
    });

    await handler.process(job());

    expect(generations.recordContext).not.toHaveBeenCalled();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal', category: 'Too large' }),
    );
  });

  it('records the context for a PREVIEW generation (kind: preview) too', async () => {
    const provider = new FakeProvider(helloStream);
    const { handler, generations } = harness({
      provider,
      generation: generationRow({ id: 'gen-preview', kind: 'preview', noteId: null, note: null }),
    });

    await handler.process(job({ generationId: 'gen-preview', userId: OWNER_A }));

    expect(generations.recordContext).toHaveBeenCalledWith(
      'gen-preview',
      expect.objectContaining({ sourceVersion: 7 }),
    );
  });
});

// -----------------------------------------------------------------------------
// The classifier and its helpers
// -----------------------------------------------------------------------------

describe('classify / describe', () => {
  it('files an unknown throw under `other`, which is the class that rethrows', () => {
    expect(classify(new Error('boom')).errorClass).toBe('other');
    expect(classify('a string').errorClass).toBe('other');
    expect(classify(null).errorClass).toBe('other');
  });

  it('never echoes an unknown error message to the user', () => {
    expect(describeError(new Error('at /srv/app/dist/main.js:12'))).not.toContain('/srv');
  });
});

describe('readAllowedModelEntries', () => {
  it('reads the allow-list out of the settings blob', () => {
    expect(readAllowedModelEntries(policy.providers, 'openai')).toEqual([
      { id: 'gpt-4o', label: undefined, contextWindowTokens: undefined, maxOutputTokens: undefined },
    ]);
  });

  it('permits NOTHING when the blob cannot be read — the safe direction is closed', () => {
    expect(readAllowedModelEntries(null, 'openai')).toEqual([]);
    expect(readAllowedModelEntries({}, 'openai')).toEqual([]);
    expect(readAllowedModelEntries({ openai: 'nope' }, 'openai')).toEqual([]);
    expect(
      readAllowedModelEntries({ openai: { allowedModels: 'gpt-4o' } }, 'openai'),
    ).toEqual([]);
    expect(
      readAllowedModelEntries({ openai: { allowedModels: [1, 'gpt-4o'] } }, 'openai'),
    ).toEqual([
      { id: 'gpt-4o', label: undefined, contextWindowTokens: undefined, maxOutputTokens: undefined },
    ]);
  });
});
