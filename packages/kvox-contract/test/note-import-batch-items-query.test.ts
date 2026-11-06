import { describe, expect, it } from 'vitest';

import { noteImportBatchItemsQuerySchema } from '../src/notes/index.js';

describe('noteImportBatchItemsQuerySchema', () => {
  it('defaults the limit to 50 and accepts no filters', () => {
    expect(noteImportBatchItemsQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  it('accepts a limit of 500 and rejects 501 and 0', () => {
    expect(noteImportBatchItemsQuerySchema.parse({ limit: '500' }).limit).toBe(500);
    expect(noteImportBatchItemsQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
    expect(noteImportBatchItemsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('trims q and bounds it to 1..200 characters', () => {
    expect(noteImportBatchItemsQuerySchema.parse({ q: '  plan  ' }).q).toBe('plan');
    expect(noteImportBatchItemsQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
    expect(noteImportBatchItemsQuerySchema.safeParse({ q: 'a'.repeat(201) }).success).toBe(false);
    expect(noteImportBatchItemsQuerySchema.safeParse({ q: 'a'.repeat(200) }).success).toBe(true);
  });

  it('accepts an ISO-8601 updatedSince and rejects anything else', () => {
    expect(
      noteImportBatchItemsQuerySchema.safeParse({ updatedSince: '2026-11-06T10:00:00.000Z' })
        .success
    ).toBe(true);
    expect(
      noteImportBatchItemsQuerySchema.safeParse({ updatedSince: '2026-11-06T10:00:00+02:00' })
        .success
    ).toBe(true);
    expect(noteImportBatchItemsQuerySchema.safeParse({ updatedSince: 'yesterday' }).success).toBe(
      false
    );
    expect(noteImportBatchItemsQuerySchema.safeParse({ updatedSince: '2026-11-06' }).success).toBe(
      false
    );
  });

  it('combines q with status', () => {
    expect(noteImportBatchItemsQuerySchema.parse({ q: 'x', status: 'failed' })).toMatchObject({
      q: 'x',
      status: 'failed',
    });
    expect(noteImportBatchItemsQuerySchema.safeParse({ status: 'nope' }).success).toBe(false);
  });
});
