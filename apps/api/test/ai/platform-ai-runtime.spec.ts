import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HttpException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { RateLimitError } from '@marinoscar/platform-api/jobs';
import { KvoxAiError, type KvoxAiContext, type KvoxAiTarget } from '@marinoscar/kvox-api/ports';

import { KvoxAiBadRequest, KvoxAiConflict } from '../../src/ai-port/kvox-ai-errors';
import { translateHostError } from '../../src/ai-port/platform-ai-runtime';
import { createWebAiUnderTest } from '../helpers/web-kvox-ai.helper';

// =============================================================================
// PlatformAiRuntime: the web KVOX_AI over AiService.forUser (issue #579)
// =============================================================================
//
// What only the web edition's runtime decides, through the REAL binding
// (`createWebKvoxAi`) over a scripted platform `AiService`:
//
//   • one `forUser(userId, { orgId?, jobId?, feature })` per round trip, so the
//     platform writes one usage row per call (each Ask step, each structured call);
//   • the request carries the target's model and never its provider (the platform asks
//     this app's target resolver), and a structured call is `respond` with
//     `structuredOutput`;
//   • readiness is the existence of a `user_ai_keys` row, the secret never selected;
//   • a HOST error (the target resolver's 409/400, the queue's `RateLimitError`, any
//     other Nest `HttpException`) answers the class the web edition always answered,
//     row by row against the frozen table captured from the old two-hop path
//     (`fixtures/platform-ai-runtime-error-parity.v1.json`). The platform `AiError`
//     rows are the package's (`packages/kvox-ai/test/fixtures/error-parity.v1.json`).
// =============================================================================

const KEY = 'sk-abcdefghij1234567890';

interface Row {
  error: string;
  kind: string;
  inJob: boolean;
  errorClass: string;
  retryAfterMs: number | null;
  message: string;
  usage: unknown;
}

const parity = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'platform-ai-runtime-error-parity.v1.json'), 'utf8'),
) as { rows: Row[] };

/** The host throwable a row names, built exactly as the capture built it. */
function throwable(name: string): unknown {
  switch (name) {
    case 'KvoxAiConflict#ai_not_configured':
      return new KvoxAiConflict('ai_not_configured', `nc ${KEY}`);
    case 'KvoxAiConflict#graph_disabled':
      return new KvoxAiConflict('graph_disabled', 'gd');
    case 'KvoxAiConflict#ai_key_missing':
      return new KvoxAiConflict('ai_key_missing', 'km');
    case 'KvoxAiConflict#ai_key_invalid':
      return new KvoxAiConflict('ai_key_invalid', 'ki');
    case 'KvoxAiConflict#model_lacks_capability':
      return new KvoxAiConflict('model_lacks_capability', 'lc');
    case 'KvoxAiBadRequest#model_not_permitted':
      return new KvoxAiBadRequest('np');
    case 'KvoxAiBadRequest#model_lacks_capability':
      return new KvoxAiBadRequest('lc', {}, 'model_lacks_capability');
    case 'HttpException#429':
      return new HttpException('slow', 429);
    case 'HttpException#422':
      return new HttpException('filtered', 422);
    case 'HttpException#400':
      return new HttpException('bad', 400);
    case 'HttpException#503':
      return new HttpException('down', 503);
    case 'NotFoundException':
      return new NotFoundException('gone');
    case 'RateLimitError':
      return new RateLimitError(`429 ${KEY}`, 1500);
    case 'RateLimitError#no-hint':
      return new RateLimitError('429');
    default:
      throw new Error(`no throwable for ${name}`);
  }
}

const TARGET: KvoxAiTarget = { provider: 'openai', model: 'gpt-x', contextWindowTokens: 128_000, maxOutputTokens: 16_384, source: 'task' };

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function replay(row: Row): Promise<Record<string, unknown>> {
  const web = createWebAiUnderTest();
  const base = { userId: 'u1', orgId: 'o1', ...(row.inJob ? { jobId: 'j1' } : {}) };
  const ctx = (feature: string): KvoxAiContext => ({ ...base, feature });
  web.arm(throwable(row.error));

  try {
    if (row.kind === 'text') {
      await drain(web.port.generateText(ctx('notes.generate'), { target: TARGET, system: 's', user: 'u' }));
    } else if (row.kind.startsWith('structured')) {
      await web.port.generateStructured(ctx('graph.extract'), {
        target: TARGET,
        system: 's',
        user: 'u',
        schema: z.object({ a: z.string() }),
        schemaName: 'x',
        ...(row.kind === 'structured_ceiling' ? { maxOutputTokens: 500 } : {}),
      });
    } else if (row.kind === 'chat') {
      await drain(web.port.chat(ctx('ask.respond'), { target: TARGET, messages: [{ role: 'user', content: 'q' }], tools: [], toolChoice: 'auto' }));
    } else {
      await web.port.embed(ctx(row.kind === 'embed_search' ? 'search.embed' : 'graph.embed'), { inputs: ['a'] });
    }
    return { errorClass: 'NO_ERROR' };
  } catch (error) {
    const e = error as KvoxAiError;
    return {
      errorClass: e instanceof KvoxAiError ? e.errorClass : `NOT_KVOX:${String(e)}`,
      retryAfterMs: e.retryAfterMs ?? null,
      message: e.message,
      usage: e.usage ?? null,
    };
  }
}

describe('PlatformAiRuntime: host errors answer as before #579 (frozen table)', () => {
  it.each(parity.rows.map((row) => [`${row.error} / ${row.kind} / ${row.inJob ? 'job' : 'route'}`, row] as const))(
    '%s',
    async (_label, row) => {
      expect(await replay(row)).toEqual({
        errorClass: row.errorClass,
        retryAfterMs: row.retryAfterMs,
        message: row.message,
        usage: row.usage,
      });
    },
  );

  it('leaves a platform AiError and a plain error for the package to classify', () => {
    const plain = new Error('boom');
    expect(translateHostError(plain)).toBe(plain);
    const own = new KvoxAiError('auth', 'x');
    expect(translateHostError(own)).toBe(own);
  });
});

describe('PlatformAiRuntime: the call shape', () => {
  const job: KvoxAiContext = { userId: 'user-1', orgId: 'org-1', jobId: 'job-1', feature: 'notes.generate' };
  const route: KvoxAiContext = { userId: 'user-1', orgId: null, feature: 'notes.generate' };

  it('binds one platform client per round trip to the user, org, feature and job', async () => {
    const web = createWebAiUnderTest();

    await drain(web.port.generateText(job, { target: TARGET, system: 'S', user: 'U', maxOutputTokens: 900 }));
    await drain(web.port.generateText(route, { target: TARGET, system: 'S', user: 'U' }));

    expect(web.forUser).toHaveBeenCalledTimes(2);
    expect(web.forUser).toHaveBeenNthCalledWith(1, 'user-1', { orgId: 'org-1', jobId: 'job-1', feature: 'note_generate' });
    expect(web.forUser).toHaveBeenNthCalledWith(2, 'user-1', { feature: 'note_generate' });
    expect(web.client.stream).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-x', instructions: 'S', input: 'U', maxOutputTokens: 900 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // The platform's target resolver chooses the provider: the request never names it.
    expect(web.client.stream.mock.calls[0][0]).not.toHaveProperty('provider');
  });

  it('sends a structured call as respond with structuredOutput (respondStructured is exactly that)', async () => {
    const web = createWebAiUnderTest();
    web.structured.value = { verdict: 'same' };
    const schema = z.object({ verdict: z.enum(['same', 'different']) });

    await expect(
      web.port.generateStructured({ ...job, feature: 'graph.adjudicate' }, { target: TARGET, system: 'S', user: 'U', schema, schemaName: 'kg_adjudication', maxOutputTokens: 500 }),
    ).resolves.toEqual({ value: { verdict: 'same' }, usage: { inputTokens: 5, outputTokens: 1 } });

    expect(web.forUser).toHaveBeenCalledWith('user-1', { orgId: 'org-1', jobId: 'job-1', feature: 'graph_adjudicate' });
    expect(web.client.respond).toHaveBeenCalledTimes(1);
    expect(web.client.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-x',
        instructions: 'S',
        input: 'U',
        structuredOutput: { name: 'kg_adjudication', schema, strict: true },
        maxOutputTokens: 500,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('embeds with the catalog provider, model and width, as it always did', async () => {
    const web = createWebAiUnderTest();

    const result = await web.port.embed({ ...job, feature: 'search.embed' }, { inputs: ['a', 'b'] });

    expect(result).toMatchObject({ model: 'text-embedding-3-small', dimensions: 1536 });
    expect(result.vectors).toHaveLength(2);
    expect(web.forUser).toHaveBeenCalledWith('user-1', { orgId: 'org-1', jobId: 'job-1', feature: 'search_embed' });
    expect(web.client.embed).toHaveBeenCalledWith(
      { provider: 'openai', model: 'text-embedding-3-small', input: ['a', 'b'], dimensions: 1536 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('makes one platform round trip per Ask step', async () => {
    const web = createWebAiUnderTest();
    const ask: KvoxAiContext = { ...job, feature: 'ask.respond' };
    const step = { target: TARGET, messages: [{ role: 'user' as const, content: 'q' }], tools: [], toolChoice: 'auto' as const };

    await drain(web.port.chat(ask, step));
    await drain(web.port.chat(ask, step));

    expect(web.forUser).toHaveBeenCalledTimes(2);
    expect(web.client.stream).toHaveBeenCalledTimes(2);
  });

  it('answers readiness from the existence of a user_ai_keys row, never selecting the secret', async () => {
    const web = createWebAiUnderTest();

    await expect(web.runtime.readiness({ userId: 'user-1', feature: 'note_generate', provider: 'openai' })).resolves.toEqual({ hasKey: true });
    expect(web.findUnique).toHaveBeenCalledWith({
      where: { userId_provider: { userId: 'user-1', provider: 'openai' } },
      select: { id: true },
    });

    const keyless = createWebAiUnderTest({ hasKey: false });
    await expect(keyless.port.resolveTask(route, 'notes.generate')).rejects.toMatchObject({ errorClass: 'key_missing' });
    expect(keyless.forUser).not.toHaveBeenCalled();
  });

  it('reads the request timeout per call and turns its backstop into a timeout', async () => {
    const web = createWebAiUnderTest({ timeoutMs: 20 });
    web.client.stream.mockImplementationOnce((_req: unknown, options: { signal: AbortSignal }) =>
      (async function* () {
        await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        yield { type: 'response.created', id: 'never' };
      })(),
    );

    await expect(drain(web.port.generateText(job, { target: TARGET, system: 's', user: 'u' }))).rejects.toMatchObject({
      errorClass: 'timeout',
      message: 'The AI request timed out after 20 ms.',
    });
  });
});
