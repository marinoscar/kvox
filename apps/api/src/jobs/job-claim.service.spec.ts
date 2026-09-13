// =============================================================================
// Unit tests for JobClaimService (issue #260, epic #254)
// =============================================================================
//
// ⚠ THE CONCURRENCY GUARANTEE IS NOT TESTED HERE, AND CANNOT BE. A mocked
// `$queryRaw` returns whatever this file tells it to, so "two claimers never
// receive the same row" asserted against a mock would prove only that the
// mock was arranged that way. That claim is Postgres's to make and is made in
// `test/jobs/job-claim.db.spec.ts` against a real database.
//
// What IS worth asserting without a database is everything the service
// decides BEFORE the query: the two short circuits (whose entire purpose is
// that no query happens at all — invisible in a database test, which sees the
// same empty result either way) and that the rows the driver returns are
// handed back untouched.
// =============================================================================

import { Job, Prisma } from '@prisma/client';

import { JobClaimService, JOB_CLAIM_COLUMNS } from './job-claim.service';
import type { PrismaService } from '../prisma/prisma.service';

describe('JobClaimService', () => {
  let queryRaw: jest.Mock;
  let service: JobClaimService;

  beforeEach(() => {
    queryRaw = jest.fn();
    service = new JobClaimService({ $queryRaw: queryRaw } as unknown as PrismaService);
  });

  const options = {
    nodeId: null,
    executor: 'server' as const,
    eligibleTypes: ['example.echo'],
    limit: 5,
    leases: [{ type: 'example.echo', leaseMs: 30_000 }],
  };

  describe('short circuits', () => {
    it('returns [] without querying when no type is eligible', async () => {
      // The state a `system`-mode worker is in when no server-only handler is
      // registered — ordinary, not a misconfiguration.
      await expect(service.claim({ ...options, eligibleTypes: [] })).resolves.toEqual([]);
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('returns [] without querying when the limit is zero', async () => {
      // The state a worker pool is in when every slot is busy.
      await expect(service.claim({ ...options, limit: 0 })).resolves.toEqual([]);
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('returns [] without querying when the limit is negative', async () => {
      await expect(service.claim({ ...options, limit: -1 })).resolves.toEqual([]);
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('does query when both are in range', async () => {
      queryRaw.mockResolvedValue([]);
      await expect(service.claim(options)).resolves.toEqual([]);
      expect(queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('the statement it issues', () => {
    it('sends one parameterised statement, with no value interpolated into the SQL text', async () => {
      queryRaw.mockResolvedValue([]);

      await service.claim({
        nodeId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        executor: 'node',
        eligibleTypes: ['a.b', 'c.d'],
        limit: 7,
        leases: [
          { type: 'a.b', leaseMs: 1234 },
          { type: 'c.d', leaseMs: 5678 },
        ],
      });

      const [statement] = queryRaw.mock.calls[0] as [Prisma.Sql];

      // Every runtime value is a bound parameter — INCLUDING the two arrays
      // the per-type lease join is built from. Asserting on `values` rather
      // than on the SQL text is what makes this a test of parameterisation
      // instead of a test of string formatting, and it is the assertion that
      // would fail if the leases were ever expressed as an interpolated
      // `CASE WHEN type = '…'` ladder.
      // Order follows the statement: the MATERIALIZED CTE's type filter and
      // LIMIT first, then the SET values, then the `unnest` pair.
      expect(statement.values).toEqual([
        ['a.b', 'c.d'],
        7,
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        'node',
        ['a.b', 'c.d'],
        [1234, 5678],
      ]);

      // ...and none of those values appears in the SQL text itself.
      for (const literal of ['aaaaaaaa-bbbb', "'node'", '1234', '5678', 'a.b']) {
        expect(statement.sql).not.toContain(literal);
      }
    });

    it('is a single statement — no separate SELECT-then-UPDATE', async () => {
      queryRaw.mockResolvedValue([]);
      await service.claim(options);

      const [statement] = queryRaw.mock.calls[0] as [Prisma.Sql];

      expect(statement.sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(statement.sql).toContain('attempts = attempts + 1');
      // One trailing semicolon at most, and certainly not one in the middle
      // separating two statements.
      expect(statement.sql.replace(/;\s*$/, '')).not.toContain(';');
    });

    it('aliases every Job column in RETURNING', async () => {
      queryRaw.mockResolvedValue([]);
      await service.claim(options);

      const [statement] = queryRaw.mock.calls[0] as [Prisma.Sql];

      for (const [field, column] of Object.entries(JOB_CLAIM_COLUMNS)) {
        expect(statement.sql).toContain(`${column} AS "${field}"`);
      }
    });

    it('qualifies every RETURNING column with `jobs.`, so `type` is unambiguous', async () => {
      // The lease join introduces `l(type, lease_ms)`, which gives the
      // statement a SECOND column called `type`. An unqualified
      // `type AS "type"` is then ambiguous and Postgres rejects the whole
      // claim — a failure a mocked driver cannot reproduce, so the shape is
      // pinned here instead.
      queryRaw.mockResolvedValue([]);
      await service.claim(options);

      const [statement] = queryRaw.mock.calls[0] as [Prisma.Sql];

      for (const [field, column] of Object.entries(JOB_CLAIM_COLUMNS)) {
        expect(statement.sql).toContain(`jobs.${column} AS "${field}"`);
      }
    });
  });

  // ===========================================================================
  // Per-type leases (#346)
  // ===========================================================================

  describe('per-type leases', () => {
    it('joins one lease per type, in the same order as the type array', async () => {
      // The two arrays ARE the join. They must line up index for index, or a
      // row is stamped with another type's lease — which is silent, and shows
      // up hours later as a job reaped mid-run or one held far too long.
      queryRaw.mockResolvedValue([]);

      await service.claim({
        nodeId: null,
        executor: 'server',
        eligibleTypes: ['fast.thing', 'slow.thing'],
        limit: 4,
        leases: [
          { type: 'fast.thing', leaseMs: 60_000 },
          { type: 'slow.thing', leaseMs: 21_600_000 },
        ],
      });

      const [statement] = queryRaw.mock.calls[0] as [Prisma.Sql];

      expect(statement.sql).toContain('unnest(');
      expect(statement.sql).toContain('AS l(type, lease_ms)');
      expect(statement.sql).toContain('jobs.type = l.type');
      expect(statement.values[4]).toEqual(['fast.thing', 'slow.thing']);
      expect(statement.values[5]).toEqual([60_000, 21_600_000]);
    });

    it('filters the inner SELECT on the SAME array the join is built from', async () => {
      // The structural half of "the join can never drop a row": the array the
      // inner SELECT can return types from is the array `l` has rows for.
      queryRaw.mockResolvedValue([]);

      await service.claim({ ...options, eligibleTypes: ['a.b', 'c.d'], leases: [
        { type: 'a.b', leaseMs: 1_000 },
        { type: 'c.d', leaseMs: 2_000 },
      ] });

      const [statement] = queryRaw.mock.calls[0] as [Prisma.Sql];

      // Parameter 0 is the CTE's `type = ANY(...)`; parameter 4 is the
      // `unnest` type array. Same value, not merely the same length.
      expect(statement.values[4]).toEqual(statement.values[0]);
    });

    it('covers an eligible type with no lease entry rather than sending undefined', async () => {
      // Unreachable through `buildClaimLeases`, and it must still not be able
      // to put an `undefined` inside a bound `double precision[]` — that
      // fails the statement and stalls every claim in the process over one
      // caller's mistake. A long lease delays one recovery; a missing one
      // breaks the queue.
      queryRaw.mockResolvedValue([]);

      await service.claim({
        nodeId: null,
        executor: 'server',
        eligibleTypes: ['covered', 'forgotten'],
        limit: 1,
        leases: [{ type: 'covered', leaseMs: 1_000 }],
      });

      const [statement] = queryRaw.mock.calls[0] as [Prisma.Sql];

      expect(statement.values[5]).toEqual([1_000, 3_600_000]);
    });

    it('deduplicates the type list so a repeated type cannot join twice', async () => {
      // A node's stored `eligibleTypes` is a database array a caller could
      // have written twice; two `l` rows for one type would leave which lease
      // wins up to Postgres.
      queryRaw.mockResolvedValue([]);

      await service.claim({
        nodeId: null,
        executor: 'server',
        eligibleTypes: ['dupe', 'dupe', 'other'],
        limit: 2,
        leases: [
          { type: 'dupe', leaseMs: 1_000 },
          { type: 'other', leaseMs: 2_000 },
        ],
      });

      const [statement] = queryRaw.mock.calls[0] as [Prisma.Sql];

      expect(statement.values[4]).toEqual(['dupe', 'other']);
      expect(statement.values[5]).toEqual([1_000, 2_000]);
    });

    it('is still ONE statement, with the claim-time attempt charge intact', async () => {
      // The lease join must not have cost the atomicity the whole file exists
      // for, nor the `attempts + 1` the reaper's give-up phase depends on.
      queryRaw.mockResolvedValue([]);
      await service.claim(options);

      const [statement] = queryRaw.mock.calls[0] as [Prisma.Sql];

      expect(statement.sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(statement.sql).toContain('ORDER BY priority ASC, created_at ASC');
      expect(statement.sql).toContain('attempts = attempts + 1');
      expect(statement.sql.replace(/;\s*$/, '')).not.toContain(';');
    });

    it('picks the rows through a MATERIALIZED CTE, not a subquery in the WHERE', async () => {
      // ⚠ THE KEYWORD IS LOAD-BEARING, and this is the only assertion that can
      // notice it going missing without a database. With the `FROM` clause
      // present, a non-materialised pick may be re-evaluated PER OUTER ROW,
      // and because it holds `FOR UPDATE SKIP LOCKED` each re-evaluation steps
      // over the rows the previous one locked and returns new ones — so the
      // claim exceeds its LIMIT. The behavioural proof is in
      // `test/jobs/job-claim.db.spec.ts`; this pins the text so the keyword
      // cannot be dropped in a reformat.
      queryRaw.mockResolvedValue([]);
      await service.claim(options);

      const [statement] = queryRaw.mock.calls[0] as [Prisma.Sql];

      expect(statement.sql).toContain('WITH picked AS MATERIALIZED');
      expect(statement.sql).toContain('jobs.id = p.id');
    });
  });

  it('returns the driver rows unchanged, with no remapping layer', async () => {
    // The rows already ARE `Job` values because of the camelCase aliases —
    // if this service ever grew a mapping step, that would be the place a
    // renamed field could go silently missing.
    const row = { id: 'job-1', type: 'example.echo', attempts: 1 } as unknown as Job;
    queryRaw.mockResolvedValue([row]);

    const claimed = await service.claim(options);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toBe(row);
  });

  it('propagates a database error rather than reporting an empty queue', async () => {
    // "Nothing to do" and "the database is unreachable" must not look the
    // same to a worker: the first is the normal answer, the second has to be
    // visible.
    queryRaw.mockRejectedValue(new Error('connection terminated'));
    await expect(service.claim(options)).rejects.toThrow('connection terminated');
  });
});
