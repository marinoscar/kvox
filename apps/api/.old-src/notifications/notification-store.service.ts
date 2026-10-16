import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type {
  NotificationListQueryDto,
  NotificationListResponse,
  NotificationResponse,
} from './dto/notification.dto';

// =============================================================================
// NotificationStoreService — the notification centre's reads and writes
// (issue #127, epic #109)
// =============================================================================
//
// Everything that touches the `notifications` table on behalf of a signed-in
// user: the recent list, the unread badge, and the two ways of marking things
// read.
//
// -----------------------------------------------------------------------------
// EVERY METHOD TAKES `userId` FIRST, AND EVERY QUERY FILTERS ON IT
// -----------------------------------------------------------------------------
//
// There is no `findById(id)` here, and there will not be one. The tempting
// shape —
//
//     const n = await this.prisma.notification.findUnique({ where: { id } });
//     if (n.userId !== userId) throw new ForbiddenException();
//
// — is an IDOR waiting for the day somebody adds a caller that forgets the
// second line, and it leaks existence through the difference between 403 and
// 404 even when they remember. So the ownership predicate is part of the
// `where` clause of every statement in this file rather than a check performed
// after the row is in hand: a query that omits it does not return the wrong
// user's row, it fails to compile against these signatures.
//
// The mark-read paths use `updateMany` for the same reason. `update({ where:
// { id } })` can only be filtered by unique columns, which would force the
// read-then-check shape above; `updateMany({ where: { id, userId } })` puts
// the ownership test inside the single statement the database executes, so
// there is no window between checking and writing and no code path where the
// check can be skipped. A zero-row result is reported as 404 — the same answer
// the caller gets for an id that does not exist at all, which is deliberate:
// distinguishing "not yours" from "not there" is a membership oracle over
// every other user's notification ids.
// =============================================================================

/**
 * Columns returned to a client, and the one place that list is decided.
 *
 * An explicit `select` rather than returning the model: a column added later
 * for internal purposes must not become public API by default, and there is no
 * sensitive column here today only because nobody has added one yet.
 */
const NOTIFICATION_FIELDS = {
  id: true,
  eventKey: true,
  title: true,
  body: true,
  link: true,
  readAt: true,
  createdAt: true,
} as const;

@Injectable()
export class NotificationStoreService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of a user's notifications, newest first.
   *
   * Ordered `createdAt desc` to match `@@index([userId, createdAt(sort: Desc)])`
   * — the index exists for this query and this ordering, so a change to either
   * should change the other.
   *
   * OFFSET PAGINATION, matching `GET /api/users` and `GET /api/allowlist`.
   * Cursor pagination would be more correct under concurrent inserts (a
   * notification arriving mid-scroll shifts every later page by one), but the
   * bell shows the first page and occasionally a second, the drift is one row
   * on a list the user is actively watching update, and inventing a third
   * pagination shape in an API that already has two would be a worse defect
   * than the one it fixes.
   */
  async list(
    userId: string,
    query: NotificationListQueryDto,
  ): Promise<NotificationListResponse> {
    const { page, pageSize, unreadOnly } = query;

    // `userId` is in the where clause, not applied afterwards. See the header.
    const where = {
      userId,
      ...(unreadOnly ? { readAt: null } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        select: NOTIFICATION_FIELDS,
        orderBy: { createdAt: 'desc' as const },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      items: items.map(toResponse),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * How many unread notifications this user has.
   *
   * THE HOTTEST QUERY IN THIS FILE: every bell render and every SSE
   * (re)connect calls it, which is the whole reason it is a separate endpoint
   * rather than something a client derives from a page of `list`. Deriving it
   * would be wrong as well as slow — a badge computed from the first page caps
   * at `pageSize` and quietly under-reports.
   *
   * `@@index([userId, readAt])` serves it directly.
   */
  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, readAt: null },
    });
  }

  /**
   * Mark one notification read, and report the resulting badge.
   *
   * `updateMany` with BOTH `id` and `userId` in the predicate — see the header
   * for why this is not `update({ where: { id } })` plus an ownership check.
   *
   * IDEMPOTENT: `readAt: null` is part of the predicate, so marking an
   * already-read notification updates nothing and keeps the ORIGINAL timestamp
   * rather than moving it to now. "When did they first see this?" is the
   * question `readAt` exists to answer, and a double-click from an impatient
   * user must not rewrite the answer.
   *
   * That does mean a second call matches zero rows, so a zero-row result
   * cannot by itself mean "not found" — hence the existence probe below, which
   * is also scoped to this user.
   *
   * @throws NotFoundException when the id belongs to nobody, or to somebody
   *         else. The two are deliberately indistinguishable.
   */
  async markRead(userId: string, id: string): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });

    if (count === 0) {
      // Nothing was updated: either the notification is already read (fine,
      // idempotent) or it is not this user's to touch. Distinguished by a
      // second query that is ITSELF scoped to the user, so the answer never
      // depends on a row this caller may not see.
      const exists = await this.prisma.notification.count({
        where: { id, userId },
      });

      if (exists === 0) {
        throw new NotFoundException('Notification not found');
      }
    }

    // The badge is the only server-owned state the caller cannot compute for
    // itself — it already holds the row it just marked — so returning the new
    // count saves the immediate follow-up request that a bare 204 would force
    // on every single click.
    return this.unreadCount(userId);
  }

  /**
   * Mark every one of this user's unread notifications read.
   *
   * `readAt: null` in the predicate keeps this from rewriting timestamps on
   * rows that were already read, for the same reason as {@link markRead}.
   *
   * Returns `0` unless a new notification arrived between the UPDATE and the
   * COUNT — which is a real race and is answered correctly rather than
   * assumed away: reporting a hardcoded zero would blank a badge that should
   * be showing 1.
   */
  async markAllRead(userId: string): Promise<number> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });

    return this.unreadCount(userId);
  }
}

/**
 * A row as the API sends it: dates as ISO-8601 strings.
 *
 * Done here rather than left to the serialiser so the shape is decided by code
 * that is about the response shape, and so it matches
 * `NotificationStreamEvent` — a client must be able to drop a streamed event
 * into the list it fetched without a second mapping.
 */
function toResponse(row: {
  id: string;
  eventKey: string;
  title: string;
  body: string;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}): NotificationResponse {
  return {
    id: row.id,
    eventKey: row.eventKey,
    title: row.title,
    body: row.body,
    link: row.link,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
