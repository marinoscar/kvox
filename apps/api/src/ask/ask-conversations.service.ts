// =============================================================================
// AskConversationsService (issue #376, epic #348; docs/specs/ontology.md §21)
// =============================================================================
//
// List / get / create / rename / delete over the caller's OWN saved Ask
// conversations. Posting a message and the `ask.respond` job are #378; the
// stream is #379. Nothing here calls a provider.
//
// - Every read is scoped `owner_id = $caller` in the query itself; a single
//   conversation is authorised through `AskAccessService` (404, never 403).
// - `scopeEntity` is read LIVE from `kg_entities` and is `null` once the
//   entity was merged or forgotten (the FK is SetNull; a merge tombstone is
//   filtered by `readableEntitySql`), so a renamed person shows their new
//   label and a forgotten one shows nothing.
// - The list and the message pager compare timestamps IN SQL, at the column's
//   own microsecond precision — see `ask-cursor.ts` for why a JS `Date` key
//   would skip rows.
// - Deleting a conversation whose turn is running is ALLOWED: the cascade
//   removes the message; `ask.respond` (#378) returns normally when its row is
//   gone and the stream (#379) emits `error { errorClass: 'gone' }`.
// =============================================================================

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { GraphAccessService } from '../graph/access/graph-access.service';
import { readableEntitySql } from '../graph/read/read-sql';
import { PrismaService } from '../prisma/prisma.service';
import { ASK_CONVERSATION_NOT_FOUND, AskAccessService } from './ask-access.service';
import { AskCursorError, decodeAskCursor, encodeAskCursor, type AskCursorScope } from './ask-cursor';
import { previewText, toAskMessage, type AskMessageRow } from './ask-message.mapper';
import {
  ASK_DETAIL_MESSAGE_LIMIT,
  type AskConversationDetail,
  type AskConversationSummary,
  type CreateAskConversation,
  type GetAskConversationQuery,
  type ListAskConversationsQuery,
  type ListAskConversationsResponse,
  type RenameAskConversation,
} from './dto/ask.dto';

/** The audit action a delete writes. */
export const ASK_CONVERSATION_DELETED_ACTION = 'ask.conversation_deleted';

/**
 * How much of the newest message's text the list reads to build a preview.
 * Generous against markers being stripped before the 140-character cut.
 */
const PREVIEW_SOURCE_CHARS = 2000;

/** One row of the summary query. Exported for the service's own spec. */
export interface AskSummaryRow {
  id: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** `updated_at` rendered by Postgres with microseconds — the cursor key. */
  cursorKey: string;
  scopeId: string | null;
  scopeLabel: string | null;
  scopeType: string | null;
  preview: string | null;
  running: boolean;
}

/** Summary row → wire. Pure; exported for the spec. */
export function toAskConversationSummary(row: AskSummaryRow): AskConversationSummary {
  return {
    id: row.id,
    title: row.title,
    scopeEntity:
      row.scopeId && row.scopeLabel !== null && row.scopeType !== null
        ? { id: row.scopeId, label: row.scopeLabel, type: row.scopeType }
        : null,
    lastMessagePreview: previewText(row.preview),
    running: row.running === true,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class AskConversationsService {
  private readonly logger = new Logger(AskConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AskAccessService,
    private readonly graphAccess: GraphAccessService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async list(userId: string, query: ListAskConversationsQuery): Promise<ListAskConversationsResponse> {
    const scope: AskCursorScope = { userId, scopeEntityId: query.scopeEntityId ?? null };
    const filters: Prisma.Sql[] = [];

    if (query.scopeEntityId) {
      filters.push(Prisma.sql`c.scope_entity_id = ${query.scopeEntityId}::uuid`);
    }
    if (query.cursor) {
      const pos = this.decodeCursorOr400(query.cursor, scope);
      filters.push(Prisma.sql`(c.updated_at, c.id) < (${pos.k}::timestamptz, ${pos.id}::uuid)`);
    }

    const rows = await this.summaryRows(userId, filters, query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];

    return {
      items: page.map(toAskConversationSummary),
      nextCursor: rows.length > query.limit && last ? encodeAskCursor(scope, { k: last.cursorKey, id: last.id }) : null,
    };
  }

  async get(userId: string, id: string, query: GetAskConversationQuery): Promise<AskConversationDetail> {
    await this.access.requireConversation(userId, id);
    const summary = await this.summaryById(userId, id);

    let beforeSql = Prisma.empty;
    if (query.before) {
      const anchor = await this.prisma.askMessage.findFirst({
        where: { id: query.before, conversationId: id },
        select: { id: true },
      });
      if (!anchor) throw new BadRequestException('`before` does not name a message in this conversation');
      // Compared against the anchor's own row, in SQL, at full precision.
      beforeSql = Prisma.sql`AND (m.created_at, m.id) < (
        SELECT a.created_at, a.id FROM ask_messages a WHERE a.id = ${query.before}::uuid)`;
    }

    const rows = await this.prisma.$queryRaw<AskMessageRow[]>`
      SELECT m.id,
             m.conversation_id   AS "conversationId",
             m.role::text        AS role,
             m.content,
             m.status::text      AS status,
             m.tool_calls        AS "toolCalls",
             m.citations,
             m.model,
             m.provider,
             m.prompt_tokens     AS "promptTokens",
             m.completion_tokens AS "completionTokens",
             m.error_class::text AS "errorClass",
             m.finish_reason::text AS "finishReason",
             m.created_at        AS "createdAt"
        FROM ask_messages m
       WHERE m.conversation_id = ${id}::uuid ${beforeSql}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${ASK_DETAIL_MESSAGE_LIMIT + 1}`;

    const hasEarlier = rows.length > ASK_DETAIL_MESSAGE_LIMIT;
    const messages = rows.slice(0, ASK_DETAIL_MESSAGE_LIMIT).reverse().map(toAskMessage);
    return {
      id: summary.id,
      title: summary.title,
      scopeEntity: summary.scopeEntity,
      running: summary.running,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      messages,
      hasEarlier,
    };
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async create(userId: string, dto: CreateAskConversation): Promise<AskConversationSummary> {
    let scopeEntity: AskConversationSummary['scopeEntity'] = null;
    if (dto.scopeEntityId) {
      // 404 — byte-identical to every other entity 404 — for a missing, a
      // foreign, an unreviewed or a merged entity. See GraphAccessService.
      const entity = await this.graphAccess.require(userId, 'entity', dto.scopeEntityId, 'view');
      scopeEntity = { id: entity.id, label: entity.label, type: entity.type };
    }

    const row = await this.prisma.askConversation.create({
      data: { ownerId: userId, title: dto.title ?? null, scopeEntityId: scopeEntity?.id ?? null },
    });

    return {
      id: row.id,
      title: row.title,
      scopeEntity,
      lastMessagePreview: null,
      running: false,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async rename(userId: string, id: string, dto: RenameAskConversation): Promise<AskConversationSummary> {
    await this.access.requireConversation(userId, id);
    // `updateMany` keeps the owner in the WHERE clause of the write itself.
    const { count } = await this.prisma.askConversation.updateMany({
      where: { id, ownerId: userId },
      data: { title: dto.title },
    });
    if (count === 0) throw new NotFoundException(ASK_CONVERSATION_NOT_FOUND);
    return this.summaryById(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const conversation = await this.access.requireConversation(userId, id);

    const messageCount = await this.prisma.$transaction(async (tx) => {
      const count = await tx.askMessage.count({ where: { conversationId: id } });
      // Messages go with it (conversation_id Cascade) — a running turn included.
      const deleted = await tx.askConversation.deleteMany({ where: { id, ownerId: userId } });
      if (deleted.count === 0) throw new NotFoundException(ASK_CONVERSATION_NOT_FOUND);
      await this.audit(tx, userId, id, { messageCount: count, scopeEntityId: conversation.scopeEntityId });
      return count;
    });

    this.logger.log({ msg: 'ask conversation deleted', conversationId: id, messageCount });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async summaryById(userId: string, id: string): Promise<AskConversationSummary> {
    const [row] = await this.summaryRows(userId, [Prisma.sql`c.id = ${id}::uuid`], 1);
    if (!row) throw new NotFoundException(ASK_CONVERSATION_NOT_FOUND);
    return toAskConversationSummary(row);
  }

  /**
   * The one summary query: the caller's conversations (owner scope is always
   * the first predicate), the live scope entity, the newest message that has
   * text, and whether a turn is running — ordered `updated_at DESC, id DESC`.
   */
  private summaryRows(userId: string, filters: Prisma.Sql[], limit: number): Promise<AskSummaryRow[]> {
    const where = Prisma.join([Prisma.sql`c.owner_id = ${userId}::uuid`, ...filters], ' AND ');

    return this.prisma.$queryRaw<AskSummaryRow[]>`
      SELECT c.id,
             c.title,
             c.created_at AS "createdAt",
             c.updated_at AS "updatedAt",
             to_char(c.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorKey",
             e.id    AS "scopeId",
             e.label AS "scopeLabel",
             e.type  AS "scopeType",
             lm.preview,
             EXISTS (
               SELECT 1 FROM ask_messages r
                WHERE r.conversation_id = c.id
                  AND r.role = 'assistant'
                  AND r.status IN ('pending', 'streaming')
             ) AS running
        FROM ask_conversations c
        LEFT JOIN kg_entities e
               ON e.id = c.scope_entity_id
              AND e.owner_id = c.owner_id
              AND ${readableEntitySql('e')}
        LEFT JOIN LATERAL (
               SELECT left(m.content, ${PREVIEW_SOURCE_CHARS}::int) AS preview
                 FROM ask_messages m
                WHERE m.conversation_id = c.id AND m.content <> ''
                ORDER BY m.created_at DESC, m.id DESC
                LIMIT 1
             ) lm ON true
       WHERE ${where}
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT ${limit}`;
  }

  private decodeCursorOr400(cursor: string, scope: AskCursorScope) {
    try {
      return decodeAskCursor(cursor, scope);
    } catch (err) {
      if (err instanceof AskCursorError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /**
   * The module's audit write — the `NotesService.audit` pattern. `meta` carries
   * counts and ids only, NEVER message content.
   */
  private async audit(
    tx: Prisma.TransactionClient,
    userId: string,
    conversationId: string,
    meta: { messageCount: number; scopeEntityId: string | null },
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        actorUserId: userId,
        action: ASK_CONVERSATION_DELETED_ACTION,
        targetType: 'ask_conversation',
        targetId: conversationId,
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}
