import { describe, expect, it } from 'vitest';

import { formatJson, formatStatusLine, shouldUseColour } from './output.js';

// =============================================================================
// Terminal output: stream discipline, colour detection, JSON rendering
// (issue #144, epic #110)
// =============================================================================
//
// Pure-function tests against output.ts's own exported contract. The
// end-to-end guarantees these functions exist to serve -- no ESC byte on
// --raw, byte-identical uncoloured pretty-print, pagination surviving in the
// printed body -- are exercised at the command layer in
// commands/api.test.ts; this file targets the underlying rules directly so a
// regression in the colour/format logic fails here with a precise message
// instead of only as a diff in a much larger integration assertion.
//
// The ESC (0x1B) byte itself is built with String.fromCharCode(27) rather
// than typed as a literal control character or a "\x1b" escape, so nothing
// in this file's own source can be mistaken for the byte under test.
// =============================================================================

const ESC = String.fromCharCode(27);
const ANSI_CODE = new RegExp(ESC + '\\[[0-9]+m', 'g');

describe('shouldUseColour -- precedence', () => {
  it('an explicit --no-color always wins, even over FORCE_COLOR', () => {
    expect(
      shouldUseColour({ requested: false, isTTY: true, env: { FORCE_COLOR: '1' } }),
    ).toBe(false);
  });

  it('NO_COLOR set and non-empty disables colour even on a TTY', () => {
    expect(shouldUseColour({ isTTY: true, env: { NO_COLOR: '1' } })).toBe(false);
  });

  it('NO_COLOR set to an empty string does NOT disable colour (this module treats empty as unset)', () => {
    expect(shouldUseColour({ isTTY: true, env: { NO_COLOR: '' } })).toBe(true);
  });

  it('FORCE_COLOR enables colour even when stdout is not a TTY', () => {
    expect(shouldUseColour({ isTTY: false, env: { FORCE_COLOR: '1' } })).toBe(true);
  });

  it('FORCE_COLOR=0 disables colour, the conventional "off" value', () => {
    expect(shouldUseColour({ isTTY: true, env: { FORCE_COLOR: '0' } })).toBe(false);
  });

  it('TERM=dumb disables colour when neither NO_COLOR nor FORCE_COLOR is set', () => {
    expect(shouldUseColour({ isTTY: true, env: { TERM: 'dumb' } })).toBe(false);
  });

  it('falls back to isTTY when nothing else is set', () => {
    expect(shouldUseColour({ isTTY: true, env: {} })).toBe(true);
    expect(shouldUseColour({ isTTY: false, env: {} })).toBe(false);
  });
});

describe('formatJson -- uncoloured output is byte-identical to JSON.stringify(value, null, 2)', () => {
  it.each([
    { id: 1, name: 'thing', tags: ['a', 'b'], nested: { ok: true, n: null } },
    [1, 2, 3],
    'a plain string',
    42,
    true,
    null,
    {},
    [],
    { data: [{ id: 1 }, { id: 2 }], pagination: { page: 1, total: 2 } },
    { quoted: 'a value with a "quote" and a colon : and a brace {' },
  ])('matches JSON.stringify for %j', (value) => {
    expect(formatJson(value, { colour: false })).toBe(JSON.stringify(value, null, 2));
  });

  it('does not mis-highlight a string value containing braces, quotes or colons (no regex recolouring pass)', () => {
    const value = { details: '{"nested":"looks like json but is just a string"}' };
    expect(formatJson(value, { colour: false })).toBe(JSON.stringify(value, null, 2));
  });
});

describe('formatJson -- coloured output', () => {
  it('emits ESC-prefixed SGR codes when colour is requested', () => {
    const coloured = formatJson({ a: 1 }, { colour: true });
    expect(coloured.includes(ESC)).toBe(true);
    expect(coloured).toMatch(ANSI_CODE);
  });

  it('the structure (bracket/brace/quote placement) matches the uncoloured render once colour codes are stripped', () => {
    const value = { a: 1, b: 'x', c: [true, null] };
    const coloured = formatJson(value, { colour: true });
    const stripped = coloured.replace(ANSI_CODE, '');
    expect(stripped).toBe(formatJson(value, { colour: false }));
  });

  it('produces no ESC byte at all when colour is false, regardless of value shape', () => {
    const value = { data: [{ id: 1 }], pagination: { total: 1 } };
    expect(formatJson(value, { colour: false }).includes(ESC)).toBe(false);
  });
});

describe('formatStatusLine', () => {
  it('includes method, path and a known reason phrase for a 200', () => {
    const line = formatStatusLine({ method: 'GET', path: '/api/auth/me', status: 200, durationMs: 12 });
    expect(line).toContain('GET /api/auth/me');
    expect(line).toContain('200 OK');
    expect(line).toContain('12ms');
  });

  it('falls back to a bare status number for a status with no known reason phrase', () => {
    const line = formatStatusLine({ method: 'GET', path: '/api/x', status: 418, durationMs: 1 });
    expect(line).toContain('418');
    expect(line).not.toContain('418 undefined');
  });

  it('ends with a single newline (a status line, not a fragment)', () => {
    const line = formatStatusLine({ method: 'GET', path: '/x', status: 200, durationMs: 1 });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.match(/\n/g)?.length).toBe(1);
  });
});
