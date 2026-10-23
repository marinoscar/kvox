import { describe, expect, it } from 'vitest';

import { commitBatchSchema, reviewQueueQuerySchema } from '../src/graph/review-queue.js';

const id = '11111111-1111-4111-8111-111111111111';

describe('commitBatchSchema', () => {
  it('accepts exactly one selector', () => {
    expect(commitBatchSchema.safeParse({ batchId: id, policy: 'safe' }).success).toBe(true);
    expect(commitBatchSchema.safeParse({ libraryId: id, policy: 'safe' }).success).toBe(true);
    expect(commitBatchSchema.safeParse({ proposalIds: [id], policy: 'safe' }).success).toBe(true);
  });
  it('refuses none or several selectors, another policy and unknown keys', () => {
    expect(commitBatchSchema.safeParse({ policy: 'safe' }).success).toBe(false);
    expect(commitBatchSchema.safeParse({ batchId: id, libraryId: id, policy: 'safe' }).success).toBe(false);
    expect(commitBatchSchema.safeParse({ batchId: id, policy: 'all' }).success).toBe(false);
    expect(commitBatchSchema.safeParse({ batchId: id, policy: 'safe', x: 1 }).success).toBe(false);
  });
  it('caps proposalIds at 500', () => {
    expect(commitBatchSchema.safeParse({ proposalIds: Array(501).fill(id), policy: 'safe' }).success).toBe(false);
  });
});

describe('reviewQueueQuerySchema', () => {
  it('defaults the limit to 500', () => {
    expect(reviewQueueQuerySchema.parse({}).limit).toBe(500);
  });
});
