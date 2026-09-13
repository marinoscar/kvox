// =============================================================================
// Unit tests for JobsService (issue #260, epic #254)
// =============================================================================
//
// The dedup RACE is proved against a real database in
// `test/jobs/jobs-enqueue.db.spec.ts` — a mock cannot demonstrate what a
// partial unique index does when two inserts collide. What a mock CAN do,
// and what a database test cannot do conveniently, is drive the branches
// around that conflict deterministically:
//
//   - a P2002 on some OTHER constraint must propagate untouched;
//   - the re-read losing its own race (the conflicting job settling in the
//     microseconds between the failed insert and the SELECT) must retry
//     rather than throw or return a finished job;
//   - the bounded retry must eventually give up loudly instead of spinning.
//
// Each of those needs the database to fail on cue, which is exactly what a
// real database will not reliably do.
// =============================================================================

import { Job, Prisma } from '@prisma/client';

import { buildDedupKey } from './job-keys';
import { isActiveDedupConflict, JobsService } from './jobs.service';
import type { PrismaService } from '../prisma/prisma.service';

/** A P2002 shaped the way `@prisma/adapter-pg` reports one. */
function adapterConflict(constraintFields: string[], indexName: string) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: {
      modelName: 'Job',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: `duplicate key value violates unique constraint "${indexName}"`,
          kind: 'UniqueConstraintViolation',
          constraint: { fields: constraintFields },
        },
      },
    },
  });
}

/** A P2002 shaped the way the classic (non-adapter) query engine reports one. */
function classicConflict(target: string[] | string) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

const jobRow = (overrides: Partial<Job> = {}): Job =>
  ({
    id: 'job-1',
    type: 'example.echo',
    status: 'pending',
    attempts: 0,
    ...overrides,
  }) as Job;

describe('isActiveDedupConflict', () => {
  it('recognises the driver-adapter shape by constraint fields', () => {
    expect(
      isActiveDedupConflict(adapterConflict(['dedup_key'], 'jobs_active_dedup_uniq_idx'))
    ).toBe(true);
  });

  it('recognises the driver-adapter shape by the index named in the original message', () => {
    // Constraint detail absent, message still names the index.
    expect(isActiveDedupConflict(adapterConflict([], 'jobs_active_dedup_uniq_idx'))).toBe(true);
  });

  it('recognises the classic query-engine shape', () => {
    expect(isActiveDedupConflict(classicConflict(['dedupKey']))).toBe(true);
    expect(isActiveDedupConflict(classicConflict('jobs_active_dedup_uniq_idx'))).toBe(true);
  });

  it('does NOT claim a conflict on some other unique constraint', () => {
    // The discrimination that keeps a genuine constraint bug loud instead of
    // silently returning an unrelated row.
    expect(isActiveDedupConflict(adapterConflict(['id'], 'jobs_pkey'))).toBe(false);
    expect(isActiveDedupConflict(classicConflict(['email']))).toBe(false);
  });

  it('does not treat a non-P2002 Prisma error, or a plain Error, as a dedup conflict', () => {
    const notFound = new Prisma.PrismaClientKnownRequestError('nope', {
      code: 'P2025',
      clientVersion: 'test',
    });
    expect(isActiveDedupConflict(notFound)).toBe(false);
    expect(isActiveDedupConflict(new Error('boom'))).toBe(false);
    expect(isActiveDedupConflict(undefined)).toBe(false);
  });
});

describe('JobsService', () => {
  let create: jest.Mock;
  let findFirst: jest.Mock;
  let update: jest.Mock;
  let service: JobsService;

  beforeEach(() => {
    create = jest.fn();
    findFirst = jest.fn();
    update = jest.fn();
    service = new JobsService({
      job: { create, findFirst, update },
    } as unknown as PrismaService);

    // Silence the service's own logging; the assertions are about behaviour.
    jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  describe('enqueue: the dedup key it writes', () => {
    it('builds the key from type and subject via buildDedupKey', async () => {
      create.mockResolvedValue(jobRow());

      await service.enqueue({
        type: 'export.csv',
        reason: 'rerun',
        subjectType: 'report',
        subjectId: 'q3',
      });

      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          dedupKey: buildDedupKey('export.csv', 'report', 'q3'),
        }),
      });
    });

    it('leaves the key NULL for skipDedup, which is the entire opt-out', async () => {
      create.mockResolvedValue(jobRow());

      await service.enqueue({
        type: 'export.csv',
        reason: 'rerun',
        subjectType: 'report',
        subjectId: 'q3',
        skipDedup: true,
      });

      // NULL, not a different insert strategy — Postgres treats every NULL as
      // distinct, so the row simply cannot collide.
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({ dedupKey: null }),
      });
    });

    it('never pre-checks for an existing job before inserting', async () => {
      create.mockResolvedValue(jobRow());

      await service.enqueue({ type: 'example.echo', reason: 'upload' });

      // `findFirst`-then-`create` is the rejected design: it is a
      // check-then-act race precisely when dedup matters. The insert goes
      // first, always.
      expect(findFirst).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('passes optional fields through and omits the ones not given', async () => {
      create.mockResolvedValue(jobRow());
      const scheduledFor = new Date('2030-01-01T00:00:00Z');

      await service.enqueue({
        type: 'example.echo',
        reason: 'backfill',
        payload: { a: 1 },
        priority: -3,
        scheduledFor,
      });

      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          reason: 'backfill',
          payload: { a: 1 },
          priority: -3,
          scheduledFor,
          subjectType: null,
          subjectId: null,
        }),
      });
    });

    it('leaves priority, scheduledFor and payload unset when omitted, so column defaults apply', async () => {
      create.mockResolvedValue(jobRow());

      await service.enqueue({ type: 'example.echo', reason: 'upload' });

      const { data } = create.mock.calls[0][0];
      expect(data.priority).toBeUndefined();
      expect(data.scheduledFor).toBeUndefined();
      expect(data.payload).toBeUndefined();
    });
  });

  describe('enqueue: what happens on a conflict', () => {
    it('returns the existing ACTIVE job instead of throwing', async () => {
      const existing = jobRow({ id: 'winner', status: 'running' });
      create.mockRejectedValue(adapterConflict(['dedup_key'], 'jobs_active_dedup_uniq_idx'));
      findFirst.mockResolvedValue(existing);

      const result = await service.enqueue({ type: 'example.echo', reason: 'upload' });

      expect(result).toBe(existing);
      // The re-read asks for exactly the set the partial index defends.
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { in: ['pending', 'running'] } }),
        })
      );
    });

    it('propagates a P2002 raised by any OTHER constraint', async () => {
      const other = adapterConflict(['id'], 'jobs_pkey');
      create.mockRejectedValue(other);

      await expect(service.enqueue({ type: 'example.echo', reason: 'upload' })).rejects.toBe(other);
      // It must not go looking for an "existing" job for an unrelated bug.
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('propagates a non-conflict database error untouched', async () => {
      const boom = new Error('connection terminated');
      create.mockRejectedValue(boom);

      await expect(service.enqueue({ type: 'example.echo', reason: 'upload' })).rejects.toBe(boom);
    });

    it('retries the insert when the conflicting job settles before the re-read', async () => {
      // The race inside the race: the holder reached `succeeded` between the
      // failed INSERT and the SELECT, so it left the index's predicate and
      // there is no active row to return. The key is free now — insert again.
      const eventual = jobRow({ id: 'second-try' });
      create
        .mockRejectedValueOnce(adapterConflict(['dedup_key'], 'jobs_active_dedup_uniq_idx'))
        .mockResolvedValueOnce(eventual);
      findFirst.mockResolvedValue(null);

      const result = await service.enqueue({ type: 'example.echo', reason: 'upload' });

      expect(result).toBe(eventual);
      expect(create).toHaveBeenCalledTimes(2);
    });

    it('never returns a job that has already settled', async () => {
      // Guards the rejected alternative: widening the re-read to any status
      // would hand the caller a finished job and report queued work that will
      // never run. `findActiveByDedupKey` filters to pending/running, so a
      // settled holder simply is not found and the insert is retried.
      const fresh = jobRow({ id: 'fresh', status: 'pending' });
      create
        .mockRejectedValueOnce(adapterConflict(['dedup_key'], 'jobs_active_dedup_uniq_idx'))
        .mockResolvedValueOnce(fresh);
      findFirst.mockResolvedValue(null);

      const result = await service.enqueue({ type: 'example.echo', reason: 'upload' });

      expect(result.status).toBe('pending');
    });

    it('gives up loudly rather than spinning when the key keeps being taken and released', async () => {
      // A pathological key: every insert conflicts and every re-read finds
      // nothing. Bounded, so this is a visible error rather than a hung
      // request.
      const conflict = adapterConflict(['dedup_key'], 'jobs_active_dedup_uniq_idx');
      create.mockRejectedValue(conflict);
      findFirst.mockResolvedValue(null);

      await expect(service.enqueue({ type: 'example.echo', reason: 'upload' })).rejects.toBe(
        conflict
      );
      expect(create).toHaveBeenCalledTimes(3);
    });
  });

  describe('recordProvider', () => {
    it('writes the audit columns', async () => {
      update.mockResolvedValue(jobRow());

      await service.recordProvider('job-1', 'provider-a', 'v3');

      expect(update).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        data: { providerKey: 'provider-a', modelVersion: 'v3' },
      });
    });

    it('NEVER throws — it logs and swallows', async () => {
      // These columns are audit only; nothing reads them to make a decision.
      // Letting a failed annotation propagate would fail a job whose real
      // work already succeeded, turning a missing note into a needless retry.
      update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record not found', {
          code: 'P2025',
          clientVersion: 'test',
        })
      );

      await expect(service.recordProvider('gone', 'provider-a', 'v3')).resolves.toBeUndefined();
      expect(service['logger'].warn).toHaveBeenCalled();
    });

    it('swallows a non-Prisma failure too', async () => {
      update.mockRejectedValue('a thrown string, not an Error');

      await expect(service.recordProvider('job-1', null, null)).resolves.toBeUndefined();
    });
  });
});
