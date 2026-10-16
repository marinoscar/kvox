import { NotFoundException } from '@nestjs/common';

import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationStoreService } from './notification-store.service';
import type { NotificationListQueryDto } from './dto/notification.dto';

// =============================================================================
// NotificationStoreService — tests (issue #127, epic #109)
// =============================================================================
//
// `createMockPrismaService()` from `test/mocks/prisma.mock` gives a fresh
// `mockDeep<PrismaClient>()` per test — the model under test is
// `prisma.notification` (singular), not `prisma.notifications`.
//
// THE CENTREPIECE is the 404-indistinguishability suite for `markRead`: an id
// that does not exist at all, and an id that belongs to a different user,
// must produce the byte-identical `NotFoundException` — same message, same
// shape — because that identity is the whole point of the design (see the
// source file's header).
// =============================================================================

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';

function defaultQuery(
  overrides: Partial<NotificationListQueryDto> = {},
): NotificationListQueryDto {
  return {
    page: 1,
    pageSize: 20,
    unreadOnly: false,
    ...overrides,
  } as NotificationListQueryDto;
}

function row(overrides: Partial<{
  id: string;
  eventKey: string;
  title: string;
  body: string;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}> = {}) {
  return {
    id: 'notif-1',
    eventKey: 'security.role_changed',
    title: 'Your roles changed',
    body: 'An administrator changed your roles.',
    link: '/settings',
    readAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('NotificationStoreService', () => {
  let service: NotificationStoreService;
  let mockPrisma: MockPrismaService;

  beforeEach(() => {
    mockPrisma = createMockPrismaService();
    service = new NotificationStoreService(mockPrisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // list()
  // ==========================================================================

  describe('list()', () => {
    it('always includes userId in the where clause passed to both findMany and count', async () => {
      mockPrisma.$transaction.mockImplementation((ops: any) => Promise.all(ops) as never);
      mockPrisma.notification.findMany.mockResolvedValue([] as never);
      mockPrisma.notification.count.mockResolvedValue(0 as never);

      await service.list(USER_ID, defaultQuery());

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: USER_ID }) }),
      );
      expect(mockPrisma.notification.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: USER_ID }) }),
      );
    });

    it('adds readAt: null to where when unreadOnly is true', async () => {
      mockPrisma.$transaction.mockImplementation((ops: any) => Promise.all(ops) as never);
      mockPrisma.notification.findMany.mockResolvedValue([] as never);
      mockPrisma.notification.count.mockResolvedValue(0 as never);

      await service.list(USER_ID, defaultQuery({ unreadOnly: true }));

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: USER_ID, readAt: null }),
        }),
      );
      expect(mockPrisma.notification.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: USER_ID, readAt: null }),
        }),
      );
    });

    it('does not add readAt to where when unreadOnly is absent/false', async () => {
      mockPrisma.$transaction.mockImplementation((ops: any) => Promise.all(ops) as never);
      mockPrisma.notification.findMany.mockResolvedValue([] as never);
      mockPrisma.notification.count.mockResolvedValue(0 as never);

      await service.list(USER_ID, defaultQuery({ unreadOnly: false }));

      const [[findManyArgs]] = mockPrisma.notification.findMany.mock.calls as unknown as [
        [{ where: Record<string, unknown> }],
      ];
      expect(findManyArgs.where).not.toHaveProperty('readAt');
    });

    it('computes skip/take/totalPages from page and pageSize', async () => {
      mockPrisma.$transaction.mockImplementation((ops: any) => Promise.all(ops) as never);
      mockPrisma.notification.findMany.mockResolvedValue([] as never);
      mockPrisma.notification.count.mockResolvedValue(45 as never);

      const result = await service.list(USER_ID, defaultQuery({ page: 3, pageSize: 10 }));

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
      expect(result).toMatchObject({
        total: 45,
        page: 3,
        pageSize: 10,
        totalPages: 5, // Math.ceil(45 / 10)
      });
    });

    it('serialises readAt and createdAt to ISO strings in the response', async () => {
      const createdAt = new Date('2026-02-15T10:30:00.000Z');
      const readAt = new Date('2026-02-16T09:00:00.000Z');

      mockPrisma.$transaction.mockImplementation((ops: any) => Promise.all(ops) as never);
      mockPrisma.notification.findMany.mockResolvedValue([
        row({ createdAt, readAt }),
      ] as never);
      mockPrisma.notification.count.mockResolvedValue(1 as never);

      const result = await service.list(USER_ID, defaultQuery());

      expect(result.items[0].createdAt).toBe('2026-02-15T10:30:00.000Z');
      expect(result.items[0].readAt).toBe('2026-02-16T09:00:00.000Z');
    });

    it('serialises a null readAt to null (unread)', async () => {
      mockPrisma.$transaction.mockImplementation((ops: any) => Promise.all(ops) as never);
      mockPrisma.notification.findMany.mockResolvedValue([row({ readAt: null })] as never);
      mockPrisma.notification.count.mockResolvedValue(1 as never);

      const result = await service.list(USER_ID, defaultQuery());

      expect(result.items[0].readAt).toBeNull();
    });

    it('orders by createdAt desc', async () => {
      mockPrisma.$transaction.mockImplementation((ops: any) => Promise.all(ops) as never);
      mockPrisma.notification.findMany.mockResolvedValue([] as never);
      mockPrisma.notification.count.mockResolvedValue(0 as never);

      await service.list(USER_ID, defaultQuery());

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });

    it('uses $transaction to run findMany and count together', async () => {
      mockPrisma.$transaction.mockImplementation((ops: any) => Promise.all(ops) as never);
      mockPrisma.notification.findMany.mockResolvedValue([] as never);
      mockPrisma.notification.count.mockResolvedValue(0 as never);

      await service.list(USER_ID, defaultQuery());

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // unreadCount()
  // ==========================================================================

  describe('unreadCount()', () => {
    it('scopes the count by userId and readAt: null', async () => {
      mockPrisma.notification.count.mockResolvedValue(7 as never);

      const result = await service.unreadCount(USER_ID);

      expect(result).toBe(7);
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: { userId: USER_ID, readAt: null },
      });
    });
  });

  // ==========================================================================
  // markRead()
  // ==========================================================================

  describe('markRead()', () => {
    it('happy path: updateMany count 1 returns the fresh unreadCount', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 } as never);
      mockPrisma.notification.count.mockResolvedValue(2 as never);

      const result = await service.markRead(USER_ID, 'notif-1');

      expect(result).toBe(2);
      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'notif-1', userId: USER_ID, readAt: null },
        data: { readAt: expect.any(Date) },
      });
      // Existence probe was not needed on the happy path.
      expect(mockPrisma.notification.count).toHaveBeenCalledTimes(1);
    });

    it('idempotent re-mark: updateMany count 0 but existence count 1 still succeeds, no exception', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 } as never);
      mockPrisma.notification.count
        .mockResolvedValueOnce(1 as never) // existence probe: it IS this user's row
        .mockResolvedValueOnce(3 as never); // unreadCount

      const result = await service.markRead(USER_ID, 'notif-1');

      expect(result).toBe(3);
      expect(mockPrisma.notification.count).toHaveBeenNthCalledWith(1, {
        where: { id: 'notif-1', userId: USER_ID },
      });
    });

    describe('THE 404-INDISTINGUISHABILITY CENTREPIECE: a nonexistent id and another user’s id throw the identical NotFoundException', () => {
      const NOT_FOUND_MESSAGE = 'Notification not found';

      it.each([
        ['an id that truly does not exist for anybody', 'ghost-id'],
        ['an id that exists but belongs to a different user', 'other-users-notif'],
      ])('%s -> NotFoundException("Notification not found")', async (_label, id) => {
        // Both scenarios produce the SAME mock shape from this user's point of
        // view: updateMany matches nothing (wrong id, or wrong userId), and the
        // existence probe — itself scoped to userId — also matches nothing.
        mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 } as never);
        mockPrisma.notification.count.mockResolvedValue(0 as never);

        await expect(service.markRead(USER_ID, id)).rejects.toThrow(NotFoundException);
        await expect(service.markRead(USER_ID, id)).rejects.toThrow(NOT_FOUND_MESSAGE);
      });

      it('produces byte-identical error shape for both scenarios, proving the caller cannot distinguish them', async () => {
        async function attempt(id: string) {
          mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 } as never);
          mockPrisma.notification.count.mockResolvedValue(0 as never);
          try {
            await service.markRead(USER_ID, id);
            throw new Error('expected markRead to throw');
          } catch (err) {
            return err;
          }
        }

        const notFoundError = await attempt('ghost-id');
        const otherUsersError = await attempt('other-users-notif');

        expect(notFoundError).toBeInstanceOf(NotFoundException);
        expect(otherUsersError).toBeInstanceOf(NotFoundException);
        expect((notFoundError as NotFoundException).getStatus()).toBe(
          (otherUsersError as NotFoundException).getStatus(),
        );
        expect((notFoundError as NotFoundException).message).toBe(
          (otherUsersError as NotFoundException).message,
        );
        expect((notFoundError as NotFoundException).getResponse()).toEqual(
          (otherUsersError as NotFoundException).getResponse(),
        );
      });

      it('the existence probe is itself scoped to userId, for both scenarios', async () => {
        mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 } as never);
        mockPrisma.notification.count.mockResolvedValue(0 as never);

        await expect(service.markRead(USER_ID, 'other-users-notif')).rejects.toThrow(
          NotFoundException,
        );

        expect(mockPrisma.notification.count).toHaveBeenCalledWith({
          where: { id: 'other-users-notif', userId: USER_ID },
        });
      });
    });
  });

  // ==========================================================================
  // markAllRead()
  // ==========================================================================

  describe('markAllRead()', () => {
    it('scopes updateMany by userId and readAt: null', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 3 } as never);
      mockPrisma.notification.count.mockResolvedValue(0 as never);

      await service.markAllRead(USER_ID);

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, readAt: null },
        data: { readAt: expect.any(Date) },
      });
    });

    it('returns a fresh unreadCount taken AFTER the update — not a hardcoded 0', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 5 } as never);
      // Simulate a race: a new notification landed between the UPDATE and the
      // COUNT, so the "fresh" count is nonzero even though everything that
      // existed at update-time was just marked read.
      mockPrisma.notification.count.mockResolvedValue(1 as never);

      const result = await service.markAllRead(USER_ID);

      expect(result).toBe(1);
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: { userId: USER_ID, readAt: null },
      });
    });

    it('calls updateMany before count (the count reflects post-update state)', async () => {
      const callOrder: string[] = [];
      mockPrisma.notification.updateMany.mockImplementation((async () => {
        callOrder.push('updateMany');
        return { count: 2 };
      }) as never);
      mockPrisma.notification.count.mockImplementation((async () => {
        callOrder.push('count');
        return 0;
      }) as never);

      await service.markAllRead(USER_ID);

      expect(callOrder).toEqual(['updateMany', 'count']);
    });
  });
});
