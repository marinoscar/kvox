// =============================================================================
// PrismaService is the platform's `PLATFORM_PRISMA`: the shape it must keep
// (#757)
// =============================================================================
//
// `@marinoscar/platform-api` 0.1.0-next.16 calls `PLATFORM_PRISMA.forOrg(orgId,
// { userId? })` (AI usage recorder, limits, runs, output writer, usage report)
// and `PLATFORM_PRISMA.runInOrg(orgId, fn, opts)` (`AiRunsService.create`, the
// storage `storageRunInOrg` helper). KVox's service lacked `forOrg` and its
// `runInOrg` took only an `{ orgId }` scope object, so `GET /api/ai/usage/me`
// answered 500 `this.prisma.forOrg is not a function` and every AI call's usage
// write failed. This spec pins both shapes with no database; the real-Postgres
// proof is `test/rls/prisma-for-org.db.spec.ts`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../src/prisma/prisma.service';

/** A stand-in transaction client recording each `set_config` statement's bound values. */
function fakeClient() {
  const statements: unknown[][] = [];
  const tx = {
    $executeRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(values);
      return 1;
    }),
  };
  const transactionOptions: unknown[] = [];
  const client = {
    // A real client has `$connect` / `$extends`; core tells it from a transaction client by them.
    $connect: jest.fn(),
    $extends: jest.fn(),
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>, options?: unknown) => {
      transactionOptions.push(options);
      return fn(tx);
    }),
  };
  return { client, tx, statements, transactionOptions };
}

const runInOrg = PrismaService.prototype.runInOrg as (
  this: unknown,
  ...args: unknown[]
) => Promise<unknown>;

describe('PrismaService platform shape', () => {
  it('exposes forOrg, runInOrg and forUser as functions', () => {
    expect(typeof PrismaService.prototype.forOrg).toBe('function');
    expect(typeof PrismaService.prototype.runInOrg).toBe('function');
  });

  it('forOrg returns an extended client from $extends', () => {
    const extended = { marker: 'extended' };
    const $extends = jest.fn().mockReturnValue(extended);
    const orgId = randomUUID();
    const userId = randomUUID();

    const result = PrismaService.prototype.forOrg.call({ $extends } as never, orgId, { userId });

    expect(result).toBe(extended);
    expect($extends).toHaveBeenCalledTimes(1);
  });

  describe('runInOrg', () => {
    it('keeps the scope-object shape (settings and sharing adapters)', async () => {
      const { client, statements, transactionOptions } = fakeClient();
      const orgId = randomUUID();
      const userId = randomUUID();

      const out = await runInOrg.call(client, { orgId, userId }, async () => 'done', { timeout: 1234 });

      expect(out).toBe('done');
      expect(statements).toEqual([[orgId, userId]]);
      expect(transactionOptions).toEqual([{ timeout: 1234 }]);
    });

    it('accepts the platform shape: an org id, then fn, then { userId, ...tx options }', async () => {
      const { client, tx, statements, transactionOptions } = fakeClient();
      const orgId = randomUUID();
      const userId = randomUUID();

      const out = await runInOrg.call(client, orgId, async (t: unknown) => (t === tx ? 'tx' : 'other'), {
        userId,
        maxWait: 50,
        timeout: 99,
      });

      expect(out).toBe('tx');
      expect(statements).toEqual([[orgId, userId]]);
      // userId is the scope, not a Prisma transaction option.
      expect(transactionOptions).toEqual([{ maxWait: 50, timeout: 99 }]);
    });

    it('accepts the platform shape with no options', async () => {
      const { client, statements } = fakeClient();
      const orgId = randomUUID();

      await runInOrg.call(client, orgId, async () => undefined);

      expect(statements).toEqual([[orgId, '']]);
    });
  });
});
