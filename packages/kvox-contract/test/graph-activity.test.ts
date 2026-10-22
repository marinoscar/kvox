import { describe, expect, it } from 'vitest';

import {
  GRAPH_ACTIVITY_MAX_IDS,
  graphActivityQuerySchema,
  graphActivityResponseSchema,
} from '../src/graph/graph-read.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('graph activity contract (GIC-15)', () => {
  it('splits the ids, drops duplicates and defaults the bucket to month', () => {
    const parsed = graphActivityQuerySchema.parse({ ids: `${id(1)}, ${id(2)},${id(1)}` });
    expect(parsed.ids).toEqual([id(1), id(2)]);
    expect(parsed.bucket).toBe('month');
    expect(parsed.from).toBeUndefined();
  });

  it('accepts exactly 300 ids and refuses 301', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => id(i)).join(',');
    expect(GRAPH_ACTIVITY_MAX_IDS).toBe(300);
    expect(graphActivityQuerySchema.safeParse({ ids: ids(300) }).success).toBe(true);
    expect(graphActivityQuerySchema.safeParse({ ids: ids(301) }).success).toBe(false);
  });

  it('refuses missing, empty and non-uuid ids', () => {
    for (const ids of [undefined, '', ',', 'nope', `${id(1)},nope`]) {
      expect(graphActivityQuerySchema.safeParse({ ids }).success).toBe(false);
    }
  });

  it('takes week or month, and from/to as a date or an offset datetime', () => {
    expect(graphActivityQuerySchema.safeParse({ ids: id(1), bucket: 'week' }).success).toBe(true);
    expect(graphActivityQuerySchema.safeParse({ ids: id(1), bucket: 'day' }).success).toBe(false);
    expect(
      graphActivityQuerySchema.safeParse({ ids: id(1), from: '2026-01-01', to: '2026-04-01T00:00:00Z' }).success,
    ).toBe(true);
    expect(graphActivityQuerySchema.safeParse({ ids: id(1), from: 'yesterday' }).success).toBe(false);
    expect(graphActivityQuerySchema.safeParse({ ids: id(1), to: '2026-04-01T00:00:00' }).success).toBe(false);
  });

  it('parses a response, including the empty one', () => {
    const response = {
      bucket: 'month',
      series: [{ start: '2026-01-01', total: 9, byType: { Person: 5, Project: 4 } }],
      byEntity: { [id(1)]: [{ start: '2026-01-01', count: 3 }] },
    };
    expect(graphActivityResponseSchema.parse(response)).toEqual(response);
    expect(graphActivityResponseSchema.safeParse({ bucket: 'week', series: [], byEntity: {} }).success).toBe(true);
    expect(graphActivityResponseSchema.safeParse({ ...response, bucket: 'day' }).success).toBe(false);
    expect(
      graphActivityResponseSchema.safeParse({ ...response, byEntity: { [id(1)]: [{ start: '2026-01-01', count: 0 }] } }).success,
    ).toBe(false);
  });
});
