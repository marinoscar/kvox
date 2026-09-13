// =============================================================================
// Unit tests for the broadcasts service (issue #324, epic #319)
// =============================================================================
//
// What this file proves is what the SERVICE decides: which event key a
// composition becomes, what is enqueued and when, which statuses a cancel may
// claim, and what does — and does not — end up in the audit log. What it
// deliberately does not prove is anything the router, the guards or the global
// validation pipe answer; those need a real request pipeline and live in
// `test/broadcasts/broadcasts.integration.spec.ts`.
//
// Mocking style follows `handlers/broadcast-start.handler.spec.ts`: hand-built
// jest mocks cast through `unknown`, no Nest testing module. The service takes
// five collaborators and touches a handful of query methods; standing up DI to
// reach them would test Nest.
// =============================================================================

import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationBroadcast } from '@prisma/client';

import type { JobsService } from '../../jobs/jobs.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import type { NotificationsService } from '../notifications.service';
import {
  BROADCAST_CRITICAL_EVENT_KEY,
  BROADCAST_EVENT_KEY,
  BroadcastsService,
} from './broadcasts.service';
import { BROADCAST_SUBJECT_TYPE } from './broadcast-audience';
import { BROADCAST_START_TYPE } from './handlers/broadcast-start.handler';
import type { CreateBroadcastInput } from './dto/create-broadcast.dto';

const BROADCAST_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

/**
 * A composition as the DTO would hand it over: already parsed, already
 * defaulted. Everything about VALIDATING one is the DTO's job and is asserted
 * through the real pipe in the integration suite.
 */
const composition: CreateBroadcastInput = {
  title: 'Planned maintenance on Sunday',
  body: 'The application will be unavailable between 02:00 and 04:00 UTC.',
  channels: ['email', 'browser'],
  critical: false,
};

function broadcastRow(overrides: Partial<NotificationBroadcast> = {}): NotificationBroadcast {
  return {
    id: BROADCAST_ID,
    title: composition.title,
    body: composition.body,
    link: null,
    ctaLabel: null,
    eventKey: BROADCAST_EVENT_KEY,
    channels: ['email', 'browser'],
    status: 'scheduled',
    scheduledFor: null,
    startedAt: null,
    finishedAt: null,
    canceledAt: null,
    audienceCutoff: null,
    cursorUserId: null,
    recipientsTargeted: null,
    recipientsDispatched: 0,
    lastError: null,
    createdById: ADMIN_ID,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as NotificationBroadcast;
}

function makeService(
  options: {
    row?: NotificationBroadcast | null;
    canceledCount?: number;
    browserEnabled?: boolean;
  } = {}
) {
  const create = jest.fn().mockImplementation(async ({ data }: any) => broadcastRow(data));
  const findUnique = jest
    .fn()
    .mockResolvedValue(options.row === undefined ? broadcastRow() : options.row);
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);
  const updateMany = jest.fn().mockResolvedValue({ count: options.canceledCount ?? 1 });
  const deleteFn = jest.fn().mockResolvedValue({});
  const userCount = jest.fn().mockResolvedValue(1284);
  const auditCreate = jest.fn().mockResolvedValue({});
  const groupBy = jest.fn().mockResolvedValue([]);

  const prisma = {
    notificationBroadcast: { create, findUnique, findMany, count, updateMany, delete: deleteFn },
    user: { count: userCount },
    auditEvent: { create: auditCreate },
    notificationDelivery: { groupBy },
  } as unknown as PrismaService;

  const enqueue = jest.fn().mockResolvedValue({ id: 'job-1' });
  const jobs = { enqueue } as unknown as JobsService;

  const notifyNow = jest.fn().mockResolvedValue(undefined);
  const notifications = { notifyNow } as unknown as NotificationsService;

  const getNotificationsPolicy = jest.fn().mockResolvedValue({
    browserEnabled: options.browserEnabled ?? true,
    disabledEvents: [],
  });
  const systemSettings = { getNotificationsPolicy } as unknown as SystemSettingsService;

  const config = { get: jest.fn().mockReturnValue('http://localhost:3535') } as unknown as ConfigService;

  return {
    service: new BroadcastsService(prisma, jobs, notifications, systemSettings, config),
    create,
    findUnique,
    findMany,
    count,
    updateMany,
    delete: deleteFn,
    userCount,
    auditCreate,
    groupBy,
    enqueue,
    notifyNow,
    getNotificationsPolicy,
  };
}

/** The `meta` of the single audit row a mutation wrote. */
function auditMeta(auditCreate: jest.Mock): Record<string, unknown> {
  return auditCreate.mock.calls[0][0].data.meta;
}

describe('BroadcastsService', () => {
  describe('create', () => {
    it('derives the normal event key from critical: false', async () => {
      const { service, create } = makeService();

      await service.create(composition, ADMIN_ID);

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventKey: BROADCAST_EVENT_KEY, status: 'scheduled' }),
        })
      );
    });

    it('derives the critical event key from critical: true', async () => {
      const { service, create } = makeService();

      // The whole point of the flag: the key is NEVER accepted from a client,
      // because a client that could name it could name the one event every
      // recipient is forbidden to mute.
      await service.create(
        { ...composition, critical: true, channels: ['email', 'browser'] },
        ADMIN_ID
      );

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventKey: BROADCAST_CRITICAL_EVENT_KEY }),
        })
      );
    });

    it('enqueues the start job with no scheduledFor for an immediate send', async () => {
      const { service, enqueue } = makeService();

      await service.create(composition, ADMIN_ID);

      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: BROADCAST_START_TYPE,
          reason: 'backfill',
          subjectType: BROADCAST_SUBJECT_TYPE,
          subjectId: BROADCAST_ID,
          // `undefined`, not `null`: the queue reads undefined as "let the
          // column default apply", which is what makes the job claimable now.
          scheduledFor: undefined,
        })
      );
    });

    it('passes a future scheduledFor through to the job unchanged', async () => {
      const { service, enqueue, create } = makeService();
      const when = new Date(Date.now() + 60 * 60 * 1000);

      await service.create({ ...composition, scheduledFor: when }, ADMIN_ID);

      // Stored on the row AND carried on the job. The row is what the admin
      // list shows; the job's `scheduledFor` is the actual scheduler.
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ scheduledFor: when }) })
      );
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ scheduledFor: when }));
    });

    it('writes the row before enqueuing the job', async () => {
      const { service, create, enqueue } = makeService();

      await service.create(composition, ADMIN_ID);

      // Ordering, not timing: a job claimed before its broadcast row exists is
      // an announcement that is silently never sent, with a `succeeded` job
      // row claiming otherwise.
      expect(create.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0]);
    });

    it('does not warn when the browser kill switch is on', async () => {
      const { service } = makeService({ browserEnabled: true });

      const result = await service.create(composition, ADMIN_ID);

      expect(result.warnings).toEqual([]);
    });

    it('warns, and still creates, when browser is chosen with the kill switch off', async () => {
      const { service, create } = makeService({ browserEnabled: false });

      const result = await service.create(composition, ADMIN_ID);

      // A WARNING, NOT A 400: an admin may legitimately schedule something for
      // after the switch is flipped back, and the switch can be flipped by
      // somebody else between compose and send.
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('disabled deployment-wide');
      expect(create).toHaveBeenCalled();
    });

    it('does not warn about the kill switch when browser was not selected', async () => {
      const { service, getNotificationsPolicy } = makeService({ browserEnabled: false });

      const result = await service.create({ ...composition, channels: ['email'] }, ADMIN_ID);

      expect(result.warnings).toEqual([]);
      // Not even read: nothing about an email-only send depends on it.
      expect(getNotificationsPolicy).not.toHaveBeenCalled();
    });

    it('still creates when the policy cannot be read', async () => {
      const { service, getNotificationsPolicy } = makeService();
      getNotificationsPolicy.mockRejectedValue(new Error('settings unavailable'));

      const result = await service.create(composition, ADMIN_ID);

      // The row is already committed by then; a warning that cannot be
      // computed must not fail a request that already succeeded.
      expect(result.broadcast.id).toBe(BROADCAST_ID);
      expect(result.warnings).toEqual([]);
    });

    it('audits the creation with identifiers and shape, never the body', async () => {
      const { service, auditCreate } = makeService();

      await service.create(composition, ADMIN_ID);

      expect(auditCreate).toHaveBeenCalledTimes(1);
      expect(auditCreate.mock.calls[0][0].data).toMatchObject({
        actorUserId: ADMIN_ID,
        action: 'notification_broadcast.created',
        targetType: 'notification_broadcast',
        targetId: BROADCAST_ID,
      });

      const meta = auditMeta(auditCreate);
      expect(meta).toEqual({
        eventKey: BROADCAST_EVENT_KEY,
        channels: ['email', 'browser'],
        scheduledFor: null,
        recipientsTargeted: null,
      });
      // The composed text has exactly one home, and `audit_events.meta` is not
      // it. Asserted on the serialised row so a nested copy cannot hide.
      expect(JSON.stringify(meta)).not.toContain(composition.body);
      expect(JSON.stringify(meta)).not.toContain(composition.title);
    });
  });

  describe('cancel', () => {
    it('claims a scheduled broadcast with the status in the WHERE', async () => {
      const { service, updateMany, findUnique } = makeService();
      findUnique.mockResolvedValue(broadcastRow({ status: 'canceled' }));

      const result = await service.cancel(BROADCAST_ID, ADMIN_ID);

      // The status is in the `WHERE`, not in an `if` above the write — that is
      // what makes this race the fan-out's own claim inside the database,
      // where exactly one of them can win.
      expect(updateMany).toHaveBeenCalledWith({
        where: { id: BROADCAST_ID, status: { in: ['scheduled', 'sending'] } },
        data: { status: 'canceled', canceledAt: expect.any(Date) },
      });
      expect(result.status).toBe('canceled');
    });

    it('cancels a broadcast that is already sending', async () => {
      const { service, updateMany, findUnique } = makeService();
      findUnique.mockResolvedValue(broadcastRow({ status: 'canceled', recipientsDispatched: 200 }));

      const result = await service.cancel(BROADCAST_ID, ADMIN_ID);

      expect(updateMany.mock.calls[0][0].where.status).toEqual({
        in: ['scheduled', 'sending'],
      });
      expect(result.status).toBe('canceled');
    });

    it('409s a broadcast that has already been sent', async () => {
      const { service, findUnique } = makeService({ canceledCount: 0 });
      findUnique.mockResolvedValue(broadcastRow({ status: 'sent' }));

      await expect(service.cancel(BROADCAST_ID, ADMIN_ID)).rejects.toBeInstanceOf(
        ConflictException
      );
    });

    it('404s a broadcast that does not exist, rather than 409', async () => {
      const { service } = makeService({ canceledCount: 0, row: null });

      // `count === 0` is ambiguous on its own; answering 409 for a missing row
      // would tell an operator it exists and is merely in the wrong state.
      await expect(service.cancel(BROADCAST_ID, ADMIN_ID)).rejects.toBeInstanceOf(
        NotFoundException
      );
    });

    it('does not delete any queued job row', async () => {
      const { service, findUnique, enqueue } = makeService();
      findUnique.mockResolvedValue(broadcastRow({ status: 'canceled' }));

      await service.cancel(BROADCAST_ID, ADMIN_ID);

      // Deleting the pending start or chunk job would race a worker claiming
      // it. The handlers' status guards are the durable gate, and the `jobs`
      // rows are audit history.
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('audits the cancellation without the body', async () => {
      const { service, findUnique, auditCreate } = makeService();
      findUnique.mockResolvedValue(broadcastRow({ status: 'canceled' }));

      await service.cancel(BROADCAST_ID, ADMIN_ID);

      expect(auditCreate).toHaveBeenCalledTimes(1);
      expect(auditCreate.mock.calls[0][0].data.action).toBe('notification_broadcast.canceled');
      expect(JSON.stringify(auditMeta(auditCreate))).not.toContain(composition.body);
    });
  });

  describe('remove', () => {
    it('409s while the broadcast is sending', async () => {
      const { service, delete: deleteFn } = makeService({
        row: broadcastRow({ status: 'sending' }),
      });

      await expect(service.remove(BROADCAST_ID, ADMIN_ID)).rejects.toBeInstanceOf(
        ConflictException
      );
      // Deleting mid-fan-out would not stop the chunk chain; it would leave it
      // running against a record that no longer exists.
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('404s a broadcast that does not exist', async () => {
      const { service } = makeService({ row: null });

      await expect(service.remove(BROADCAST_ID, ADMIN_ID)).rejects.toBeInstanceOf(
        NotFoundException
      );
    });

    it('deletes a cancelled broadcast and audits it without the body', async () => {
      const { service, delete: deleteFn, auditCreate } = makeService({
        row: broadcastRow({ status: 'canceled' }),
      });

      await service.remove(BROADCAST_ID, ADMIN_ID);

      expect(deleteFn).toHaveBeenCalledWith({ where: { id: BROADCAST_ID } });
      expect(auditCreate).toHaveBeenCalledTimes(1);
      expect(auditCreate.mock.calls[0][0].data.action).toBe('notification_broadcast.deleted');
      expect(JSON.stringify(auditMeta(auditCreate))).not.toContain(composition.body);
    });
  });

  describe('sendTest', () => {
    it('dispatches to the caller only, writing no row and queuing no job', async () => {
      const { service, notifyNow, create, enqueue } = makeService();

      const result = await service.sendTest(composition, ADMIN_ID);

      expect(notifyNow).toHaveBeenCalledTimes(1);
      const [eventKey, userId, payload, options] = notifyNow.mock.calls[0];
      expect(eventKey).toBe(BROADCAST_EVENT_KEY);
      expect(userId).toBe(ADMIN_ID);
      expect(payload).toMatchObject({
        title: composition.title,
        body: composition.body,
        critical: false,
      });
      expect(options).toEqual({ channels: ['email', 'browser'] });

      expect(create).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(result.sentToUserId).toBe(ADMIN_ID);
    });

    it('derives the critical key and marks the payload for a critical test', async () => {
      const { service, notifyNow } = makeService();

      await service.sendTest({ ...composition, critical: true }, ADMIN_ID);

      expect(notifyNow.mock.calls[0][0]).toBe(BROADCAST_CRITICAL_EVENT_KEY);
      expect(notifyNow.mock.calls[0][2]).toMatchObject({ critical: true });
    });

    it('builds an absolute CTA URL from APP_URL and the root-relative link', async () => {
      const { service, notifyNow } = makeService();

      await service.sendTest(
        { ...composition, link: '/status', ctaLabel: 'View status' },
        ADMIN_ID
      );

      expect(notifyNow.mock.calls[0][2]).toMatchObject({
        link: '/status',
        ctaLabel: 'View status',
        ctaUrl: 'http://localhost:3535/status',
      });
    });

    it('audits the test send without the body', async () => {
      const { service, auditCreate } = makeService();

      await service.sendTest(composition, ADMIN_ID);

      expect(auditCreate).toHaveBeenCalledTimes(1);
      expect(auditCreate.mock.calls[0][0].data.action).toBe('notification_broadcast.test_sent');
      expect(JSON.stringify(auditMeta(auditCreate))).not.toContain(composition.body);
    });
  });

  describe('audience', () => {
    it('counts with the shared audience predicate', async () => {
      const { service, userCount } = makeService();

      await expect(service.audience()).resolves.toEqual({ activeUsers: 1284 });

      // `isActive: true` plus the cutoff — the same predicate the fan-out
      // pages with, which is why the composer's number and the send's number
      // cannot disagree.
      const where = userCount.mock.calls[0][0].where;
      expect(where.isActive).toBe(true);
      expect(where.createdAt.lte).toBeInstanceOf(Date);
    });
  });

  describe('get', () => {
    it('returns an empty delivery breakdown for a broadcast that has not started', async () => {
      const { service, groupBy } = makeService();

      const detail = await service.get(BROADCAST_ID);

      expect(detail.approximateDeliveryAttempts).toEqual([]);
      // With no `startedAt` there is no window, and an unbounded query over
      // `notification_deliveries` is the one thing this must never issue.
      expect(groupBy).not.toHaveBeenCalled();
    });

    it('windows the breakdown by event key and the send interval', async () => {
      const startedAt = new Date('2026-02-01T10:00:00.000Z');
      const finishedAt = new Date('2026-02-01T10:05:00.000Z');
      const { service, groupBy } = makeService({
        row: broadcastRow({ status: 'sent', startedAt, finishedAt }),
      });
      groupBy.mockResolvedValue([
        { channel: 'email', status: 'sent', _count: { _all: 1200 } },
        { channel: 'email', status: 'failed', _count: { _all: 3 } },
      ]);

      const detail = await service.get(BROADCAST_ID);

      expect(groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['channel', 'status'],
          where: {
            eventKey: BROADCAST_EVENT_KEY,
            createdAt: { gte: startedAt, lte: finishedAt },
          },
        })
      );
      expect(detail.approximateDeliveryAttempts).toEqual([
        { channel: 'email', status: 'sent', count: 1200 },
        { channel: 'email', status: 'failed', count: 3 },
      ]);
    });
  });

  describe('list', () => {
    it('pages newest first and filters by status when asked', async () => {
      const { service, findMany, count } = makeService();
      count.mockResolvedValue(42);

      const result = await service.list({ page: 2, pageSize: 20, status: 'sent' });

      expect(findMany).toHaveBeenCalledWith({
        where: { status: 'sent' },
        orderBy: { createdAt: 'desc' },
        skip: 20,
        take: 20,
      });
      expect(result).toMatchObject({ total: 42, page: 2, pageSize: 20, totalPages: 3 });
    });
  });
});
