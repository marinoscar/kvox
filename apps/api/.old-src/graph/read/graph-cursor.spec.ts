import { GRAPH_CURSOR_VERSION, GraphCursorError, decodeGraphCursor, encodeGraphCursor } from './graph-cursor';

// graph-cursor.ts (#370): round trip, and every mismatch refuses.

const ID = '6f1c1d3e-0000-4000-8000-000000000001';
const raw = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

describe('graph cursor', () => {
  it('round-trips a position, including a NULLS LAST null key and microseconds', () => {
    const at = encodeGraphCursor('entities:updated', { k: '2026-09-01T10:00:00.123456Z', id: ID });
    expect(decodeGraphCursor(at, 'entities:updated')).toEqual({ k: '2026-09-01T10:00:00.123456Z', id: ID });

    const tail = encodeGraphCursor('timeline', { k: null, id: `rel:${ID}:end` });
    expect(decodeGraphCursor(tail, 'timeline')).toEqual({ k: null, id: `rel:${ID}:end` });
  });

  it('is opaque base64url', () => {
    expect(encodeGraphCursor('mentions', { k: null, id: ID })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a cursor from another route', () => {
    const cursor = encodeGraphCursor('entities:updated', { k: '2026-01-01T00:00:00Z', id: ID });
    expect(() => decodeGraphCursor(cursor, 'entities:viewed')).toThrow(GraphCursorError);
    expect(() => decodeGraphCursor(cursor, 'timeline')).toThrow('belongs to a different list');
  });

  it.each([
    ['not base64 json', 'garbage!!'],
    ['an array', raw([1, 2])],
    ['a number', raw(42)],
    ['another version', raw({ v: GRAPH_CURSOR_VERSION + 1, r: 'timeline', k: null, id: ID })],
    ['an unknown route', raw({ v: GRAPH_CURSOR_VERSION, r: 'nope', k: null, id: ID })],
    ['a missing id', raw({ v: GRAPH_CURSOR_VERSION, r: 'timeline', k: null })],
    ['an empty id', raw({ v: GRAPH_CURSOR_VERSION, r: 'timeline', k: null, id: '' })],
    ['a non-date key', raw({ v: GRAPH_CURSOR_VERSION, r: 'timeline', k: 'yesterday', id: ID })],
    ['a numeric key', raw({ v: GRAPH_CURSOR_VERSION, r: 'timeline', k: 5, id: ID })],
  ])('refuses %s (tampering)', (_label, cursor) => {
    expect(() => decodeGraphCursor(cursor, 'timeline')).toThrow(GraphCursorError);
  });
});
