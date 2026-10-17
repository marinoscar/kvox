// =============================================================================
// `transcript.name_check` (issues #328 and #330, epic #326)
// =============================================================================
//
// The package's `createFakeKvoxAi` port with its `generateText` answers scripted
// per test, and a Prisma stand-in whose `$transaction` just runs the callback
// against a shared `tx`-like object.
// =============================================================================

import { KvoxAiError, KvoxRateLimitError, type KvoxJobHandler, type KvoxJobsPort } from '../../ports/index.js';
import { createFakeKvoxAi, type FakeKvoxAi } from '../../testing/index.js';
import {
  NameCheckFailure,
  TRANSCRIPT_NAME_CHECK_MAX_RUNTIME_MS,
  TranscriptNameCheckHandler,
  classifyNameCheckError,
  describeNameCheckError,
  readNameCheckPayload,
  readTerms,
} from './transcript-name-check.handler.js';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const USER_ID = 'user-1';
const TRANSCRIPT_ID = 'transcript-1';
const CHECK_ID = 'check-1';

/** The deployment's two spend caps (`ai.maxInputTokens`, `ai.maxOutputTokens`). */
const caps = {
  maxInputTokens: 100_000,
  maxOutputTokens: 4_000,
};

const speakerRows = [{ id: 's-a', label: 'A', displayName: 'Speaker A' }];

const segmentRows = [
  {
    id: 'seg-1',
    rev: 1,
    speakerId: 's-a',
    startMs: 0,
    text: 'They called him Skar yesterday.',
    words: null,
  },
];

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHECK_ID,
    transcriptId: TRANSCRIPT_ID,
    requestedById: USER_ID,
    mode: 'standard',
    status: 'pending',
    terms: ['Oscar'],
    providerId: null,
    model: null,
    transcript: { id: TRANSCRIPT_ID, status: 'ready', deletedAt: null },
    ...overrides,
  };
}

const job = (payload: unknown = { checkId: CHECK_ID }) => ({ id: 'job-1', payload }) as never;

/** A fake port whose `generateText` answers (or throws) per call, in order. */
type ScriptedAi = FakeKvoxAi & { steps: Array<{ text: string } | { error: unknown }> };

function scriptedAi(script: Parameters<typeof createFakeKvoxAi>[0] = {}): ScriptedAi {
  const fake = createFakeKvoxAi({
    script: { target: { provider: 'openai', model: 'gpt-4o' }, ...script.script },
  }) as ScriptedAi;

  fake.steps = [];

  fake.generateText = async function* (ctx, req) {
    fake.calls.push({ method: 'generateText', ctx, req });

    const step = fake.steps.shift();
    if (!step) throw new Error('no scripted answer left');
    if ('error' in step) throw step.error;

    yield { type: 'delta' as const, text: step.text };
    yield { type: 'done' as const, usage: { inputTokens: 50, outputTokens: 10 }, finishReason: 'stop' };
  };

  return fake;
}

/** A port that answers each call with the next text, in order. */
function answering(...texts: string[]): ScriptedAi {
  const ai = scriptedAi();
  for (const text of texts) ai.steps.push({ text });
  return ai;
}

/** A port whose calls fail with these errors, in order. */
function failing(...errors: unknown[]): ScriptedAi {
  const ai = scriptedAi();
  for (const error of errors) ai.steps.push({ error });
  return ai;
}

/** The calls the port received for one method, in order. */
function callsOf(ai: FakeKvoxAi, method: string) {
  return ai.calls.filter((call) => call.method === method);
}

/** The `user` prompts the port was called with, in order. */
function userPrompts(ai: FakeKvoxAi): string[] {
  return callsOf(ai, 'generateText').map((call) => (call.req as { user: string }).user);
}

/** A keep-everything adjudication answer. */
const keepJson = JSON.stringify({ results: [{ id: 'c1', verdict: 'keep' }] });
/** A replace-with-target adjudication answer. */
const replaceJson = JSON.stringify({
  results: [{ id: 'c1', verdict: 'replace', replacement: 'Oscar', confidence: 0.95, reason: 'sounds like it' }],
});

interface Harness {
  handler: TranscriptNameCheckHandler;
  ai: FakeKvoxAi;
  jobs: { registerHandler: jest.Mock; enqueue: jest.Mock; isRegistered: jest.Mock };
  prisma: {
    transcript: { findUnique: jest.Mock };
    transcriptNameCheck: { findUnique: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
  };
  tx: {
    transcript: { findUnique: jest.Mock };
    transcriptSpeaker: { findMany: jest.Mock };
    transcriptSegment: { findMany: jest.Mock };
    transcriptNameCheck: { findUnique: jest.Mock; update: jest.Mock };
    transcriptNameSuggestion: { createMany: jest.Mock };
  };
  settings: { readSystem: jest.Mock };
}

function harness(options: {
  ai?: FakeKvoxAi;
  run?: Record<string, unknown>;
  capsOverride?: Record<string, unknown>;
  segments?: typeof segmentRows;
  currentVersion?: number;
  checkStatus?: string;
} = {}): Harness {
  const ai = options.ai ?? answering(keepJson);

  const settings = {
    readSystem: jest.fn().mockResolvedValue({ value: { ...caps, ...(options.capsOverride ?? {}) } }),
  };

  const run = options.run ?? runRow();

  const tx = {
    transcript: {
      findUnique: jest.fn().mockResolvedValue({ currentVersion: options.currentVersion ?? 5 }),
    },
    transcriptSpeaker: { findMany: jest.fn().mockResolvedValue(speakerRows) },
    transcriptSegment: { findMany: jest.fn().mockResolvedValue(options.segments ?? segmentRows) },
    transcriptNameCheck: {
      findUnique: jest.fn().mockResolvedValue({ status: options.checkStatus ?? 'running' }),
      update: jest.fn().mockResolvedValue({}),
    },
    transcriptNameSuggestion: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };

  const { transcript: owner, ...found } = run as { transcript: unknown } & Record<string, unknown>;

  const jobs = { registerHandler: jest.fn(), enqueue: jest.fn(), isRegistered: jest.fn() };

  const prisma = {
    transcript: { findUnique: jest.fn().mockResolvedValue(owner) },
    transcriptNameCheck: {
      findUnique: jest.fn().mockResolvedValue(found),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const handler = new TranscriptNameCheckHandler(
    jobs as unknown as KvoxJobsPort,
    prisma as never,
    ai,
    settings as never,
  );

  return { handler, ai, jobs, prisma, tx, settings };
}

// -----------------------------------------------------------------------------
// readNameCheckPayload / classifyNameCheckError / describeNameCheckError
// -----------------------------------------------------------------------------

describe('readNameCheckPayload', () => {
  it('reads a valid payload', () => {
    expect(readNameCheckPayload({ checkId: 'abc' })).toEqual({ checkId: 'abc' });
  });

  it.each([[null], [undefined], [{}], [{ checkId: 42 }], [{ checkId: '' }], ['not an object']])(
    'returns null for %p',
    (payload) => {
      expect(readNameCheckPayload(payload)).toBeNull();
    },
  );
});

describe('classifyNameCheckError', () => {
  it('classifies each domain error to its own class', () => {
    expect(classifyNameCheckError(new KvoxAiError('key_missing', 'no key'))).toBe('auth');
    expect(classifyNameCheckError(new KvoxAiError('auth', 'rejected'))).toBe('auth');
    expect(classifyNameCheckError(new KvoxAiError('capability', 'bad model'))).toBe('input');
    expect(classifyNameCheckError(new NameCheckFailure('input', 'bad input'))).toBe('input');
  });

  it('classifies anything unrecognised as other', () => {
    expect(classifyNameCheckError(new Error('boom'))).toBe('other');
    expect(classifyNameCheckError('a string')).toBe('other');
    expect(classifyNameCheckError(null)).toBe('other');
  });
});

describe('describeNameCheckError', () => {
  it('uses the domain error message', () => {
    expect(describeNameCheckError(new NameCheckFailure('auth', 'No key saved'))).toBe('No key saved');
  });

  it('never echoes a raw, unrecognised error', () => {
    expect(describeNameCheckError(new Error('a raw stack-carrying error'))).toContain(
      'unexpected error',
    );
  });
});

describe('readTerms', () => {
  it('keeps only non-blank strings', () => {
    expect(readTerms(['Oscar', '', '  ', 42, null, 'Ana'])).toEqual(['Oscar', 'Ana']);
  });

  it('returns [] for anything that is not an array', () => {
    expect(readTerms(null)).toEqual([]);
    expect(readTerms('Oscar')).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Registration and profile
// -----------------------------------------------------------------------------

describe('TranscriptNameCheckHandler — registration and profile', () => {
  it('registers under the permanent type string', () => {
    const { handler, jobs } = harness();
    handler.onModuleInit();

    expect(jobs.registerHandler).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('transcript.name_check');
  });

  it('declares ONE attempt and a twenty-minute ceiling', () => {
    const { handler } = harness();
    expect(handler.profile).toEqual({ maxRuntimeMs: TRANSCRIPT_NAME_CHECK_MAX_RUNTIME_MS, maxAttempts: 1 });
    expect(TRANSCRIPT_NAME_CHECK_MAX_RUNTIME_MS).toBe(20 * 60_000);
  });

  it('is server-only: neither nodeResultSchema nor persistNodeResult is declared', () => {
    const { handler } = harness();
    const asHandler: KvoxJobHandler = handler;
    expect(asHandler).not.toHaveProperty('nodeResultSchema');
    expect(asHandler).not.toHaveProperty('persistNodeResult');
  });

  it('does not register a static throttle key — the bucket is per user', () => {
    const { handler } = harness();

    expect((handler as KvoxJobHandler).throttleKey).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------------------

describe('TranscriptNameCheckHandler — a standard run', () => {
  it('persists an accepted suggestion and marks the run ready, with token counts', async () => {
    const { handler, tx, prisma } = harness({ ai: answering(replaceJson) });

    await handler.process(job());

    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'running' }) }),
    );

    expect(tx.transcriptNameSuggestion.createMany).toHaveBeenCalledTimes(1);
    const suggestions = tx.transcriptNameSuggestion.createMany.mock.calls[0][0].data;
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      checkId: CHECK_ID,
      segmentId: 'seg-1',
      original: 'Skar',
      replacement: 'Oscar',
      source: 'phonetic',
    });

    expect(tx.transcriptNameCheck.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CHECK_ID },
        data: expect.objectContaining({
          status: 'ready',
          suggestionCount: 1,
          errorClass: null,
          error: null,
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
        }),
      }),
    );
    const data = tx.transcriptNameCheck.update.mock.calls[0][0].data;
    expect(data.inputTokens).toBeGreaterThan(0);
    expect(data.outputTokens).toBeGreaterThan(0);
  });

  it('calls the port as the requesting user, for the name-check feature', async () => {
    const { handler, ai } = harness();

    await handler.process(job());

    expect(callsOf(ai, 'resolveTask')[0]?.ctx).toMatchObject({ userId: USER_ID, feature: 'transcripts.name_check' });
    expect(callsOf(ai, 'generateText')[0]?.ctx).toMatchObject({ userId: USER_ID, feature: 'transcripts.name_check' });
  });

  it('records the provider and model the run ran on', async () => {
    const { handler, tx } = harness();

    await handler.process(job());

    expect(tx.transcriptNameCheck.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ providerId: 'openai', model: 'gpt-4o' }),
      }),
    );
  });

  it('is a no-op for a run that is not pending/running', async () => {
    const { handler, prisma } = harness({ run: runRow({ status: 'ready' }) });

    await handler.process(job());

    expect(prisma.transcriptNameCheck.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op for a job naming no check, and one whose run no longer exists', async () => {
    const { handler, prisma } = harness();

    await handler.process(job({}));
    expect(prisma.transcriptNameCheck.findUnique).not.toHaveBeenCalled();

    prisma.transcriptNameCheck.findUnique.mockResolvedValueOnce(null);
    await handler.process(job());
    expect(prisma.transcriptNameCheck.updateMany).not.toHaveBeenCalled();
  });

  it('is a no-op for a transcript that is being deleted', async () => {
    const { handler, prisma } = harness({
      run: runRow({ transcript: { id: TRANSCRIPT_ID, status: 'ready', deletedAt: new Date() } }),
    });

    await handler.process(job());

    expect(prisma.transcriptNameCheck.updateMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Malformed JSON — one retry, then skip the batch
// -----------------------------------------------------------------------------

describe('TranscriptNameCheckHandler — malformed answers', () => {
  it('retries once on invalid JSON before giving up on that request', async () => {
    const { handler, ai } = harness({ ai: answering('not json at all', 'still not json') });

    await handler.process(job());

    expect(callsOf(ai, 'generateText')).toHaveLength(2);
    // Second request carries the retry instruction.
    expect(userPrompts(ai)[1]).toContain('Return only valid JSON');
  });

  it('a malformed batch is skipped WITHOUT failing the whole run, when another request is usable', async () => {
    // Discovery's answer is garbage both times (retried, then given up on);
    // the phonetic candidate's own adjudication batch succeeds regardless —
    // "no suggestions from discovery" must not become "no suggestions at
    // all", let alone a failed run.
    const segments = [
      { id: 'seg-1', rev: 1, speakerId: 's-a', startMs: 0, text: 'They called him Skar yesterday.', words: null },
    ];
    const { handler, tx, prisma } = harness({
      ai: answering('garbage', 'garbage', replaceJson),
      run: runRow({ mode: 'thorough' }),
      segments,
    });

    await handler.process(job());

    expect(tx.transcriptNameSuggestion.createMany).toHaveBeenCalledTimes(1);
    const suggestions = tx.transcriptNameSuggestion.createMany.mock.calls[0][0].data;
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ source: 'phonetic' });

    expect(prisma.transcriptNameCheck.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('recovers when the retry succeeds', async () => {
    const { handler, tx, ai } = harness({ ai: answering('not json', replaceJson) });

    await handler.process(job());

    expect(callsOf(ai, 'generateText')).toHaveLength(2);
    expect(tx.transcriptNameSuggestion.createMany).toHaveBeenCalledTimes(1);
  });

  it('fails the run with "refusal" when EVERY request produced no usable answer', async () => {
    const { handler, prisma } = harness({ ai: answering('garbage', 'still garbage') });

    await handler.process(job());

    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', errorClass: 'refusal' }),
      }),
    );
  });
});

// -----------------------------------------------------------------------------
// Failure classification
// -----------------------------------------------------------------------------

describe('TranscriptNameCheckHandler — failure handling', () => {
  it('rethrows RateLimitError and leaves the run running (not failed)', async () => {
    const ai = failing(new KvoxRateLimitError(`ai-provider:${USER_ID}`, 1000, 'slow down'));
    const { handler, prisma } = harness({ ai });

    await expect(handler.process(job())).rejects.toBeInstanceOf(KvoxRateLimitError);

    // Only the initial "mark running" updateMany — no failure markUpdate.
    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'running' }) }),
    );
  });

  it("turns the provider's own 429 into a rate limit on THIS user's bucket", async () => {
    const ai = failing(new KvoxAiError('rate_limit', 'too many requests', 2000));
    const { handler, prisma } = harness({ ai });

    const error = await handler.process(job()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KvoxRateLimitError);
    expect(error).toMatchObject({ throttleKey: `ai-provider:${USER_ID}`, retryAfterMs: 2000 });
    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledTimes(1);
  });

  it('marks the run failed with errorClass "auth" when no API key is saved, and returns normally', async () => {
    const ai = scriptedAi({ script: { failWith: 'key_missing' } });
    const { handler, prisma } = harness({ ai });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed', errorClass: 'auth' }) }),
    );
    expect(callsOf(ai, 'generateText')).toHaveLength(0);
  });

  it.each([
    ['AI is not configured', 'not_configured'],
    ['the model is no longer enabled', 'capability'],
  ] as const)('marks the run failed with errorClass "input" when %s', async (_name, reason) => {
    const ai = scriptedAi({ script: { failWith: reason } });
    const { handler, prisma } = harness({ ai });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed', errorClass: 'input' }) }),
    );
  });

  it('marks the run failed as "other" AND rethrows for an unrecognised error', async () => {
    const ai = failing(new Error('kaboom, unexpected'));
    const { handler, prisma } = harness({ ai });

    await expect(handler.process(job())).rejects.toThrow('kaboom, unexpected');

    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed', errorClass: 'other' }) }),
    );
  });

  it('treats a content-policy refusal on one batch as an unusable answer, not a failed run', async () => {
    // The first call is declined (retried once), the retry is declined too, so the
    // batch is skipped; with no usable request at all the run is a "refusal".
    const ai = failing(new KvoxAiError('refusal', 'declined'), new KvoxAiError('refusal', 'declined'));
    const { handler, prisma } = harness({ ai });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(callsOf(ai, 'generateText')).toHaveLength(2);
    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed', errorClass: 'refusal' }) }),
    );
  });

  it('a refusal on one batch does not stop a later batch from being usable', async () => {
    const ai = failing(new KvoxAiError('refusal', 'declined'));
    ai.steps.push({ text: replaceJson });
    const { handler, tx } = harness({ ai });

    await handler.process(job());

    expect(tx.transcriptNameSuggestion.createMany).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// Thorough mode — discovery then adjudication
// -----------------------------------------------------------------------------

describe('TranscriptNameCheckHandler — thorough mode', () => {
  it('runs a discovery call before adjudicating, merging discovery findings with the phonetic pass', async () => {
    // "Skar" is caught by the phonetic pass on its own; "a car" (further along
    // the same line) is not — only discovery finds it, and the two spans do
    // not overlap, so both survive `mergeCandidates`.
    const segments = [
      {
        id: 'seg-2',
        rev: 1,
        speakerId: 's-a',
        startMs: 0,
        text: 'They called him Skar and later a car appeared.',
        words: null,
      },
    ];
    const discoveryAnswer = JSON.stringify({
      findings: [{ seg: 0, text: 'a car', target: 'Oscar' }],
    });
    const bothReplaceJson = JSON.stringify({
      results: [
        { id: 'c1', verdict: 'replace', replacement: 'Oscar' },
        { id: 'c2', verdict: 'replace', replacement: 'Oscar' },
      ],
    });
    const { handler, tx, ai } = harness({
      ai: answering(discoveryAnswer, bothReplaceJson),
      run: runRow({ mode: 'thorough' }),
      segments,
    });

    await handler.process(job());

    // Two provider calls: one discovery chunk, one adjudication batch.
    expect(callsOf(ai, 'generateText')).toHaveLength(2);
    expect(tx.transcriptNameSuggestion.createMany).toHaveBeenCalledTimes(1);
    const suggestions = tx.transcriptNameSuggestion.createMany.mock.calls[0][0].data as Array<{
      source: string;
      original: string;
    }>;
    expect(suggestions).toHaveLength(2);
    expect(suggestions.map((s) => s.source).sort()).toEqual(['discovery', 'phonetic']);
    expect(suggestions.find((s) => s.source === 'discovery')?.original).toBe('a car');
    expect(suggestions.find((s) => s.source === 'phonetic')?.original).toBe('Skar');
  });
});

// -----------------------------------------------------------------------------
// Non-pending run
// -----------------------------------------------------------------------------

describe('TranscriptNameCheckHandler — the settle transaction re-checks status', () => {
  it('does not persist when the run stopped being "running" by the time the write happens', async () => {
    const { handler, tx } = harness({ ai: answering(replaceJson), checkStatus: 'failed' });

    await handler.process(job());

    expect(tx.transcriptNameSuggestion.createMany).not.toHaveBeenCalled();
    expect(tx.transcriptNameCheck.update).not.toHaveBeenCalled();
  });
});
