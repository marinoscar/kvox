import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import {
  confirmationFor,
  USER_DATA_PURGE_JOB_TYPE,
  USER_DATA_SCOPES,
  USER_DATA_SUBJECT_TYPE,
  type UserDataScope,
} from './job-types';
import { userDataSummarySchema } from './dto/user-data.dto';
import { userDataCategories } from './user-data.registries';
import { readPurgePayload, UserDataService } from './user-data.service';
import { JobsService } from '@marinoscar/platform-api/jobs';

// =============================================================================
// UserDataService (issue #80)
// =============================================================================
//
// ⚠ THE 409 THIS FILE MOST CARES ABOUT IS THE `requestId` ROUND-TRIP, NOT THE
// `findFirst` ABOVE IT. `requestDeletion` also does a courtesy read first, but
// the real enforcement — per the service's own header — is that
// `JobsService.enqueue` deduplicates on the queue's own partial unique index
// and returns the JOB THAT ALREADY HOLDS THE KEY rather than throwing. So the
// mechanism under test is: generate a `requestId`, enqueue, and compare it to
// the one on the job that comes back. Same id -> 202. Different id -> 409.
// =============================================================================

const USER_ID = 'user-1';

describe('readPurgePayload', () => {
  it('parses a payload carrying a valid userId and scope', () => {
    expect(readPurgePayload({ userId: USER_ID, scope: 'everything' })).toEqual({
      userId: USER_ID,
      scope: 'everything',
      requestId: undefined,
    });
  });

  it('carries the requestId through when present', () => {
    expect(readPurgePayload({ userId: USER_ID, scope: 'notes', requestId: 'req-1' })).toEqual({
      userId: USER_ID,
      scope: 'notes',
      requestId: 'req-1',
    });
  });

  it.each([
    ['null', null],
    ['a string', 'not-an-object'],
    ['an array', ['user-1']],
    ['missing userId', { scope: 'everything' }],
    ['an empty userId', { userId: '', scope: 'everything' }],
    ['a non-string userId', { userId: 7, scope: 'everything' }],
    ['missing scope', { userId: USER_ID }],
    ['a non-string scope', { userId: USER_ID, scope: 3 }],
    // ⚠ CHECKED AGAINST THE LIST, not merely `typeof === 'string'` — an
    // unknown scope name reaching the handler would fall through every
    // `scopeIncludes` branch and delete nothing while reporting success.
    ['a scope this build does not have', { userId: USER_ID, scope: 'literally-everything' }],
  ])('is not a purge payload: %s', (_label, value) => {
    expect(readPurgePayload(value)).toBeNull();
  });
});

/**
 * The registered summary categories' hooks, as stubs. A summary is ASSEMBLED
 * from the category registry (issue #460), so what the service owns — and what
 * is pinned here — is the assembly: which hooks it calls, with which user, in
 * which key order, with `activeDeletion` last. What each hook counts is pinned
 * beside the hook (`*.user-data.spec.ts`, `user-data.base.spec.ts`).
 *
 * A Proxy rather than hand-written stubs so this spec names no domain method.
 * Each call answers `{ method, userId }`, which makes "this key came from that
 * hook" assertable.
 */
function summaryHookProviders(calls: string[]) {
  const tokens = new Set(
    userDataCategories()
      .map((category) => category.summary?.inject)
      .filter((inject): inject is string => typeof inject === 'string'),
  );

  return [...tokens].map((token) => ({
    provide: token,
    useValue: new Proxy(
      {},
      {
        get: (_target, method) => {
          if (method === 'then') return undefined;

          return async (userId: string) => {
            calls.push(`${token}.${String(method)}`);
            return { method: String(method), userId };
          };
        },
      },
    ),
  }));
}

describe('UserDataService', () => {
  let service: UserDataService;
  let prisma: {
    job: { findFirst: jest.Mock };
    auditEvent: { create: jest.Mock };
  };
  let jobs: { enqueue: jest.Mock };
  let hookCalls: string[];

  beforeEach(async () => {
    prisma = {
      job: { findFirst: jest.fn().mockResolvedValue(null) },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
    };

    jobs = { enqueue: jest.fn() };
    hookCalls = [];

    const module = await Test.createTestingModule({
      providers: [
        UserDataService,
        { provide: PrismaService, useValue: prisma },
        { provide: JobsService, useValue: jobs },
        ...summaryHookProviders(hookCalls),
      ],
    }).compile();

    service = module.get(UserDataService);
  });

  // ---------------------------------------------------------------------------
  // summary()
  // ---------------------------------------------------------------------------

  describe('summary', () => {
    // ⚠ THE WIRE-VISIBLE KEY ORDER of `GET /api/user-data/summary`, and the
    // reason it is asserted on a service whose categories are registered
    // elsewhere: the order is the registry's `order`, not an array literal
    // here, so a re-registration is what could silently change it.
    it('assembles one key per registered summary, in category order, with activeDeletion last', async () => {
      const result = await service.summary(USER_ID);

      expect(Object.keys(result)).toEqual([
        'transcripts',
        'notes',
        'files',
        'noteTemplates',
        'credentials',
        'graph',
        'askConversations',
        'activeDeletion',
      ]);
    });

    it('asks every registered summary hook once, for the caller', async () => {
      const result = await service.summary(USER_ID);

      const summaries = userDataCategories().filter((category) => category.summary);

      expect(hookCalls).toHaveLength(summaries.length);
      for (const key of Object.keys(result).filter((k) => k !== 'activeDeletion')) {
        expect(result[key]).toEqual({ method: expect.any(String), userId: USER_ID });
      }
    });

    it('publishes a response schema with exactly the same keys, in the same order', () => {
      expect(Object.keys(userDataSummarySchema.shape)).toEqual([
        'transcripts',
        'notes',
        'files',
        'noteTemplates',
        'credentials',
        'graph',
        'askConversations',
        'activeDeletion',
      ]);
    });

    // ⚠ A HOOK THAT CANNOT BE RESOLVED FAILS THE REQUEST. Reporting a category
    // as simply absent would show a Danger Zone that omits a row of data the
    // deployment is holding.
    it('fails the request when a summary hook cannot be resolved', async () => {
      const module = await Test.createTestingModule({
        providers: [
          UserDataService,
          { provide: PrismaService, useValue: prisma },
          { provide: JobsService, useValue: jobs },
          // No hook providers at all.
        ],
      }).compile();

      await expect(module.get(UserDataService).summary(USER_ID)).rejects.toThrow(
        /summary hook .* could not be resolved/,
      );
    });

    it('reports activeDeletion as null when nothing is running', async () => {
      prisma.job.findFirst.mockResolvedValue(null);

      const result = await service.summary(USER_ID);

      expect(result.activeDeletion).toBeNull();
    });

    it('reports the deletion already pending or running for this caller', async () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');

      prisma.job.findFirst.mockResolvedValue({
        id: 'job-9',
        status: 'running',
        createdAt,
        payload: { userId: USER_ID, scope: 'notes' },
      });

      const result = await service.summary(USER_ID);

      expect(result.activeDeletion).toEqual({
        id: 'job-9',
        scope: 'notes',
        status: 'running',
        requestedAt: createdAt.toISOString(),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // requestDeletion() — confirmation
  // ---------------------------------------------------------------------------

  describe('requestDeletion — confirmation is compared exactly', () => {
    it.each([
      ['lowercase', 'everything'],
      ['leading whitespace', ' EVERYTHING'],
      ['trailing whitespace', 'EVERYTHING '],
      ['mixed case', 'Everything'],
    ])('rejects a near-miss confirmation: %s', async (_label, confirmation) => {
      await expect(
        service.requestDeletion(USER_ID, { scope: 'everything', confirmation }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    // ⚠ EXHAUSTIVE OVER EVERY ORDERED PAIR OF DISTINCT SCOPES. A word typed
    // into one dialog must never authorise a different scope's deletion.
    const crossScopePairs: Array<[UserDataScope, UserDataScope]> = USER_DATA_SCOPES.flatMap((requested) =>
      USER_DATA_SCOPES.filter((typed) => typed !== requested).map(
        (typed): [UserDataScope, UserDataScope] => [requested, typed],
      ),
    );

    it.each(crossScopePairs)(
      'refuses a "%s" request confirmed with the word for "%s"',
      async (requestedScope, wordFor) => {
        await expect(
          service.requestDeletion(USER_ID, {
            scope: requestedScope,
            confirmation: confirmationFor(wordFor),
          }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(jobs.enqueue).not.toHaveBeenCalled();
      },
    );

    it('names the required word in the 400, for the caller who genuinely means it', async () => {
      await expect(
        service.requestDeletion(USER_ID, { scope: 'files', confirmation: 'wrong' }),
      ).rejects.toThrow(/FILES/);
    });

    it('accepts the exact uppercase word and proceeds to enqueue', async () => {
      jobs.enqueue.mockResolvedValue({
        id: 'job-1',
        status: 'pending',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        payload: { userId: USER_ID, scope: 'files', requestId: 'placeholder' },
      });

      // The service generates its own requestId; capture whatever it sent so
      // the mock can echo it back as "this insert won".
      jobs.enqueue.mockImplementation((input: { payload: { requestId: string } }) =>
        Promise.resolve({
          id: 'job-1',
          status: 'pending',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          payload: input.payload,
        }),
      );

      await expect(
        service.requestDeletion(USER_ID, { scope: 'files', confirmation: 'FILES' }),
      ).resolves.toMatchObject({ scope: 'files', status: 'pending' });
    });
  });

  // ---------------------------------------------------------------------------
  // requestDeletion() — the 409 collision mechanism
  // ---------------------------------------------------------------------------

  describe('requestDeletion — collision handling', () => {
    it('409s on the courtesy pre-check when a deletion is already pending or running', async () => {
      prisma.job.findFirst.mockResolvedValue({
        id: 'job-existing',
        status: 'pending',
        createdAt: new Date(),
        payload: { userId: USER_ID, scope: 'notes' },
      });

      await expect(
        service.requestDeletion(USER_ID, { scope: 'everything', confirmation: 'EVERYTHING' }),
      ).rejects.toBeInstanceOf(ConflictException);

      // The courtesy check is a fast refusal BEFORE ever calling enqueue.
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    // ⚠ THE MECHANISM UNDER TEST. The pre-check finds nothing (no race yet),
    // but `enqueue` deduplicates onto a job somebody else's request queued a
    // moment earlier and returns THAT job — whose payload carries a DIFFERENT
    // requestId than the one this call generated. That mismatch, not a
    // `findFirst`, is what must produce the 409.
    it('409s when enqueue deduplicates onto another request\'s job — detected by requestId mismatch', async () => {
      prisma.job.findFirst.mockResolvedValue(null);

      jobs.enqueue.mockResolvedValue({
        id: 'job-other',
        status: 'running',
        createdAt: new Date(),
        payload: { userId: USER_ID, scope: 'everything', requestId: 'someone-elses-request-id' },
      });

      await expect(
        service.requestDeletion(USER_ID, { scope: 'transcripts', confirmation: 'TRANSCRIPTS' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('names the scope actually running in the requestId-mismatch 409', async () => {
      prisma.job.findFirst.mockResolvedValue(null);

      jobs.enqueue.mockResolvedValue({
        id: 'job-other',
        status: 'running',
        createdAt: new Date(),
        payload: { userId: USER_ID, scope: 'everything', requestId: 'someone-elses-request-id' },
      });

      await expect(
        service.requestDeletion(USER_ID, { scope: 'transcripts', confirmation: 'TRANSCRIPTS' }),
      ).rejects.toThrow(/everything/);
    });

    it('does NOT 409 when enqueue returns the SAME requestId this call generated', async () => {
      prisma.job.findFirst.mockResolvedValue(null);

      jobs.enqueue.mockImplementation((input: { payload: { requestId: string } }) =>
        Promise.resolve({
          id: 'job-mine',
          status: 'pending',
          createdAt: new Date(),
          payload: input.payload,
        }),
      );

      await expect(
        service.requestDeletion(USER_ID, { scope: 'notes', confirmation: 'NOTES' }),
      ).resolves.toMatchObject({ scope: 'notes' });
    });
  });

  // ---------------------------------------------------------------------------
  // requestDeletion() — the happy path
  // ---------------------------------------------------------------------------

  describe('requestDeletion — happy path', () => {
    beforeEach(() => {
      jobs.enqueue.mockImplementation((input: { payload: { requestId: string } }) =>
        Promise.resolve({
          id: 'job-1',
          status: 'pending',
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          payload: input.payload,
        }),
      );
    });

    it('enqueues user.data.purge, subject "user", subjectId the caller, and the scope in the payload', async () => {
      await service.requestDeletion(USER_ID, { scope: 'content', confirmation: 'CONTENT' });

      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: USER_DATA_PURGE_JOB_TYPE,
          subjectType: USER_DATA_SUBJECT_TYPE,
          subjectId: USER_ID,
          payload: expect.objectContaining({ userId: USER_ID, scope: 'content' }),
        }),
      );
    });

    it('writes an audit event for the deletion request', async () => {
      await service.requestDeletion(USER_ID, { scope: 'content', confirmation: 'CONTENT' });

      expect(prisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorUserId: USER_ID,
            action: 'user_data:delete_requested',
            targetType: 'user',
            targetId: USER_ID,
          }),
        }),
      );
    });

    it('returns the job id, the requested scope, its status, and when it was queued', async () => {
      const result = await service.requestDeletion(USER_ID, {
        scope: 'content',
        confirmation: 'CONTENT',
      });

      expect(result).toEqual({
        id: 'job-1',
        scope: 'content',
        status: 'pending',
        requestedAt: '2026-02-01T00:00:00.000Z',
      });
    });
  });
});
