// =============================================================================
// `note.generate` (issue #49, epic #45, docs/specs/notes.md §1-§5)
// =============================================================================
//
// Four assertions in this file are the ones a later refactor is most likely to
// break without noticing:
//
//   1. THE BUDGET IS CHECKED BEFORE THE PROVIDER IS TOUCHED. Asserted by the
//      `KvoxAi` fake recording no `streamText` call — a check that ran "during"
//      would still refuse the job, but the user would already have been billed
//      for the input tokens.
//   2. EVERY DOMAIN CLASS RETURNS, IT DOES NOT THROW. A thrown domain error
//      spends the generation's single attempt rediscovering a fact that cannot
//      change.
//   3. A 429 THROWS, and marks NOTHING failed. A rate limit is an invisible
//      deferral, not an outcome the user should be told about.
//   4. THE THROTTLE BUCKET IS PER USER. One busy account must never park
//      another account's notes behind its own exhausted quota.
// =============================================================================

import { AiInputError, AiRefusedError } from '../../ai-port/ai-errors';
import {
  FakeKvoxAi,
  notReadyReadiness,
  readyReadiness,
} from '../../ai-port/testing/fake-kvox-ai';
import { NOTE_GENERATE_JOB_TYPE, aiProviderThrottleKey } from '../job-types';
import {
  NOTE_GENERATE_MAX_RUNTIME_MS,
  NoteGenerateHandler,
  classify,
  describe as describeError,
} from './note-generate.handler';
import { type JobHandler, JobHandlerRegistry, ProviderThrottleService, RateLimitError, resolveJobProfile, resolveMaxAttempts } from '@marinoscar/platform-api/jobs';

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

/** The three deltas and a clean `done` with the provider's own counts. */
const HELLO = {
  deltas: ['# Kestrel\n\n', 'We ship on Friday.'],
  usage: { inputTokens: 120, outputTokens: 8 },
};

interface Harness {
  handler: NoteGenerateHandler;
  ai: FakeKvoxAi;
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
  settings: { get: jest.Mock };
  prisma: { noteTemplate: { findUnique: jest.Mock } };
}

function harness(options: {
  ai?: FakeKvoxAi;
  generation?: Record<string, unknown>;
  capsOverride?: Record<string, unknown>;
  sourceText?: string;
} = {}): Harness {
  const ai = options.ai ?? new FakeKvoxAi().queueStream(HELLO);

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

  const settings = {
    get: jest.fn().mockResolvedValue({ ...caps, ...(options.capsOverride ?? {}) }),
  };

  const prisma = {
    noteTemplate: { findUnique: jest.fn().mockResolvedValue(template) },
  };

  const handler = new NoteGenerateHandler(
    new JobHandlerRegistry(),
    prisma as never,
    ai,
    settings as never,
    generations as never,
    sources as never,
    throttle,
  );

  return { handler, ai, throttle, generations, sources, settings, prisma };
}

/** The single `streamText` request the handler made. */
function streamRequest(ai: FakeKvoxAi): { system: string; user: string; maxOutputTokens?: number; model?: string | null } {
  return ai.lastCall('streamText')?.request as never;
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
    const { handler, ai, generations } = harness();

    await handler.process(job());

    expect(generations.markStreaming).toHaveBeenCalled();
    expect(ai.callsOf('streamText')).toHaveLength(1);
    expect(generations.commit).toHaveBeenCalledWith(
      expect.objectContaining({ content: '# Kestrel\n\nWe ship on Friday.' }),
    );
    expect(generations.markFailed).not.toHaveBeenCalled();
  });

  it('commits the provider\'s own token counts, and an estimate when it reported none', async () => {
    const reported = harness();
    await reported.handler.process(job());
    expect(reported.generations.commit).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 120, completionTokens: 8, providerLabel: 'OpenAI' }),
    );

    // An absent usage is `null`, never `0`: the prompt falls back to this build's
    // estimate and the completion stays unreported.
    const silent = harness({ ai: new FakeKvoxAi().queueStream({ deltas: ['Some text.'] }) });
    await silent.handler.process(job());
    const committed = silent.generations.commit.mock.calls[0][0];
    expect(committed.promptTokens).toBeGreaterThan(0);
    expect(committed.completionTokens).toBeNull();
  });

  it('passes the feature, the job id, the user and the generation\'s model to the port', async () => {
    const { handler, ai } = harness();

    await handler.process(job());

    expect(ai.lastCall('streamText')).toMatchObject({
      userId: OWNER_A,
      feature: 'note_generate',
      jobId: 'job-1',
      model: 'gpt-4o',
    });
    expect(ai.lastCall('readiness')).toMatchObject({
      userId: OWNER_A,
      feature: 'note_generate',
      model: 'gpt-4o',
    });
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

  // -----------------------------------------------------------------------------
  // `template.bodyFormat` (issue #334) — one value, two destinations
  // -----------------------------------------------------------------------------
  //
  // The template snapshot's bodyFormat is passed BOTH into `assemblePrompt`
  // (as `templateBodyFormat`, which shapes the system prompt's instructions)
  // AND into `commit` (which snapshots it onto the note). One read of the
  // template, two consumers — never re-derived at the second site.

  it('passes the template\'s bodyFormat into assemblePrompt as templateBodyFormat', async () => {
    const { handler, ai, prisma } = harness();

    prisma.noteTemplate.findUnique.mockResolvedValue({ ...template, bodyFormat: 'plain_text' });

    await handler.process(job());

    // `plain_text` instructions steer the model away from Markdown syntax
    // (`prompt.spec.ts` pins the exact wording); this just pins that the value
    // travelled from the template row into the assembled prompt at all.
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

// -----------------------------------------------------------------------------
// The budget, checked BEFORE any provider call
// -----------------------------------------------------------------------------

describe('NoteGenerateHandler — the token budget', () => {
  // A deployment ceiling far under the assembled prompt.
  const OVER = { capsOverride: { maxInputTokens: 256 }, sourceText: 'word '.repeat(5_000) };

  it('refuses an over-budget prompt WITHOUT touching the provider', async () => {
    const { handler, ai, generations } = harness(OVER);

    await handler.process(job());

    expect(ai.callsOf('streamText')).toHaveLength(0);
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal', category: 'Too large' }),
    );
    // NEVER TRUNCATED: nothing was committed at all.
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
    const ai = new FakeKvoxAi().setReadiness({ contextWindowTokens: null, maxOutputTokens: null });
    const { handler, generations } = harness({ ai });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(ai.callsOf('streamText')).toHaveLength(0);
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal' }),
    );
    expect(generations.markFailed.mock.calls[0][0].reason).toContain('context window');
  });
});

// -----------------------------------------------------------------------------
// Failure classes
// -----------------------------------------------------------------------------

describe('NoteGenerateHandler — domain failures return, they do not throw', () => {
  it('AiAuthError: no stored key for this user', async () => {
    const { handler, ai, generations } = harness({
      ai: new FakeKvoxAi().setNotReady('ai_key_missing'),
    });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'auth', category: 'Your API key' }),
    );
    expect(ai.callsOf('streamText')).toHaveLength(0);
  });

  it('AiInputError: a model this deployment does not permit', async () => {
    const { handler, generations } = harness({
      ai: new FakeKvoxAi().setReadiness(notReadyReadiness('model_not_permitted')),
      generation: generationRow({ model: 'gpt-5-ultra' }),
    });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal' }),
    );
    expect(generations.markFailed.mock.calls[0][0].reason).toContain('gpt-5-ultra');
  });

  it('AiInputError: AI switched off for the deployment', async () => {
    const { handler, generations } = harness({
      ai: new FakeKvoxAi().setNotReady('ai_not_configured'),
    });

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

  it('AiRefusedError: a content-policy refusal is not a note', async () => {
    const ai = new FakeKvoxAi().queueStream({
      deltas: ['I cannot'],
      failAfter: new AiRefusedError('The provider declined to answer.'),
    });
    const { handler, generations } = harness({ ai });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal', category: 'Declined by the provider' }),
    );
    expect(generations.commit).not.toHaveBeenCalled();
  });

  it('AiRefusedError: an empty completion is never committed as a ready note', async () => {
    const { handler, generations } = harness({ ai: new FakeKvoxAi().queueStream({ deltas: [] }) });

    await expect(handler.process(job())).resolves.toBeUndefined();
    expect(generations.commit).not.toHaveBeenCalled();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal', category: 'Declined by the provider' }),
    );
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
    const ai = new FakeKvoxAi().queueStreamError(new RateLimitError('Rate limited by the provider', 30_000));
    const { handler, generations } = harness({ ai });

    await expect(handler.process(job())).rejects.toBeInstanceOf(RateLimitError);

    expect(generations.markFailed).not.toHaveBeenCalled();
    expect(generations.commit).not.toHaveBeenCalled();
  });

  it('records AND rethrows an unrecognised failure, with no vendor text in the reason', async () => {
    const ai = new FakeKvoxAi().queueStreamError(new Error('socket hang up at postgres://user:pw@host/db'));
    const { handler, generations } = harness({ ai });

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
      capsOverride: { maxInputTokens: 256 },
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
  it('records the EXACT system/user prompt the port receives, plus sourceVersion', async () => {
    const { handler, ai, generations } = harness({ sourceText: 'Ana: we ship on Friday.' });

    await handler.process(job());

    expect(generations.recordContext).toHaveBeenCalledWith('gen-1', {
      systemPrompt: streamRequest(ai).system,
      userContent: streamRequest(ai).user,
      sourceVersion: 7,
    });
  });

  it('is called BEFORE the provider — recordContext precedes streamText', async () => {
    const order: string[] = [];
    const { handler, ai, generations } = harness();

    generations.recordContext.mockImplementation(async () => {
      order.push('recordContext');
    });

    const original = ai.streamText.bind(ai);
    jest.spyOn(ai, 'streamText').mockImplementation((req) => {
      order.push('streamText');

      return original(req);
    });

    await handler.process(job());

    expect(order).toEqual(['recordContext', 'streamText']);
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
    const ai = new FakeKvoxAi().queueStreamError(new AiRefusedError('Declined.'));
    const { handler, generations } = harness({ ai });

    await handler.process(job());

    expect(generations.recordContext).toHaveBeenCalled();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'refusal' }),
    );
  });

  it('is still recorded when the stream throws mid-flight (an unrecognised/timeout-ish failure)', async () => {
    const ai = new FakeKvoxAi().queueStream({ deltas: ['partial'], failAfter: new Error('stream timed out') });
    const { handler, generations } = harness({ ai });

    await expect(handler.process(job())).rejects.toThrow('stream timed out');

    expect(generations.recordContext).toHaveBeenCalled();
    expect(generations.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ errorClass: 'other' }),
    );
  });

  it('is NOT called when an AiBudgetError is thrown — a refusal sends nothing, so it records nothing', async () => {
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
