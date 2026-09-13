import { afterEach, describe, expect, it } from 'vitest';

import { UsageError } from './errors.js';
import { resolveRequestBody, type BodyResolutionContext } from './request-body.js';

// =============================================================================
// Resolving `--data` into a JSON value (issue #144, epic #110)
// =============================================================================
//
// No real file or real stdin is ever touched: `readFile`/`readStdin` are
// injected through `BodyResolutionContext` for every test that needs them,
// exactly as the seam in this module is designed for. The one exception is
// the chunk-boundary decoding test below, which exists specifically to
// exercise the DEFAULT stdin reader's own `for await` + `Buffer.concat`
// logic — the part an injected `readStdin` stub would bypass entirely — so it
// temporarily replaces `process.stdin` with a fake async-iterable stream and
// restores the real one in `finally`.
// =============================================================================

describe('resolveRequestBody — no --data at all', () => {
  it('returns undefined, which is NOT the same as --data null', async () => {
    await expect(resolveRequestBody(undefined)).resolves.toBeUndefined();
  });
});

describe('resolveRequestBody — inline JSON', () => {
  it('parses a plain JSON object', async () => {
    const resolved = await resolveRequestBody('{"a":1}');
    expect(resolved?.value).toEqual({ a: 1 });
    expect(resolved?.kind).toBe('inline');
  });

  it('parses literal null as a present value distinct from "no --data"', async () => {
    const resolved = await resolveRequestBody('null');
    expect(resolved).not.toBeUndefined();
    expect(resolved?.value).toBeNull();
    expect(resolved?.kind).toBe('inline');
  });

  it('parses a JSON array', async () => {
    const resolved = await resolveRequestBody('[1,2,3]');
    expect(resolved?.value).toEqual([1, 2, 3]);
  });

  it('parses a bare JSON number', async () => {
    const resolved = await resolveRequestBody('42');
    expect(resolved?.value).toBe(42);
  });

  it('rejects malformed JSON with a message naming the source', async () => {
    await expect(resolveRequestBody('{not valid')).rejects.toThrow(UsageError);
    await expect(resolveRequestBody('{not valid')).rejects.toThrow(/--data/);
  });

  it('rejects an empty --data value', async () => {
    await expect(resolveRequestBody('   ')).rejects.toThrow(UsageError);
    await expect(resolveRequestBody('   ')).rejects.toThrow(/empty/i);
  });

  it('gives a shell-quoting hint for malformed inline JSON specifically', async () => {
    await expect(resolveRequestBody('{key:value}')).rejects.toThrow(/single quotes/);
  });
});

describe('resolveRequestBody — @file', () => {
  it('reads the named file via the injected readFile and parses its contents', async () => {
    const ctx: BodyResolutionContext = {
      readFile: (path) => {
        expect(path).toBe('body.json');
        return '{"email":"a@b.com"}';
      },
    };

    const resolved = await resolveRequestBody('@body.json', ctx);

    expect(resolved?.value).toEqual({ email: 'a@b.com' });
    expect(resolved?.kind).toBe('file');
    expect(resolved?.description).toBe('body.json');
  });

  it('rejects "--data @" with no filename', async () => {
    await expect(resolveRequestBody('@')).rejects.toThrow(UsageError);
    await expect(resolveRequestBody('@')).rejects.toThrow(/needs a filename/);
  });

  it('a leading @ is consumed as the file marker, so a literal @-prefixed filename needs a doubled @', async () => {
    const ctx: BodyResolutionContext = {
      readFile: (path) => {
        expect(path).toBe('@x.json');
        return '{"ok":true}';
      },
    };

    const resolved = await resolveRequestBody('@@x.json', ctx);
    expect(resolved?.value).toEqual({ ok: true });
  });

  it('reports ENOENT as a clear "file not found" usage error', async () => {
    const ctx: BodyResolutionContext = {
      readFile: () => {
        throw Object.assign(new Error('boom'), { code: 'ENOENT' });
      },
    };

    await expect(resolveRequestBody('@missing.json', ctx)).rejects.toThrow(UsageError);
    await expect(resolveRequestBody('@missing.json', ctx)).rejects.toThrow(/not found/);
  });

  it('reports EISDIR distinctly from ENOENT', async () => {
    const ctx: BodyResolutionContext = {
      readFile: () => {
        throw Object.assign(new Error('boom'), { code: 'EISDIR' });
      },
    };

    await expect(resolveRequestBody('@adir', ctx)).rejects.toThrow(/directory, not a file/);
  });

  it('reports EACCES distinctly from ENOENT', async () => {
    const ctx: BodyResolutionContext = {
      readFile: () => {
        throw Object.assign(new Error('boom'), { code: 'EACCES' });
      },
    };

    await expect(resolveRequestBody('@secret.json', ctx)).rejects.toThrow(/not readable/);
  });

  it('rejects an empty file with a message naming the file, not "--data"', async () => {
    const ctx: BodyResolutionContext = { readFile: () => '   ' };

    await expect(resolveRequestBody('@empty.json', ctx)).rejects.toThrow(/empty\.json is empty/);
  });

  it('rejects malformed JSON from a file, naming the file rather than "--data"', async () => {
    const ctx: BodyResolutionContext = { readFile: () => '{not json' };

    await expect(resolveRequestBody('@bad.json', ctx)).rejects.toThrow(/bad\.json is not valid JSON/);
  });
});

describe('resolveRequestBody — stdin via injected readStdin', () => {
  it('--data - reads stdin through the injected reader', async () => {
    const ctx: BodyResolutionContext = { readStdin: async () => '{"from":"stdin"}' };

    const resolved = await resolveRequestBody('-', ctx);

    expect(resolved?.value).toEqual({ from: 'stdin' });
    expect(resolved?.kind).toBe('stdin');
  });

  it('--data @- is the same sentinel as --data -', async () => {
    const ctx: BodyResolutionContext = { readStdin: async () => '{"from":"at-dash"}' };

    const resolved = await resolveRequestBody('@-', ctx);

    expect(resolved?.value).toEqual({ from: 'at-dash' });
  });

  it('rejects empty stdin', async () => {
    const ctx: BodyResolutionContext = { readStdin: async () => '' };

    await expect(resolveRequestBody('-', ctx)).rejects.toThrow(/stdin was empty/);
  });

  it('rejects malformed JSON from stdin, naming stdin rather than "--data"', async () => {
    const ctx: BodyResolutionContext = { readStdin: async () => '{not json' };

    await expect(resolveRequestBody('-', ctx)).rejects.toThrow(/stdin is not valid JSON/);
  });
});

describe('resolveRequestBody — stdin TTY guard (no injected reader)', () => {
  it('fails immediately instead of hanging when stdin is a TTY', async () => {
    const ctx: BodyResolutionContext = { stdinIsTTY: true };

    await expect(resolveRequestBody('-', ctx)).rejects.toThrow(UsageError);
    await expect(resolveRequestBody('-', ctx)).rejects.toThrow(/stdin is a terminal/);
  });
});

describe('resolveRequestBody — default stdin reader: chunk-boundary UTF-8 decoding', () => {
  // No `readStdin` is injected in this block: these tests exercise the real
  // default reader in request-body.ts, which iterates `process.stdin` and
  // concatenates raw bytes before decoding ONCE at the end. A per-chunk
  // decode would corrupt any multi-byte character split across a chunk
  // boundary — the exact, hard-to-reproduce bug this reader's own comment
  // warns about.
  let originalStdin: PropertyDescriptor | undefined;

  afterEach(() => {
    if (originalStdin) {
      Object.defineProperty(process, 'stdin', originalStdin);
    }
    originalStdin = undefined;
  });

  function installFakeStdin(chunks: Buffer[]): void {
    originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    const fakeStdin = {
      isTTY: false,
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
  }

  it('reassembles a multi-byte character split across a chunk boundary', async () => {
    // A 4-byte UTF-8 emoji (🎉 = F0 9F 8E 89) embedded in a JSON string,
    // split so the boundary falls INSIDE the multi-byte sequence. Decoding
    // each chunk independently would turn each half into U+FFFD replacement
    // characters instead of the original emoji.
    const payload = Buffer.from('{"text":"before 🎉 after"}', 'utf8');
    const splitIndex = payload.indexOf(Buffer.from('🎉', 'utf8')) + 2; // mid-sequence
    installFakeStdin([payload.subarray(0, splitIndex), payload.subarray(splitIndex)]);

    const resolved = await resolveRequestBody('-');

    expect(resolved?.value).toEqual({ text: 'before 🎉 after' });
  });

  it('reassembles correctly even when the split happens byte-by-byte', async () => {
    const payload = Buffer.from('{"text":"€ euro sign"}', 'utf8');
    const chunks = Array.from({ length: payload.length }, (_, i) => payload.subarray(i, i + 1));
    installFakeStdin(chunks);

    const resolved = await resolveRequestBody('-');

    expect(resolved?.value).toEqual({ text: '€ euro sign' });
  });

  it('still works for a single-chunk, plain-ASCII payload (sanity check)', async () => {
    installFakeStdin([Buffer.from('{"ok":true}', 'utf8')]);

    const resolved = await resolveRequestBody('-');

    expect(resolved?.value).toEqual({ ok: true });
  });
});
