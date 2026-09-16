// =============================================================================
// `search-cursor.ts` — the cursor that refuses (issue #175, epic #164)
// =============================================================================
//
// The behaviour under test is the one that DIVERGES from the rest of this
// codebase: `decodeCursor` in `transcripts.service.ts` returns `null` for
// anything it cannot use, so a stale cursor silently restarts a newest-first
// feed. This one throws, because a silently restarted RELEVANCE list is
// indistinguishable from a real page 2 and a user would page through the same
// rows forever. Every `it` below is a case where the forgiving behaviour would
// have been wrong.
// =============================================================================

import {
  decodeSearchCursor,
  encodeSearchCursor,
  fingerprintScope,
  RANKING_MODEL_VERSION,
  SearchCursorError,
  type SearchCursorScope,
} from './search-cursor';

const SCOPE: SearchCursorScope = {
  q: 'quarterly pricing review',
  types: ['transcript', 'note'],
  userId: '11111111-1111-4111-8111-111111111111',
};

const OTHER_USER = '22222222-2222-4222-8222-222222222222';

describe('encode/decode round trip', () => {
  it('returns the offset it was minted with', () => {
    expect(decodeSearchCursor(encodeSearchCursor(SCOPE, 0), SCOPE)).toBe(0);
    expect(decodeSearchCursor(encodeSearchCursor(SCOPE, 20), SCOPE)).toBe(20);
    expect(decodeSearchCursor(encodeSearchCursor(SCOPE, 180), SCOPE)).toBe(180);
  });

  it('is opaque on the wire — base64url, no padding, URL-safe', () => {
    const cursor = encodeSearchCursor(SCOPE, 20);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('accepts a cursor whose type filter was spelled in a different order', () => {
    // `parseTypesParam` normalises order, and the fingerprint sorts again, so
    // `note,transcript` and `transcript,note` share a cursor. A client that
    // reorders its filter chips between pages must not get a 400.
    const reordered: SearchCursorScope = { ...SCOPE, types: ['note', 'transcript'] };

    expect(decodeSearchCursor(encodeSearchCursor(SCOPE, 20), reordered)).toBe(20);
  });

  it('accepts a cursor whose query text differs only in whitespace', () => {
    const respaced: SearchCursorScope = { ...SCOPE, q: '  quarterly   pricing review  ' };

    expect(decodeSearchCursor(encodeSearchCursor(SCOPE, 20), respaced)).toBe(20);
  });
});

describe('refusal', () => {
  it('refuses a cursor minted for query A when presented against query B', () => {
    const cursor = encodeSearchCursor(SCOPE, 20);
    const otherQuery: SearchCursorScope = { ...SCOPE, q: 'annual budget' };

    expect(() => decodeSearchCursor(cursor, otherQuery)).toThrow(SearchCursorError);
  });

  it('refuses a cursor minted for a different type filter', () => {
    const cursor = encodeSearchCursor(SCOPE, 20);
    const notesOnly: SearchCursorScope = { ...SCOPE, types: ['note'] };

    // Dropping a type removes rows from the MIDDLE of the ranking, so every
    // offset after the first removed row names a different document.
    expect(() => decodeSearchCursor(cursor, notesOnly)).toThrow(SearchCursorError);
  });

  it('refuses a cursor minted for a different user', () => {
    const cursor = encodeSearchCursor(SCOPE, 20);
    const otherUser: SearchCursorScope = { ...SCOPE, userId: OTHER_USER };

    // Visibility is applied inside the candidate window, so two users running
    // the identical query get differently numbered windows.
    expect(() => decodeSearchCursor(cursor, otherUser)).toThrow(SearchCursorError);
  });

  it('refuses every cursor across a RANKING_MODEL_VERSION bump', () => {
    // The mechanism, asserted rather than described: a cursor minted under the
    // current constant must not verify against a fingerprint computed with a
    // different one. Simulated by hashing the same scope under the next
    // version — `fingerprintScope` takes the constant from module scope, so
    // this reproduces what a bump does to a client's in-flight cursor.
    const beforeBump = fingerprintScope(SCOPE);

    const afterBump = require('node:crypto')
      .createHash('sha256')
      .update(
        [
          String(RANKING_MODEL_VERSION + 1),
          SCOPE.q,
          [...SCOPE.types].sort().join(','),
          SCOPE.userId,
        ].join('\n'),
        'utf8',
      )
      .digest('hex')
      .slice(0, 40);

    expect(afterBump).not.toBe(beforeBump);

    const stale = Buffer.from(JSON.stringify({ f: afterBump, o: 20 }), 'utf8').toString(
      'base64url',
    );

    expect(() => decodeSearchCursor(stale, SCOPE)).toThrow(SearchCursorError);
  });

  it('refuses garbage rather than silently restarting at offset 0', () => {
    // THE DIVERGENCE FROM `transcripts.service.ts`'s `decodeCursor`, which
    // returns `null` here on purpose. Restarting a relevance list silently
    // serves page 1 under a "next page" click.
    for (const garbage of ['not-base64url!!', '', 'eyJub3BlIjoxfQ', 'YWJjZGVm']) {
      expect(() => decodeSearchCursor(garbage, SCOPE)).toThrow(SearchCursorError);
    }
  });

  it('refuses a cursor whose offset is not a non-negative integer', () => {
    for (const offset of [-1, 1.5, Number.NaN, '20']) {
      const forged = Buffer.from(
        JSON.stringify({ f: fingerprintScope(SCOPE), o: offset }),
        'utf8',
      ).toString('base64url');

      expect(() => decodeSearchCursor(forged, SCOPE)).toThrow(SearchCursorError);
    }
  });

  it('names the reason, so a client can tell a stale cursor from a bug', () => {
    const cursor = encodeSearchCursor(SCOPE, 20);
    const otherQuery: SearchCursorScope = { ...SCOPE, q: 'annual budget' };

    expect(() => decodeSearchCursor(cursor, otherQuery)).toThrow(/different search/i);
  });
});

describe('fingerprintScope', () => {
  it('is stable for the same scope', () => {
    expect(fingerprintScope(SCOPE)).toBe(fingerprintScope({ ...SCOPE }));
  });

  it('cannot be collided by moving a delimiter between fields', () => {
    // The inputs are joined with `\n`, which `normalizeQueryText` guarantees
    // cannot appear inside `q`. Without that, a query containing the delimiter
    // could impersonate a different (q, types, user) triple.
    const a = fingerprintScope({ ...SCOPE, q: 'a', userId: 'b\nc' });
    const b = fingerprintScope({ ...SCOPE, q: 'a\nb', userId: 'c' });

    expect(a).not.toBe(b);
  });
});
