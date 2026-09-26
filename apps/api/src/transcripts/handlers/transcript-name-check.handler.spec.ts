// =============================================================================
// `transcript.name_check` (issues #328 and #330, epic #326)
// =============================================================================
//
// Follows the shape of `notes/handlers/note-generate.handler.spec.ts`: a fake
// provider whose stream is scripted per test, and a Prisma stand-in whose
// `$transaction` just runs the callback against a shared `tx`-like object.
// =============================================================================

import { z } from 'zod';

import { AiAuthError, AiInputError } from '../../ai/ai-errors';
import { AiProviderRegistry } from '../../ai/ai-provider.registry';
import type {
  AiDelta,
  AiGenerateRequest,
  AiProvider,
  AiProviderContext,
} from '../../ai/providers/ai-provider.interface';
import { OPENAI_PROVIDER_ID } from '../../ai/providers/openai.provider';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { TRANSCRIPT_NAME_CHECK_JOB_TYPE } from '../job-types';
import {
  TRANSCRIPT_NAME_CHECK_MAX_RUNTIME_MS,
  TranscriptNameCheckHandler,
  classifyNameCheckError,
  describeNameCheckError,
  readNameCheckPayload,
  readTerms,
} from './transcript-name-check.handler';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const USER_ID = 'user-1';
const TRANSCRIPT_ID = 'transcript-1';
const CHECK_ID = 'check-1';

const policy = {
  enabled: true,
  provider: 'openai',
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

/** A provider whose stream is scripted per call. */
class FakeProvider implements AiProvider<unknown> {
  readonly id = OPENAI_PROVIDER_ID;
  readonly label = 'OpenAI';
  readonly capabilities = {
    models: [{ id: 'gpt-4o', label: 'GPT-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_000, structuredOutput: false, toolCalling: false }],
    streaming: true as const,
    modelDiscovery: false,
  };
  readonly settingsSchema = z.unknown();
  readonly fieldDescriptors = [];

  calls = 0;
  requests: AiGenerateRequest[] = [];

  constructor(private readonly scripts: Array<() => AsyncIterable<AiDelta>>) {}

  async testConnection(): Promise<never> {
    throw new Error('not used');
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  generate(_ctx: AiProviderContext<unknown>, request: AiGenerateRequest): AsyncIterable<AiDelta> {
    this.requests.push(request);
    const script = this.scripts[Math.min(this.calls, this.scripts.length - 1)]!;
    this.calls += 1;
    return script();
  }
}

function answer(text: string, finishReason: 'stop' | 'length' | 'content_filter' = 'stop'): () => AsyncIterable<AiDelta> {
  return async function* (): AsyncIterable<AiDelta> {
    yield { kind: 'delta', text };
    yield { kind: 'done', finishReason, usage: { promptTokens: 50, completionTokens: 10 } };
  };
}

/** A keep-everything adjudication answer. */
const keepJson = JSON.stringify({ results: [{ id: 'c1', verdict: 'keep' }] });
/** A replace-with-target adjudication answer. */
const replaceJson = JSON.stringify({
  results: [{ id: 'c1', verdict: 'replace', replacement: 'Oscar', confidence: 0.95, reason: 'sounds like it' }],
});

interface Harness {
  handler: TranscriptNameCheckHandler;
  providers: AiProviderRegistry;
  throttle: ProviderThrottleService;
  prisma: {
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
  settings: { get: jest.Mock };
  credentials: { getSecret: jest.Mock };
}

function harness(options: {
  provider?: AiProvider<unknown>;
  run?: Record<string, unknown>;
  apiKey?: string | null;
  policyOverride?: Record<string, unknown>;
  segments?: typeof segmentRows;
  currentVersion?: number;
  checkStatus?: string;
} = {}): Harness {
  const providers = new AiProviderRegistry();
  providers.register(options.provider ?? new FakeProvider([answer(keepJson)]));

  const throttle = new ProviderThrottleService({ get: () => undefined } as never);

  const settings = { get: jest.fn().mockResolvedValue({ ...policy, ...(options.policyOverride ?? {}) }) };
  const credentials = {
    getSecret: jest.fn().mockResolvedValue(options.apiKey === undefined ? 'sk-test' : options.apiKey),
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

  const prisma = {
    transcriptNameCheck: {
      findUnique: jest.fn().mockResolvedValue(run),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx)),
  };

  const handler = new TranscriptNameCheckHandler(
    new JobHandlerRegistry(),
    prisma as never,
    providers,
    settings as never,
    credentials as never,
    throttle,
  );

  return { handler, providers, throttle, prisma, tx, settings, credentials };
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
    expect(classifyNameCheckError(new AiAuthError('no key', 'openai'))).toBe('auth');
    expect(classifyNameCheckError(new AiInputError('bad input'))).toBe('input');
  });

  it('classifies anything unrecognised as other', () => {
    expect(classifyNameCheckError(new Error('boom'))).toBe('other');
    expect(classifyNameCheckError('a string')).toBe('other');
    expect(classifyNameCheckError(null)).toBe('other');
  });
});

describe('describeNameCheckError', () => {
  it('uses the domain error message', () => {
    expect(describeNameCheckError(new AiAuthError('No key saved', 'openai'))).toBe('No key saved');
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
    const registry = new JobHandlerRegistry();
    const { handler } = harness();
    (handler as unknown as { registry: JobHandlerRegistry }).registry = registry;
    handler.onModuleInit();

    expect(registry.get(TRANSCRIPT_NAME_CHECK_JOB_TYPE)).toBe(handler);
    expect(handler.type).toBe('transcript.name_check');
  });

  it('declares ONE attempt and a twenty-minute ceiling', () => {
    const { handler } = harness();
    expect(handler.profile).toEqual({ maxRuntimeMs: TRANSCRIPT_NAME_CHECK_MAX_RUNTIME_MS, maxAttempts: 1 });
    expect(TRANSCRIPT_NAME_CHECK_MAX_RUNTIME_MS).toBe(20 * 60_000);
  });

  it('is server-only: neither nodeResultSchema nor persistNodeResult is declared', () => {
    const { handler } = harness();
    const asHandler: JobHandler = handler;
    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
  });

  it('does not register a static throttle key — the bucket is per user', () => {
    const registry = new JobHandlerRegistry();
    const { handler, throttle } = harness();
    (handler as unknown as { registry: JobHandlerRegistry }).registry = registry;
    handler.onModuleInit();

    expect(throttle.resolveKey(TRANSCRIPT_NAME_CHECK_JOB_TYPE)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------------------

describe('TranscriptNameCheckHandler — a standard run', () => {
  it('persists an accepted suggestion and marks the run ready, with token counts', async () => {
    const provider = new FakeProvider([answer(replaceJson)]);
    const { handler, tx, prisma } = harness({ provider });

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

  it("passes responseFormat: 'json' to the provider", async () => {
    const provider = new FakeProvider([answer(keepJson)]);
    const { handler } = harness({ provider });

    await handler.process(job());

    expect(provider.requests[0]?.responseFormat).toBe('json');
  });

  it('registers the per-user throttle key on every call', async () => {
    const provider = new FakeProvider([answer(keepJson)]);
    const { handler, throttle } = harness({ provider });

    const spy = jest.spyOn(throttle, 'registerProviderKey');

    await handler.process(job());

    expect(spy).toHaveBeenCalledWith(TRANSCRIPT_NAME_CHECK_JOB_TYPE, `ai-provider:${USER_ID}`);
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
    const provider = new FakeProvider([answer('not json at all'), answer('still not json')]);
    const { handler } = harness({ provider });

    await handler.process(job());

    expect(provider.calls).toBe(2);
    // Second request carries the retry instruction.
    expect(provider.requests[1]?.userContent).toContain('Return only valid JSON');
  });

  it('a malformed batch is skipped WITHOUT failing the whole run, when another request is usable', async () => {
    // Discovery's answer is garbage both times (retried, then given up on);
    // the phonetic candidate's own adjudication batch succeeds regardless —
    // "no suggestions from discovery" must not become "no suggestions at
    // all", let alone a failed run.
    const segments = [
      { id: 'seg-1', rev: 1, speakerId: 's-a', startMs: 0, text: 'They called him Skar yesterday.', words: null },
    ];
    const provider = new FakeProvider([answer('garbage'), answer('garbage'), answer(replaceJson)]);
    const { handler, tx, prisma } = harness({ provider, run: runRow({ mode: 'thorough' }), segments });

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
    const provider = new FakeProvider([answer('not json'), answer(replaceJson)]);
    const { handler, tx } = harness({ provider });

    await handler.process(job());

    expect(provider.calls).toBe(2);
    expect(tx.transcriptNameSuggestion.createMany).toHaveBeenCalledTimes(1);
  });

  it('fails the run with "refusal" when EVERY request produced no usable answer', async () => {
    const provider = new FakeProvider([answer('garbage'), answer('still garbage')]);
    const { handler, prisma } = harness({ provider });

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
    class ThrottledProvider extends FakeProvider {
      generate(): AsyncIterable<AiDelta> {
        throw new RateLimitError('slow down');
      }
    }
    const { handler, prisma } = harness({ provider: new ThrottledProvider([]) });

    await expect(handler.process(job())).rejects.toBeInstanceOf(RateLimitError);

    // Only the initial "mark running" updateMany — no failure markUpdate.
    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'running' }) }),
    );
  });

  it('marks the run failed with errorClass "auth" when no API key is saved, and returns normally', async () => {
    const { handler, prisma } = harness({ apiKey: null });

    await expect(handler.process(job())).resolves.toBeUndefined();

    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed', errorClass: 'auth' }) }),
    );
  });

  it('marks the run failed as "other" AND rethrows for an unrecognised error', async () => {
    class ExplodingProvider extends FakeProvider {
      generate(): AsyncIterable<AiDelta> {
        throw new Error('kaboom, unexpected');
      }
    }
    const { handler, prisma } = harness({ provider: new ExplodingProvider([]) });

    await expect(handler.process(job())).rejects.toThrow('kaboom, unexpected');

    expect(prisma.transcriptNameCheck.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed', errorClass: 'other' }) }),
    );
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
    const provider = new FakeProvider([answer(discoveryAnswer), answer(bothReplaceJson)]);
    const { handler, tx } = harness({
      provider,
      run: runRow({ mode: 'thorough' }),
      segments,
    });

    await handler.process(job());

    // Two provider calls: one discovery chunk, one adjudication batch.
    expect(provider.calls).toBe(2);
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
    const provider = new FakeProvider([answer(replaceJson)]);
    const { handler, tx } = harness({ provider, checkStatus: 'failed' });

    await handler.process(job());

    expect(tx.transcriptNameSuggestion.createMany).not.toHaveBeenCalled();
    expect(tx.transcriptNameCheck.update).not.toHaveBeenCalled();
  });
});
