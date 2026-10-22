import { describe, expect, it } from 'vitest';

import { listEntitiesQuerySchema } from '../src/graph/graph-read.js';

describe('listEntitiesQuerySchema (GIC-09: sort=mentions and since)', () => {
  it('keeps `updated` the default and leaves `since` unset', () => {
    const parsed = listEntitiesQuerySchema.parse({});
    expect(parsed.sort).toBe('updated');
    expect(parsed.since).toBeUndefined();
  });

  it('accepts sort=mentions with a date or a datetime with an offset', () => {
    expect(listEntitiesQuerySchema.parse({ sort: 'mentions', since: '2026-09-21' }).since).toBe('2026-09-21');
    expect(
      listEntitiesQuerySchema.parse({ sort: 'mentions', since: '2026-09-21T10:00:00+02:00' }).since,
    ).toBe('2026-09-21T10:00:00+02:00');
  });

  it.each(['yesterday', '2026-13-01', '2026-09-21T10:00:00', ''])('refuses since=%s', (since) => {
    expect(listEntitiesQuerySchema.safeParse({ sort: 'mentions', since }).success).toBe(false);
  });

  it('still refuses an unknown sort', () => {
    expect(listEntitiesQuerySchema.safeParse({ sort: 'popular' }).success).toBe(false);
  });
});
