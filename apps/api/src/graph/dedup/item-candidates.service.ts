// =============================================================================
// ItemCandidateService — the graph reads work-item dedup and closing need
// (issue #365; docs/specs/ontology.md §5.4, §7, §8)
// =============================================================================
//
// Every query filters `owner_id` — the owner's own graph only. "Live" means
// `review_status IN ('accepted','edited')` (and, for items,
// `superseded_by_id IS NULL`): a rejected, merged or superseded row is never a
// dedup target and never closed.
//
//   knownItem        §8 "known, skipped": same kind, subject and statement hash
//   itemCandidates   §7 work-item dedup: same kind + subject (+ owner for a
//                    commitment), cosine against the proposed item's vector
//                    where both sides have one of the same model; never a
//                    `sensitive` PersonFact (§5.6 — it would reach a prompt)
//   liveEdges        #353's planner input for one (type, from) pair
//   openCommitments  §5.4's company-change side effect
//   entityLabels     the "Closes: …" copy and the adjudication prompt
//   proposalQuotes   a proposed row's own quotes, for the prompt
// =============================================================================

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { fromPgRange, type TemporalEdge, type TemporalReviewStatus, type ValidPrecision } from '../temporal';
import { vectorLiteral } from '../resolution/graph-embedder.service';
import { jaccard, type ItemCandidate } from './dedup-core';

/** A bounded candidate pool: the ranking narrows it to five. */
export const ITEM_CANDIDATE_POOL = 200;

export interface ExistingItemRow {
  id: string;
  kind: string;
  title: string | null;
  statement: string;
  status: string;
  occurredAt: string | null;
  dueAt: string | null;
  ownerPersonId: string | null;
  counterpartyId: string | null;
}

export interface ItemCandidateQuery {
  kind: string;
  subjectId: string | null;
  /** Commitments only: restrict to this owner person when the proposal names one. */
  ownerPersonId: string | null;
  statement: string;
  vector: { values: number[]; model: string } | null;
}

export interface ItemCandidateResult extends ItemCandidate {
  row: ExistingItemRow;
}

function day(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

@Injectable()
export class ItemCandidateService {
  constructor(private readonly prisma: PrismaService) {}

  /** The live item this statement already is, or null. */
  async knownItem(
    ownerId: string,
    q: { kind: string; subjectId: string | null; statementHash: string },
  ): Promise<string | null> {
    const row = await this.prisma.kgItem.findFirst({
      where: {
        ownerId,
        kind: q.kind as never,
        subjectId: q.subjectId,
        statementHash: q.statementHash,
        reviewStatus: { in: ['accepted', 'edited'] },
        supersededById: null,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * Every live candidate with its cosine (when both sides share an embedding
   * model) or its lexical score. Unranked and unfiltered — `selectCandidates`
   * applies the thresholds.
   */
  async itemCandidates(ownerId: string, q: ItemCandidateQuery): Promise<ItemCandidateResult[]> {
    const vec = q.vector ? vectorLiteral(q.vector.values) : null;
    const model = q.vector?.model ?? null;
    const ownerFilter =
      q.kind === 'commitment' && q.ownerPersonId
        ? Prisma.sql`AND i.owner_person_id = ${q.ownerPersonId}::uuid`
        : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        kind: string;
        title: string | null;
        statement: string;
        status: string;
        occurred_at: Date | null;
        due_at: Date | null;
        owner_person_id: string | null;
        counterparty_id: string | null;
        cosine: number | null;
      }>
    >`
      SELECT i.id::text AS id, i.kind::text AS kind, i.title, i.statement, i.status,
             i.occurred_at, i.due_at,
             i.owner_person_id::text AS owner_person_id, i.counterparty_id::text AS counterparty_id,
             CASE WHEN i.embedding IS NOT NULL AND i.embedding_model = ${model}
                  THEN (1 - (i.embedding <=> ${vec}::vector))::float8 END AS cosine
        FROM kg_items i
       WHERE i.owner_id = ${ownerId}::uuid
         AND i.kind = ${q.kind}::kg_item_kind
         AND i.subject_id IS NOT DISTINCT FROM ${q.subjectId}::uuid
         AND i.review_status IN ('accepted', 'edited')
         AND i.superseded_by_id IS NULL
         AND (i.sensitivity IS NULL OR i.sensitivity <> 'sensitive')
         ${ownerFilter}
       ORDER BY cosine DESC NULLS LAST, i.occurred_at DESC NULLS LAST, i.id
       LIMIT ${ITEM_CANDIDATE_POOL}`;

    return rows.map((r) => {
      const cosine = r.cosine === null ? null : Math.max(0, Math.min(1, Number(r.cosine)));
      return {
        itemId: r.id,
        cosine,
        lexical: cosine === null ? jaccard(q.statement, r.statement) : null,
        row: {
          id: r.id,
          kind: r.kind,
          title: r.title,
          statement: r.statement,
          status: r.status,
          occurredAt: day(r.occurred_at),
          dueAt: day(r.due_at),
          ownerPersonId: r.owner_person_id,
          counterpartyId: r.counterparty_id,
        },
      };
    });
  }

  /** Live edges of one type from one entity, as #353's planner reads them. */
  async liveEdges(ownerId: string, type: string, fromId: string): Promise<TemporalEdge[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        type: string;
        from_id: string;
        to_id: string;
        props: unknown;
        valid: string | null;
        valid_precision: string | null;
        review_status: string;
      }>
    >`
      SELECT r.id::text AS id, r.type, r.from_id::text AS from_id, r.to_id::text AS to_id, r.props,
             r.valid::text AS valid, r.valid_precision::text AS valid_precision,
             r.review_status::text AS review_status
        FROM kg_relations r
       WHERE r.owner_id = ${ownerId}::uuid
         AND r.type = ${type}
         AND r.from_id = ${fromId}::uuid
         AND r.review_status IN ('accepted', 'edited')
       ORDER BY r.id`;
    return rows.map((r) => {
      let valid: TemporalEdge['valid'] = null;
      if (r.valid !== null && !/^empty$/i.test(r.valid)) {
        try {
          valid = fromPgRange(r.valid);
        } catch {
          valid = null;
        }
      }
      return {
        id: r.id,
        type: r.type,
        fromId: r.from_id,
        toId: r.to_id,
        props: (r.props ?? {}) as Record<string, unknown>,
        valid,
        precision: (r.valid_precision as ValidPrecision | null) ?? null,
        reviewStatus: r.review_status as TemporalReviewStatus,
      };
    });
  }

  /** The person's open, live commitments — as owner or counterparty. */
  async openCommitments(ownerId: string, personId: string): Promise<ExistingItemRow[]> {
    const rows = await this.prisma.kgItem.findMany({
      where: {
        ownerId,
        kind: 'commitment',
        status: 'open',
        reviewStatus: { in: ['accepted', 'edited'] },
        supersededById: null,
        OR: [{ ownerPersonId: personId }, { counterpartyId: personId }],
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
      take: 100,
      select: {
        id: true,
        kind: true,
        title: true,
        statement: true,
        status: true,
        occurredAt: true,
        dueAt: true,
        ownerPersonId: true,
        counterpartyId: true,
      },
    });
    return rows.map((r) => ({ ...r, occurredAt: day(r.occurredAt), dueAt: day(r.dueAt) }));
  }

  /** The proposed rows' own quotes (their `proposal_item` evidence), oldest first. */
  async proposalQuotes(ownerId: string, rowIds: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (rowIds.length === 0) return out;
    const evidence = await this.prisma.kgEvidence.findMany({
      where: { ownerId, subjectKind: 'proposal_item', subjectId: { in: [...rowIds] } },
      select: { subjectId: true, quote: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const e of evidence) out.set(e.subjectId, [...(out.get(e.subjectId) ?? []), e.quote]);
    return out;
  }

  async entityLabels(ownerId: string, ids: readonly string[]): Promise<Map<string, { label: string; type: string }>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.kgEntity.findMany({
      where: { ownerId, id: { in: unique } },
      select: { id: true, label: true, type: true },
    });
    return new Map(rows.map((r) => [r.id, { label: r.label, type: r.type }]));
  }
}
