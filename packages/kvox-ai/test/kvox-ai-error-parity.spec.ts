import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';
import { AI_ERROR_CODES, AiError, type AiErrorCode } from '@marinoscar/platform-api/ai';
import { KVOX_AI_ERROR_CLASSES, KvoxAiError, type KvoxAiContext, type KvoxAiTarget } from '@marinoscar/kvox-api/ports';

import { createKvoxAi } from '../src/port/index.js';
import type { KvoxAiRuntime } from '../src/runtime/index.js';

// =============================================================================
// createKvoxAi answers every failure as the web edition did before #579
// =============================================================================
//
// `fixtures/error-parity.v1.json` is FROZEN: it was captured from the old two-hop
// path (`PlatformKvoxAi.fail` -> `mapAiError` -> the port adapter's `toKvoxAiError`)
// by throwing each platform `AiErrorCode` (and each generic throwable) from the
// platform client, for every call kind the port has, on a route and inside a job.
// Each row is replayed here through `createKvoxAi` over a runtime that fails the
// same way, and must give the same class, retry hint, message and usage.
//
// Call kinds: `text` (`generateText`, the stream throws), `text_event` (the stream
// yields an in-band `error` event), `structured` and `structured_ceiling`
// (`generateStructured` without and with an output ceiling, so the truncation
// heuristic runs), `chat`, `chat_event`, `embed_search` and `embed_graph`.
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

const parity = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'error-parity.v1.json'), 'utf8')) as { rows: Row[] };

const TARGET: KvoxAiTarget = { provider: 'openai', model: 'gpt-x', contextWindowTokens: 128_000, maxOutputTokens: 16_384, source: 'task' };

/** The throwable a row names, built exactly as the capture built it. */
function throwable(name: string): unknown {
  const [base, variant] = name.split('#');
  if (base === 'AI_STRUCTURED_OUTPUT_INVALID' && variant === 'not_json') {
    return new AiError('AI_STRUCTURED_OUTPUT_INVALID', `platform not json ${KEY}`, {
      details: { issues: [{ path: [], code: 'invalid_json', message: 'Unexpected end of JSON input' }] },
    });
  }
  if (base === 'AI_STRUCTURED_OUTPUT_INVALID' && variant === 'schema') {
    return new AiError('AI_STRUCTURED_OUTPUT_INVALID', `platform schema ${KEY}`, {
      details: { issues: [{ path: ['verdict'], code: 'invalid_value', message: 'bad' }] },
    });
  }
  if (base.startsWith('AI_')) return new AiError(base as AiErrorCode, `platform ${base} ${KEY}`, { retryAfterMs: 2500 });
  switch (name) {
    case 'Error':
      return new Error(`boom ${KEY}`);
    case 'Error#timeout-sentence':
      return new Error('The AI request timed out after 5 ms.');
    case 'DOMException#TimeoutError':
      return new DOMException('too slow', 'TimeoutError');
    case 'DOMException#AbortError':
      return new DOMException('stopped', 'AbortError');
    case 'string':
      return 'oops';
    case 'KvoxAiError#capability':
      return new KvoxAiError('capability', 'own');
    default:
      throw new Error(`no throwable for ${name}`);
  }
}

/** A runtime whose every round trip fails with `make()` (or yields it as an in-band error event). */
function failingRuntime(make: () => unknown, inBand: boolean): KvoxAiRuntime {
  return {
    async *stream() {
      if (inBand) {
        const err = make() as AiError;
        yield { type: 'error', code: err.code, message: err.message };
        return;
      }
      throw make();
    },
    async create() {
      throw make();
    },
    async embed() {
      throw make();
    },
    async readiness() {
      return { hasKey: true };
    },
  };
}

async function run(row: Row): Promise<Record<string, unknown>> {
  const port = createKvoxAi({
    runtime: failingRuntime(() => throwable(row.error), row.kind.endsWith('_event')),
    taskModels: {
      load: async () => ({
        provider: 'openai',
        models: [],
        policy: {
          enabled: true,
          provider: 'openai',
          defaultModel: null,
          graphEnabled: true,
          taskModels: {},
          reasoningEffort: 'none',
          maxInputTokens: null,
          maxOutputTokens: null,
        },
      }),
    },
    requestTimeoutMs: 600_000,
  });
  const base = { userId: 'u1', orgId: 'o1', ...(row.inJob ? { jobId: 'j1' } : {}) };
  const ctx = (feature: string): KvoxAiContext => ({ ...base, feature });

  try {
    if (row.kind.startsWith('text')) {
      for await (const event of port.generateText(ctx('notes.generate'), { target: TARGET, system: 's', user: 'u' })) void event;
    } else if (row.kind.startsWith('structured')) {
      await port.generateStructured(ctx('graph.extract'), {
        target: TARGET,
        system: 's',
        user: 'u',
        schema: z.object({ a: z.string() }),
        schemaName: 'x',
        ...(row.kind === 'structured_ceiling' ? { maxOutputTokens: 500 } : {}),
      });
    } else if (row.kind.startsWith('chat')) {
      for await (const event of port.chat(ctx('ask.respond'), {
        target: TARGET,
        messages: [{ role: 'user', content: 'q' }],
        tools: [],
        toolChoice: 'auto',
      })) {
        void event;
      }
    } else {
      await port.embed(ctx(row.kind === 'embed_search' ? 'search.embed' : 'graph.embed'), { inputs: ['a'] });
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

describe('createKvoxAi error parity with the pre-#579 web edition (frozen table)', () => {
  it('the table covers every platform AiErrorCode for every call kind, on a route and in a job', () => {
    for (const code of AI_ERROR_CODES) {
      const rows = parity.rows.filter((row) => row.error === code);
      expect(`${code}: ${rows.length}`).toBe(`${code}: 16`);
    }
  });

  it('only ever answers with a known class', () => {
    expect(parity.rows.every((row) => KVOX_AI_ERROR_CLASSES.includes(row.errorClass as never))).toBe(true);
  });

  it.each(parity.rows.map((row) => [`${row.error} / ${row.kind} / ${row.inJob ? 'job' : 'route'}`, row] as const))(
    '%s',
    async (_label, row) => {
      expect(await run(row)).toEqual({
        errorClass: row.errorClass,
        retryAfterMs: row.retryAfterMs,
        message: row.message,
        usage: row.usage,
      });
    },
  );
});
