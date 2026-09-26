// =============================================================================
// GraphReadService (#370, epic #347; docs/specs/ontology.md §5.5, §9, §12)
// =============================================================================
//
// The entity index, the entity page's detail, its mentions and its timeline.
// Exported for the brief (#372) and the Ask agent's tools (#377), so every
// consumer reads the graph through the same readable-status filter, the same
// merge-tombstone exclusion and the same `as_of` predicate.
//
// OWNER SCOPING LIVES IN EVERY STATEMENT (`owner_id = $owner`), not only in
// the `GraphAccessService` pre-check: a query that forgot the pre-check still
// cannot return another owner's row. No access is a 404, never a 403.
//
// ⚠ Never log a label, a statement or a quote — ids and counts only.
// =============================================================================

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptAccessService } from '../../transcripts/transcript-access.service';
import { GRAPH_NOT_FOUND_MESSAGES, GraphAccessService } from '../access/graph-access.service';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import { normalizeAlias } from '../write/normalize';
import type {
  GraphEntityDetail,
  ListEntitiesQuery,
  ListEntitiesResponse,
  MentionsQuery,
  MentionsResponse,
} from './dto/graph-read.dto';
import { decodeGraphCursor, encodeGraphCursor, GraphCursorError, type GraphCursorRoute } from './graph-cursor';
import { resolveEntityTypes } from './read-params';
import {
  isoMicrosSql,
  readableEntitySql,
  readableItemSql,
  readableMentionSql,
  readableRelationSql,
  notSensitiveSql,
  uuidArray,
  textArray,
} from './read-sql';
import { relationValidAtSql } from './as-of';

/** Up to this many aliases on an index row. */
const SUMMARY_ALIAS_LIMIT = 5;

/** The caller, as every read method needs it. */
export interface GraphReader {
  id: string;
}

/** `GraphCursorError` → 400, anything else untouched. */
export function decodeCursorOr400(cursor: string, route: GraphCursorRoute) {
  try {
    return decodeGraphCursor(cursor, route);
  } catch (err) {
    if (err instanceof GraphCursorError) throw new BadRequestException(err.message);
    throw err;
  }
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

@Injectable()
export class GraphReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GraphAccessService,
    private readonly ontology: GraphOntologyService,
    private readonly transcriptAccess: TranscriptAccessService,
  ) {}

  // ===========================================================================
  // GET /api/graph/entities
  // ===========================================================================

  async listEntities(user: GraphReader, query: ListEntitiesQuery): Promise<ListEntitiesResponse> {
    const ownerId = user.id;
    const schema = await this.ontology.effectiveSchemaFor(ownerId);
    const types = resolveEntityTypes(schema, query.type, 'type');

    // A transcript the caller cannot view is the transcript module's own 404.
    if (query.transcriptId) {
      await this.transcriptAccess.require(ownerId, query.transcriptId, 'view');
    }

    const filters: Prisma.Sql[] = [Prisma.sql`e.owner_id = ${ownerId}::uuid`, readableEntitySql('e')];
    if (types) filters.push(Prisma.sql`e.type = ANY(${textArray(types)})`);
    if (query.transcriptId) {
      filters.push(Prisma.sql`e.id IN (
        SELECT r.to_id FROM kg_relations r
        JOIN transcript_speakers s ON s.id = r.from_speaker_id
        WHERE r.owner_id = ${ownerId}::uuid AND r.type = 'IDENTIFIED_AS' AND ${readableRelationSql('r')}
          AND s.transcript_id = ${query.transcriptId}::uuid)`);
    }

    let rows: { id: string; type: string; label: string; sort_key: string | null }[];
    let nextCursor: string | null = null;

    if (query.q) {
      rows = await this.searchEntityRows(ownerId, query.q, filters, query.limit);
    } else {
      const route: GraphCursorRoute = query.sort === 'viewed' ? 'entities:viewed' : 'entities:updated';
      const sortCol = query.sort === 'viewed' ? Prisma.sql`v.last_viewed_at` : Prisma.sql`e.updated_at`;
      const join =
        query.sort === 'viewed'
          ? Prisma.sql`JOIN kg_entity_views v ON v.user_id = ${ownerId}::uuid AND v.entity_id = e.id`
          : Prisma.empty;
      if (query.cursor) {
        const pos = decodeCursorOr400(query.cursor, route);
        if (pos.k === null) throw new BadRequestException('This cursor is not readable. Reload the list from the start.');
        filters.push(Prisma.sql`(${sortCol}, e.id) < (${pos.k}::timestamptz, ${pos.id}::uuid)`);
      }
      const page = await this.prisma.$queryRaw<{ id: string; type: string; label: string; sort_key: string }[]>`
        SELECT e.id::text AS id, e.type, e.label, ${isoMicrosSql(sortCol)} AS sort_key
        FROM kg_entities e ${join}
        WHERE ${Prisma.join(filters, ' AND ')}
        ORDER BY ${sortCol} DESC, e.id DESC
        LIMIT ${query.limit + 1}`;
      if (page.length > query.limit) {
        const last = page[query.limit - 1];
        nextCursor = encodeGraphCursor(route, { k: last.sort_key, id: last.id });
      }
      rows = page.slice(0, query.limit);
    }

    const ids = rows.map((r) => r.id);
    const [aliases, mentionCounts, seen, speakers] = await Promise.all([
      this.aliasesFor(ownerId, ids),
      this.mentionCountsFor(ownerId, ids),
      this.seenRangeFor(ownerId, ids),
      query.transcriptId ? this.speakersFor(ownerId, query.transcriptId, ids) : Promise.resolve(null),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        label: r.label,
        aliases: (aliases.get(r.id) ?? []).filter((a) => a !== r.label).slice(0, SUMMARY_ALIAS_LIMIT),
        mentionCount: mentionCounts.get(r.id) ?? 0,
        lastSeenAt: iso(seen.get(r.id)?.last),
        ...(speakers ? { speakerIds: speakers.get(r.id) ?? [] } : {}),
      })),
      nextCursor,
    };
  }

  /** Trigram candidates on label or alias, ranked by the better of the two similarities. */
  private async searchEntityRows(ownerId: string, q: string, filters: Prisma.Sql[], limit: number) {
    let normalized: string;
    try {
      normalized = normalizeAlias(q);
    } catch {
      normalized = q.toLowerCase();
    }
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.prisma.$queryRaw<{ id: string; type: string; label: string; sort_key: null }[]>`
      SELECT e.id::text AS id, e.type, e.label, NULL AS sort_key
      FROM kg_entities e
      WHERE ${Prisma.join(filters, ' AND ')}
        AND (
          e.label % ${q}
          OR e.label ILIKE ${pattern} ESCAPE '\\'
          OR e.id IN (SELECT a.entity_id FROM kg_entity_aliases a
                      WHERE a.owner_id = ${ownerId}::uuid AND a.normalized % ${normalized})
        )
      ORDER BY greatest(
                 similarity(e.label, ${q}),
                 coalesce((SELECT max(similarity(a.normalized, ${normalized}))
                           FROM kg_entity_aliases a WHERE a.entity_id = e.id), 0)
               ) DESC,
               e.id DESC
      LIMIT ${limit}`;
  }

  // ===========================================================================
  // GET /api/graph/entities/:id
  // ===========================================================================

  async getEntity(user: GraphReader, id: string): Promise<GraphEntityDetail> {
    const ownerId = user.id;
    const entity = await this.access.require(ownerId, 'entity', id, 'view');
    // `require` admits exactly accepted/edited here (merged, unreviewed and
    // rejected are its 404); the tombstone column is checked for belt and braces.
    if (entity.mergedIntoId !== null) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);

    const now = new Date();
    const [aliases, mentionCounts, seen, counts] = await Promise.all([
      this.prisma.kgEntityAlias.findMany({
        where: { entityId: id, ownerId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, alias: true, source: true },
      }),
      this.mentionCountsFor(ownerId, [id]),
      this.seenRangeFor(ownerId, [id]),
      this.prisma.$queryRaw<
        {
          relations: number;
          evidence: number;
          commitment: number;
          decision: number;
          claim: number;
          person_fact: number;
          open_commitments: number;
        }[]
      >`
        SELECT
          (SELECT count(*)::int FROM kg_relations r
             JOIN kg_entities o ON o.id = CASE WHEN r.from_id = ${id}::uuid THEN r.to_id ELSE r.from_id END
            WHERE r.owner_id = ${ownerId}::uuid AND (r.from_id = ${id}::uuid OR r.to_id = ${id}::uuid)
              AND r.from_id IS NOT NULL AND ${readableRelationSql('r')} AND ${relationValidAtSql('r', now)}
              AND ${readableEntitySql('o')}) AS relations,
          (SELECT count(*)::int FROM kg_evidence ev
            WHERE ev.owner_id = ${ownerId}::uuid AND ev.subject_kind = 'entity' AND ev.subject_id = ${id}::uuid) AS evidence,
          count(*) FILTER (WHERE i.kind = 'commitment')::int AS commitment,
          count(*) FILTER (WHERE i.kind = 'decision')::int AS decision,
          count(*) FILTER (WHERE i.kind = 'claim')::int AS claim,
          count(*) FILTER (WHERE i.kind = 'person_fact')::int AS person_fact,
          count(*) FILTER (WHERE i.kind = 'commitment' AND i.status = 'open')::int AS open_commitments
        FROM (
          SELECT i.id, i.kind, i.status FROM kg_items i
          WHERE i.owner_id = ${ownerId}::uuid
            AND (i.subject_id = ${id}::uuid OR i.owner_person_id = ${id}::uuid
                 OR i.counterparty_id = ${id}::uuid OR i.meeting_id = ${id}::uuid)
            AND ${readableItemSql('i')} AND ${notSensitiveSql('i')}
        ) i`,
    ]);

    const c = counts[0];
    const range = seen.get(id);
    return {
      id: entity.id,
      type: entity.type,
      label: entity.label,
      props: (entity.props ?? {}) as Record<string, unknown>,
      aliases: aliases.map((a) => ({ id: a.id, alias: a.alias, source: a.source })),
      occurredAt: iso(entity.occurredAt),
      reviewStatus: entity.reviewStatus as 'accepted' | 'edited',
      ontologyVersion: entity.ontologyVersion,
      firstSeenAt: iso(range?.first),
      lastSeenAt: iso(range?.last),
      counts: {
        relations: c.relations,
        mentions: mentionCounts.get(id) ?? 0,
        evidence: c.evidence,
        items: { commitment: c.commitment, decision: c.decision, claim: c.claim, person_fact: c.person_fact },
        openCommitments: c.open_commitments,
      },
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }

  // ===========================================================================
  // GET /api/graph/entities/:id/mentions
  // ===========================================================================

  /**
   * The notes and transcripts linked to this entity, one row per document,
   * newest first (a transcript's `recorded_at`, a note's `created_at`).
   * `available: false` — title nulled — when the document is soft-deleted or
   * the caller can no longer view it (a revoked transcript share).
   */
  async mentions(user: GraphReader, id: string, query: MentionsQuery): Promise<MentionsResponse> {
    const ownerId = user.id;
    await this.access.require(ownerId, 'entity', id, 'view');

    const keyset: Prisma.Sql[] = [];
    if (query.cursor) {
      const pos = decodeCursorOr400(query.cursor, 'mentions');
      keyset.push(
        pos.k === null
          ? Prisma.sql`(d.at IS NULL AND d.doc_id < ${pos.id}::uuid)`
          : Prisma.sql`(d.at < ${pos.k}::timestamptz OR (d.at = ${pos.k}::timestamptz AND d.doc_id < ${pos.id}::uuid) OR d.at IS NULL)`,
      );
    }

    const rows = await this.prisma.$queryRaw<
      { kind: 'note' | 'transcript'; doc_id: string; title: string | null; at: Date | null; at_key: string | null; available: boolean }[]
    >`
      SELECT d.kind, d.doc_id::text AS doc_id, d.title, d.at, ${isoMicrosSql(Prisma.sql`d.at`)} AS at_key, d.available
      FROM (
        SELECT 'note' AS kind, n.id AS doc_id, n.created_at AS at,
               (n.deleted_at IS NULL AND n.owner_id = ${ownerId}::uuid) AS available,
               CASE WHEN n.deleted_at IS NULL AND n.owner_id = ${ownerId}::uuid THEN n.title END AS title
        FROM notes n
        WHERE n.id IN (SELECT m.note_id FROM kg_mentions m
                       WHERE m.owner_id = ${ownerId}::uuid AND m.entity_id = ${id}::uuid
                         AND m.note_id IS NOT NULL AND ${readableMentionSql('m')})
        UNION ALL
        SELECT 'transcript', t.id, t.recorded_at, v.ok, CASE WHEN v.ok THEN t.title END
        FROM transcripts t
        CROSS JOIN LATERAL (SELECT (t.deleted_at IS NULL AND (t.owner_id = ${ownerId}::uuid OR EXISTS (
                   SELECT 1 FROM transcript_shares s WHERE s.transcript_id = t.id AND s.user_id = ${ownerId}::uuid))) AS ok) v
        WHERE t.id IN (SELECT m.transcript_id FROM kg_mentions m
                       WHERE m.owner_id = ${ownerId}::uuid AND m.entity_id = ${id}::uuid
                         AND m.transcript_id IS NOT NULL AND ${readableMentionSql('m')})
      ) d
      ${keyset.length ? Prisma.sql`WHERE ${keyset[0]}` : Prisma.empty}
      ORDER BY d.at DESC NULLS LAST, d.doc_id DESC
      LIMIT ${query.limit + 1}`;

    let nextCursor: string | null = null;
    if (rows.length > query.limit) {
      const last = rows[query.limit - 1];
      nextCursor = encodeGraphCursor('mentions', { k: last.at_key, id: last.doc_id });
    }
    return {
      items: rows.slice(0, query.limit).map((r) => ({
        kind: r.kind,
        id: r.doc_id,
        title: r.available ? r.title : null,
        // When the document is gone to the caller, even its date is not theirs to see.
        occurredAt: r.available ? iso(r.at) : null,
        available: r.available,
      })),
      nextCursor,
    };
  }

  // ===========================================================================
  // Batch helpers (bounded: one query each for a page of ids)
  // ===========================================================================

  /** Aliases per entity, oldest first. */
  private async aliasesFor(ownerId: string, ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    const rows = await this.prisma.$queryRaw<{ entity_id: string; alias: string }[]>`
      SELECT entity_id::text AS entity_id, alias FROM (
        SELECT a.entity_id, a.alias,
               row_number() OVER (PARTITION BY a.entity_id ORDER BY a.created_at, a.id) AS rn
        FROM kg_entity_aliases a
        WHERE a.owner_id = ${ownerId}::uuid AND a.entity_id = ANY(${uuidArray(ids)})
      ) x WHERE rn <= ${SUMMARY_ALIAS_LIMIT + 1}
      ORDER BY entity_id, rn`;
    for (const r of rows) {
      const list = out.get(r.entity_id) ?? [];
      list.push(r.alias);
      out.set(r.entity_id, list);
    }
    return out;
  }

  /** Documents (notes + transcripts) that mention each entity. */
  private async mentionCountsFor(ownerId: string, ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ entity_id: string; n: number }[]>`
      SELECT m.entity_id::text AS entity_id,
             (count(DISTINCT m.note_id) + count(DISTINCT m.transcript_id))::int AS n
      FROM kg_mentions m
      WHERE m.owner_id = ${ownerId}::uuid AND m.entity_id = ANY(${uuidArray(ids)}) AND ${readableMentionSql('m')}
      GROUP BY m.entity_id`;
    return new Map(rows.map((r) => [r.entity_id, r.n]));
  }

  /**
   * First/last `occurred_at` of the Meetings each entity has evidence in: a
   * Meeting is drawn from a transcript or a note (its `transcriptId`/`noteId`
   * props, §5.1), and an evidence row cites one. A Meeting's own date counts
   * for itself.
   */
  private async seenRangeFor(ownerId: string, ids: string[]): Promise<Map<string, { first: Date | null; last: Date | null }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ entity_id: string; first: Date | null; last: Date | null }[]>`
      SELECT x.entity_id::text AS entity_id, min(x.at) AS first, max(x.at) AS last FROM (
        SELECT ev.subject_id AS entity_id, m.occurred_at AS at
        FROM kg_evidence ev
        JOIN kg_entities m ON m.owner_id = ${ownerId}::uuid AND m.type = 'Meeting' AND ${readableEntitySql('m')}
          AND m.occurred_at IS NOT NULL
          AND ((ev.transcript_id IS NOT NULL AND m.props->>'transcriptId' = ev.transcript_id::text)
            OR (ev.note_id IS NOT NULL AND m.props->>'noteId' = ev.note_id::text))
        WHERE ev.owner_id = ${ownerId}::uuid AND ev.subject_kind = 'entity' AND ev.subject_id = ANY(${uuidArray(ids)})
        UNION ALL
        SELECT e.id, e.occurred_at FROM kg_entities e
        WHERE e.owner_id = ${ownerId}::uuid AND e.id = ANY(${uuidArray(ids)}) AND e.type = 'Meeting' AND e.occurred_at IS NOT NULL
      ) x GROUP BY x.entity_id`;
    return new Map(rows.map((r) => [r.entity_id, { first: r.first, last: r.last }]));
  }

  /** `from_speaker_id`s identified as each Person, in this transcript. */
  private async speakersFor(ownerId: string, transcriptId: string, ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    const rows = await this.prisma.$queryRaw<{ entity_id: string; speaker_id: string }[]>`
      SELECT r.to_id::text AS entity_id, r.from_speaker_id::text AS speaker_id
      FROM kg_relations r
      JOIN transcript_speakers s ON s.id = r.from_speaker_id
      WHERE r.owner_id = ${ownerId}::uuid AND r.type = 'IDENTIFIED_AS' AND ${readableRelationSql('r')}
        AND s.transcript_id = ${transcriptId}::uuid AND r.to_id = ANY(${uuidArray(ids)})
      ORDER BY r.from_speaker_id`;
    for (const r of rows) {
      const list = out.get(r.entity_id) ?? [];
      list.push(r.speaker_id);
      out.set(r.entity_id, list);
    }
    return out;
  }
}
