import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AI_ERROR_CODES, AiError, type AiErrorCode } from '@marinoscar/platform-api/ai';
import { KvoxAiError } from '@marinoscar/kvox-api/ports';

import type { KvoxAiFeatureId } from '../features/index.js';
import { isErrorLike, refusalFor, scrub, toKvoxAiError } from './kvox-ai-errors.js';

// =============================================================================
// toKvoxAiError against the frozen table of the old two-hop path (issue #579)
// =============================================================================
//
// `test/fixtures/error-parity.v1.json` is what the web edition answered BEFORE
// `createKvoxAi`: every platform `AiErrorCode` (and the generic throwables) thrown
// by the platform client, through `PlatformKvoxAi.fail` -> `mapAiError` -> the port
// adapter's `toKvoxAiError`, per call kind, on a route and in a job. Here the rows
// whose call kind is a plain thrown failure are replayed through the translation
// alone; `test/kvox-ai-error-parity.spec.ts` replays EVERY row through
// `createKvoxAi`, including the structured-output heuristic and the in-band error
// event.
// =============================================================================

const KEY = 'sk-abcdefghij1234567890';

interface Row {
  error: string;
  kind: string;
  inJob: boolean;
  errorClass: string;
  retryAfterMs: number | null;
  message: string;
}

/** The feature each thrown-failure call kind ran under in the capture. */
const FEATURE_OF_KIND: Record<string, KvoxAiFeatureId> = {
  text: 'note_generate',
  chat: 'graph_agent',
  embed_search: 'search_embed',
  embed_graph: 'graph_embed',
};

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

const parity = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/error-parity.v1.json'), 'utf8')) as { rows: Row[] };
const rows = parity.rows.filter((row) => row.kind in FEATURE_OF_KIND);

describe('toKvoxAiError (the frozen parity table)', () => {
  it('covers every platform AiErrorCode', () => {
    const codes = new Set(rows.map((row) => row.error.split('#')[0]).filter((name) => name.startsWith('AI_')));
    expect([...codes].sort()).toEqual([...AI_ERROR_CODES].sort());
  });

  it.each(rows.map((row) => [`${row.error} / ${row.kind} / ${row.inJob ? 'job' : 'route'}`, row] as const))(
    '%s',
    (_label, row) => {
      const out = toKvoxAiError(throwable(row.error), { feature: FEATURE_OF_KIND[row.kind], inJob: row.inJob });

      expect(out).toBeInstanceOf(KvoxAiError);
      expect({ errorClass: out.errorClass, retryAfterMs: out.retryAfterMs ?? null, message: out.message }).toEqual({
        errorClass: row.errorClass,
        retryAfterMs: row.retryAfterMs,
        message: row.message,
      });
    },
  );
});

describe('toKvoxAiError (the rules behind the table)', () => {
  it('returns a KvoxAiError unchanged', () => {
    const own = new KvoxAiError('capability', 'x');
    expect(toKvoxAiError(own, { feature: 'note_generate', inJob: false })).toBe(own);
  });

  it('keeps the provider retry hint of a rate limit in a job, and drops it on a route', () => {
    const limited = new AiError('AI_RATE_LIMITED', 'slow down', { retryAfterMs: 4_000 });
    expect(toKvoxAiError(limited, { feature: 'note_generate', inJob: true }).retryAfterMs).toBe(4_000);
    expect(toKvoxAiError(limited, { feature: 'note_generate', inJob: false }).retryAfterMs).toBeUndefined();
  });

  it('never lets a key-shaped string through', () => {
    const message = toKvoxAiError(
      new Error('Rejected sk-abcdefghij1234567890 and ghp_abcdefghijklmnop and github_pat_11ABCDEFG0123456789'),
      { feature: 'note_generate', inJob: true },
    ).message;
    expect(message).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(message).not.toMatch(/ghp_|gho_|github_pat_/);
    expect(scrub('plain text')).toBe('plain text');
  });

  it('reads a DOMException as an error (it is not an Error in every realm)', () => {
    expect(isErrorLike(new DOMException('x', 'TimeoutError'))).toBe(true);
    expect(isErrorLike({ name: 'n' })).toBe(false);
    expect(isErrorLike('text')).toBe(false);
  });
});

describe('refusalFor', () => {
  it.each([
    ['ai_key_missing', 'key_missing'],
    ['ai_not_configured', 'not_configured'],
    ['graph_disabled', 'not_configured'],
    ['model_lacks_capability', 'capability'],
    ['model_not_permitted', 'capability'],
    [null, 'not_configured'],
  ] as const)('maps the readiness reason %s to %s', (reason, errorClass) => {
    expect(refusalFor({ reason }).errorClass).toBe(errorClass);
  });
});
