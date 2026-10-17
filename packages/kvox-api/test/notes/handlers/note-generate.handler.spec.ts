import { KvoxAiError, KvoxRateLimitError, type KvoxAiTarget, type KvoxJobHandler, type KvoxTextEvent } from '../../../src/ports/index.js';
import { createFakeKvoxAi, createFakeKvoxJobs, type FakeKvoxAi } from '../../../src/testing/index.js';
import { aiProviderThrottleKey } from '../../../src/core/index.js';
import { NOTE_GENERATE_JOB_TYPE } from '../../../src/notes/job-types.js';
import { NoteInputError } from '../../../src/notes/generation/ai-support.js';
import {
  NOTE_GENERATE_MAX_RUNTIME_MS,
  NoteGenerateHandler,
  classify,
  describe as describeError,
} from '../../../src/notes/handlers/note-generate.handler.js';
import { resolveNotesOptions } from '../../../src/notes/notes.options.js';

// =============================================================================
// `note.generate` (issue #49, epic #45, docs/specs/notes.md §1-§5)
// =============================================================================
//
// Four assertions in this file are the ones a later refactor is most likely to
// break without noticing:
//
//   1. THE BUDGET IS CHECKED BEFORE THE PROVIDER IS TOUCHED. Asserted by the
//      AI port fake recording no `generateText` call — a check that ran "during"
//      would still refuse the job, but the user would already have been billed
//      for the input tokens.
//   2. EVERY DOMAIN CLASS RETURNS, IT DOES NOT THROW. A thrown domain error
//      spends the generation's single attempt rediscovering a fact that cannot
//      change.
//   3. A 429 THROWS (as a `KvoxRateLimitError` on the user's bucket), and marks NOTHING failed. A rate limit is an invisible
//      deferral, not an outcome the user should be told about.
//   4. THE THROTTLE BUCKET IS PER USER. One busy account must never park
//      another account's notes behind its own exhausted quota.
// =============================================================================

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const OWNER_A = 'user-a';
const OWNER_B = 'user-b';

/** The deployment's two spend caps, as `ai.maxInputTokens` / `ai.maxOutputTokens`. */
const caps = {
  maxInputTokens: 100_000,
  maxOutputTokens: 4_000,
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
    providerId: 'openai',
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

/** The three deltas of a clean completion. */
const HELLO = ['# Kestrel\n\n', 'We ship on Friday.'];

interface Harness {
  handler: NoteGenerateHandler;
  ai: FakeKvoxAi;
  jobs: ReturnType<typeof createFakeKvoxJobs>;
  generations: {
    loadForJob: jest.Mock;
    recordContext: jest.Mock;
    markStreaming: jest.Mock;
    flush: jest.Mock;
    commit: jest.Mock;
    markFailed: jest.Mock;
  };
  sources: { resolve: jest.Mock };
  settings: { readSystem: jest.Mock };
  prisma: { noteTemplate: { findUnique: jest.Mock } };
}

function harness(options: {
  ai?: FakeKvoxAi;
  target?: Partial<KvoxAiTarget>;
  generation?: Record<string, unknown>;
  capsOverride?: Record<string, unknown>;
  sourceText?: string;
} = {}): Harness {
  const ai = options.ai ?? createFakeKvoxAi({ script: { text: HELLO, target: { provider: 'openai', ...options.target } } });

  const jobs = createFakeKvoxJobs();

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

  const settings = {
    readSystem: jest.fn().mockResolvedValue({ value: { ...caps, ...(options.capsOverride ?? {}) }, version: 1 }),
  };

  const prisma = {
    noteTemplate: { findUnique: jest.fn().mockResolvedValue(template) },
  };

  const handler = new NoteGenerateHandler(
    jobs,
    prisma as never,
    ai,
    settings as never,
    resolveNotesOptions({}),
    generations as never,
    sources as never,
  );

  return { handler, ai, jobs, generations, sources, settings, prisma };
}

/** The single `generateText` request the handler made. */
function streamRequest(ai: FakeKvoxAi): { system: string; user: string; maxOutputTokens?: number; target: KvoxAiTarget } {
  return ai.calls.filter((call) => call.method === 'generateText').at(-1)?.req as never;
}

const generateCalls = (ai: FakeKvoxAi) => ai.calls.filter((call) => call.method === 'generateText');

/** Replaces the model's stream: the deltas, then (optionally) a failure or a custom `done`. */
function streaming(
  ai: FakeKvoxAi,
  script: { deltas?: string[]; failAfter?: Error; done?: Extract<KvoxTextEvent, { type: 'done' }> },
): FakeKvoxAi {
  ai.generateText = async function* () {
    for (const text of script.deltas ?? []) yield { type: 'delta', text };

    if (script.failAfter) throw script.failAfter;

    yield script.done ?? { type: 'done', usage: { inputTokens: 120, outputTokens: 8 }, finishReason: 'stop' };
  };

  return ai;
}

describe('NoteGenerateHandler — registration and profile', () => {
  it('registers itself under the permanent type string with the job port', () => {
    const { handler, jobs } = harness();

    handler.onModuleInit();

    expect(jobs.isRegistered(NOTE_GENERATE_JOB_TYPE)).toBe(true);
    expect(jobs.handlers).toContain(handler);
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

  it('is SERVER-ONLY: it spends the owner\'s own key, so it declares usesAi and neither node member', () => {
    const { handler } = harness();

    expect(handler.usesAi).toBe(true);
    const members = handler as KvoxJobHandler;

    expect(members.nodeResultSchema).toBeUndefined();
    expect(members.persistNodeResult).toBeUndefined();
    expect(members.deriveOutputKey).toBeUndefined();
  });

  it('does NOT declare a static throttle key — the bucket is per user and named when a 429 happens', () => {
    const { handler } = harness();

    expect((handler as KvoxJobHandler).throttleKey).toBeUndefined();
  });
});

describe('NoteGenerateHandler — a successful generation', () => {
  it('streams, flushes and commits the full text', async () => {
    const { handler, ai, generations } = harness();

    await handler.process(job());

    expect(generations.markStreaming).toHaveBeenCalled();
    expect(generateCalls(ai)).toHaveLength(1);
    expect(generations.commit).toHaveBeenCalledWith(
      expect.objectContaining({ content: '# Kestrel\n\nWe ship on Friday.' }),
    );
    expect(generations.markFailed).not.toHaveBeenCalled();
  });

  it('commits the provider\'s own token counts, and an estimate when it reported none', async () => {
    const reported = harness({ ai: streaming(createFakeKvoxAi({ script: { target: { provider: 'openai' } } }), { deltas: HELLO }) });
    await reported.handler.process(job());
    expect(reported.generations.commit).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 120, completionTokens: 8, providerLabel: 'OpenAI' }),
    );

    const silent = harness({
      ai: streaming(createFakeKvoxAi({ script: { target: { provider: 'openai' } } }), {
        deltas: ['Some text.'],
        done: { type: 'done', usage: { inputTokens: null, outputTokens: null }, finishReason: 'stop' },
      }),
    });
    await silent.handler.process(job());
    const committed = silent.generations.commit.mock.calls[0][0];
    expect(committed.promptTokens).toBeGreaterThan(0);
    expect(committed.completionTokens).toBeNull();
  });

  it('resolves the notes.generate task for the owner and the generation\'s model, and streams on that target', async () => {
    const { handler, ai } = harness();

    await handler.process(job());

    expect(ai.calls.find((call) => call.method === 'resolveTask')).toMatchObject({
      ctx: { userId: OWNER_A, orgId: null, feature: 'notes.generate' },
      req: { task: 'notes.generate', model: 'gpt-4o' },
    });
    expect(ai.calls.find((call) => call.method === 'generateText')?.ctx).toMatchObject({
      userId: OWNER_A,
      feature: 'notes.generate',
    });
    expect(streamRequest(ai).target.model).toBe('gpt-4o');
  });

  it('asks the port for the policy-narrowed output allowance', async () => {
    const { handler, ai } = harness();

    await handler.process(job());

    expect(streamRequest(ai).maxOutputTokens).toBe(4_000);
  });

  it('sends the template in the system role and the source in the user role', async () => {
    const { handler, ai } = harness({ sourceText: 'Ana: we ship on Friday.' });

    await handler.process(job());

    expect(streamRequest(ai).system).toContain('Write meeting notes.');
    expect(streamRequest(ai).user).toContain('Ana: we ship on Friday.');
  });

  it('passes the template\'s bodyFormat into assemblePrompt as templateBodyFormat', async () => {
    const { handler, ai, prisma } = harness();

    prisma.noteTemplate.findUnique.mockResolvedValue({ ...template, bodyFormat: 'plain_text' });

    await handler.process(job());

    expect(streamRequest(ai).system).not.toContain('in Markdown');
    expect(streamRequest(ai).system).toContain('no Markdown syntax');
  });

  it('passes the template\'s bodyFormat into commit, unchanged', async () => {
    const { handler, generations, prisma } = harness();

    prisma.noteTemplate.findUnique.mockResolvedValue({ ...template, bodyFormat: 'plain_text' });

    await handler.process(job());

    expect(generations.commit).toHaveBeenCalledWith(
      expect.objectContaining({ bodyFormat: 'plain_text' }),
    );
  });

  it('a template row with no bodyFormat (a build from before #334) reads as markdown in commit', async () => {
    const { handler, generations } = harness();

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

describe('NoteGenerateHandler — the token budget', () => {
  const OVER = { capsOverride: { maxInputTokens: 256 }, sourceText: 'word '.repeat(5_000) };

  it('refuses an over-budget prompt WITHOUT touching the provider', async () => {
    const { handler, ai, generations } = harness(OVER);

    await handler.process(job());

    expect(generateCalls(ai)).toHaveLength(0);
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal', category: 'Too large' }),
    );
    expect(generations.commit).not.toHaveBeenCalled();
  });

  it('names the actual and the permitted sizes in the reason', async () => {
    const { handler, generations } = harness(OVER);

    await handler.process(job());

    const reason = generations.markFailed.mock.calls[0][0].reason as string;

    expect(reason).toMatch(/\d/);
    expect(reason).toContain('gpt-4o');
    expect(reason).toContain('256');
  });

  it('never marks the generation streaming when the budget refuses', async () => {
    const { handler, generations } = harness(OVER);

    await handler.process(job());

    expect(generations.markStreaming).not.toHaveBeenCalled();
  });

  it('refuses, before any call, a model with no recorded context window', async () => {
    const { handler, ai, generations } = harness({ target: { contextWindowTokens: 0, maxOutputTokens: 0 } });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(generateCalls(ai)).toHaveLength(0);
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal' }),
    );
    expect(generations.markFailed.mock.calls[0][0].reason).toContain('context window');
  });
});

describe('NoteGenerateHandler — domain failures return, they do not throw', () => {
  it('no stored key for this user (key_missing)', async () => {
    const { handler, ai, generations } = harness({ ai: createFakeKvoxAi({ script: { failWith: 'key_missing' } }) });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'auth', category: 'Your API key' }),
    );
    expect(generations.markFailed.mock.calls[0][0].reason).toContain('OpenAI API key');
    expect(generateCalls(ai)).toHaveLength(0);
  });

  it('a model this deployment does not permit (capability)', async () => {
    const { handler, generations } = harness({
      ai: createFakeKvoxAi({ script: { failWith: 'capability' } }),
      generation: generationRow({ model: 'gpt-5-ultra' }),
    });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal' }),
    );
    expect(generations.markFailed.mock.calls[0][0].reason).toContain('gpt-5-ultra');
  });

  it('AI switched off for the deployment (not_configured)', async () => {
    const { handler, generations } = harness({ ai: createFakeKvoxAi({ script: { failWith: 'not_configured' } }) });

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal' }),
    );
  });

  it('the template was deleted between the request and the job', async () => {
    const { handler, generations, prisma } = harness();

    prisma.noteTemplate.findUnique.mockResolvedValue(null);

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(generations.markFailed.mock.calls[0][0].reason).toContain('Meeting notes');
  });

  it('a content-policy refusal is not a note', async () => {
    const ai = streaming(createFakeKvoxAi({ script: { target: { provider: 'openai' } } }), {
      deltas: ['I cannot'],
      failAfter: new KvoxAiError('refusal', 'The provider declined to answer.'),
    });
    const { handler, generations } = harness({ ai });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal', category: 'Declined by the provider' }),
    );
    expect(generations.commit).not.toHaveBeenCalled();
  });

  it('an empty completion is never committed as a ready note', async () => {
    const { handler, generations } = harness({
      ai: streaming(createFakeKvoxAi({ script: { target: { provider: 'openai' } } }), { deltas: [] }),
    });

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(generations.commit).not.toHaveBeenCalled();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal', category: 'Declined by the provider' }),
    );
  });

  it('a domain failure raised by source resolution is recorded, not thrown', async () => {
    const { handler, generations, sources } = harness();

    sources.resolve.mockRejectedValue(new NoteInputError('The transcript is gone.'));

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(generations.markFailed.mock.calls[0][0].reason).toBe('The transcript is gone.');
  });
});

describe('NoteGenerateHandler — rate limits and unexpected errors', () => {
  it('turns a provider 429 into a deferral on THIS user\'s bucket and marks NOTHING failed', async () => {
    const ai = streaming(createFakeKvoxAi({ script: { target: { provider: 'openai' } } }), {
      failAfter: new KvoxAiError('rate_limit', 'Rate limited by the provider', 30_000),
    });
    const { handler, generations } = harness({ ai });

    const error = await handler.process(job()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(KvoxRateLimitError);
    expect((error as KvoxRateLimitError).throttleKey).toBe(aiProviderThrottleKey(OWNER_A));
    expect((error as KvoxRateLimitError).retryAfterMs).toBe(30_000);
    expect(generations.markFailed).not.toHaveBeenCalled();
    expect(generations.commit).not.toHaveBeenCalled();
  });

  it('records AND rethrows an unrecognised failure, with no vendor text in the reason', async () => {
    const ai = streaming(createFakeKvoxAi({ script: { target: { provider: 'openai' } } }), {
      failAfter: new Error('socket hang up at postgres://user:pw@host/db'),
    });
    const { handler, generations } = harness({ ai });

    await expect(handler.process(job())).rejects.toThrow('socket hang up');

    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'other' }),
    );
    expect(generations.markFailed.mock.calls[0][0].reason).not.toContain('postgres://');
  });
});

describe('NoteGenerateHandler — the per-user throttle key', () => {
  it('two users get two buckets: a 429 against one never defers the other', async () => {
    const limited = (ownerId: string) => {
      const ai = streaming(createFakeKvoxAi({ script: { target: { provider: 'openai' } } }), {
        failAfter: new KvoxAiError('rate_limit', 'slow down'),
      });

      return harness({
        ai,
        generation: generationRow({
          note: { id: 'note-x', ownerId, title: 't', status: 'draft', currentVersion: 0, deletedAt: null },
        }),
      }).handler.process(job()).then(
        () => undefined as never,
        (thrown: unknown) => thrown as KvoxRateLimitError,
      );
    };

    const [a, b] = await Promise.all([limited(OWNER_A), limited(OWNER_B)]);

    expect(a.throttleKey).toBe('ai-provider:user-a');
    expect(b.throttleKey).toBe('ai-provider:user-b');
    expect(a.throttleKey).not.toBe(b.throttleKey);
  });

  it('a preview, which has no note, takes the user from the job payload', async () => {
    const ai = streaming(createFakeKvoxAi({ script: { target: { provider: 'openai' } } }), {
      failAfter: new KvoxAiError('rate_limit', 'slow down'),
    });
    const { handler } = harness({ ai, generation: generationRow({ noteId: null, note: null, kind: 'preview' }) });

    const error = (await handler
      .process(job({ generationId: 'gen-1', userId: OWNER_B }))
      .catch((thrown: unknown) => thrown)) as KvoxRateLimitError;

    expect(error.throttleKey).toBe('ai-provider:user-b');
  });

  it('derives distinct keys per user', () => {
    expect(aiProviderThrottleKey(OWNER_A)).toBe('ai-provider:user-a');
    expect(aiProviderThrottleKey(OWNER_A)).not.toBe(aiProviderThrottleKey(OWNER_B));
  });
});

describe('NoteGenerateHandler — recordContext (#307)', () => {
  it('records the EXACT system/user prompt the port receives, plus sourceVersion', async () => {
    const { handler, ai, generations } = harness({ sourceText: 'Ana: we ship on Friday.' });

    await handler.process(job());

    expect(generations.recordContext).toHaveBeenCalledWith('gen-1', {
      systemPrompt: streamRequest(ai).system,
      userContent: streamRequest(ai).user,
      sourceVersion: 7,
    });
  });

  it('is called BEFORE the provider — recordContext precedes generateText', async () => {
    const order: string[] = [];
    const { handler, ai, generations } = harness();

    generations.recordContext.mockImplementation(async () => {
      order.push('recordContext');
    });

    const original = ai.generateText.bind(ai);
    ai.generateText = (ctx, req) => {
      order.push('generateText');

      return original(ctx, req);
    };

    await handler.process(job());

    expect(order).toEqual(['recordContext', 'generateText']);
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

  it('is still recorded when the provider then refuses', async () => {
    const ai = streaming(createFakeKvoxAi({ script: { target: { provider: 'openai' } } }), {
      failAfter: new KvoxAiError('refusal', 'Declined.'),
    });
    const { handler, generations } = harness({ ai });

    await handler.process(job());

    expect(generations.recordContext).toHaveBeenCalled();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal' }),
    );
  });

  it('is still recorded when the stream throws mid-flight (an unrecognised/timeout-ish failure)', async () => {
    const ai = streaming(createFakeKvoxAi({ script: { target: { provider: 'openai' } } }), {
      deltas: ['partial'],
      failAfter: new Error('stream timed out'),
    });
    const { handler, generations } = harness({ ai });

    await expect(handler.process(job())).rejects.toThrow('stream timed out');

    expect(generations.recordContext).toHaveBeenCalled();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'other' }),
    );
  });

  it('is NOT called when the budget refuses — a refusal sends nothing, so it records nothing', async () => {
    const { handler, generations } = harness({
      capsOverride: { maxInputTokens: 256 },
      sourceText: 'word '.repeat(5_000),
    });

    await handler.process(job());

    expect(generations.recordContext).not.toHaveBeenCalled();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal', category: 'Too large' }),
    );
  });

  it('records the context for a PREVIEW generation (kind: preview) too', async () => {
    const { handler, generations } = harness({
      generation: generationRow({ id: 'gen-preview', kind: 'preview', noteId: null, note: null }),
    });

    await handler.process(job({ generationId: 'gen-preview', userId: OWNER_A }));

    expect(generations.recordContext).toHaveBeenCalledWith(
      'gen-preview',
      expect.objectContaining({ sourceVersion: 7 }),
    );
  });
});

describe('classify / describe', () => {
  it('files an unknown throw under `other`, which is the class that rethrows', () => {
    expect(classify(new Error('boom')).errorClass).toBe('other');
    expect(classify('a string').errorClass).toBe('other');
    expect(classify(null).errorClass).toBe('other');
  });

  it('files the port\'s error classes where the old domain classes went', () => {
    expect(classify(new KvoxAiError('auth', 'x'))).toEqual({ errorClass: 'auth', category: 'Your API key' });
    expect(classify(new KvoxAiError('key_missing', 'x'))).toEqual({ errorClass: 'auth', category: 'Your API key' });
    expect(classify(new KvoxAiError('budget', 'x'))).toEqual({ errorClass: 'refusal', category: 'Too large' });
    expect(classify(new KvoxAiError('refusal', 'x'))).toEqual({ errorClass: 'refusal', category: 'Declined by the provider' });
    expect(classify(new KvoxAiError('not_configured', 'x')).category).toBe('This request');
    expect(classify(new NoteInputError('x')).category).toBe('This request');
    expect(classify(new KvoxAiError('timeout', 'x')).errorClass).toBe('other');
  });

  it('never echoes an unknown error message to the user', () => {
    expect(describeError(new Error('at /srv/app/dist/main.js:12'))).not.toContain('/srv');
    expect(describeError(new KvoxAiError('other', 'a vendor stack trace'))).not.toContain('vendor');
  });
});
