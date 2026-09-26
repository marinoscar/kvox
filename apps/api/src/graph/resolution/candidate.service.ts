// =============================================================================
// CandidateService (#364, epic #346; docs/specs/ontology.md §7, §10)
// =============================================================================
//
// Candidate generation: deliberately over-generate, and let `score.ts` narrow.
// Three arms, UNIONED and de-duplicated by entity id (each arm's own best
// signal kept side by side for the scorer):
//
//   A  alias/label exact — `kg_entity_aliases.normalized = ANY($names)`, the
//      mention's label and aliases normalized with #355's `normalizeAlias` in
//      TypeScript. Relies on #355's contract that every entity's own label is
//      also an alias row, so SQL never normalizes a label a second way.
//   B  trigram ≥ 0.4 — `pg_trgm` over the entity label and the aliases'
//      NORMALIZED form (the column `kg_entity_aliases_normalized_trgm_idx`
//      indexes — the issue text says `a.alias`, which has no index), with
//      `pg_trgm.similarity_threshold` set LOCAL to the transaction; top 20.
//   C  vector kNN, k = 10, cosine over the HNSW index — only when the caller
//      has a mention vector, and only against vectors of the SAME embedding
//      model (two models' vectors are not comparable at any width).
//
// Every arm filters: this owner, this type, `accepted`/`edited`, not merged.
// Distinct pairs (§7): a pair a person confirmed "not the same" never comes
// back — `excludeIds` (bulk mode: the entity being resolved) drops every
// candidate it has a `kg_distinct_pairs` row with, and the ids themselves;
// `excludeCandidateIds` drops named ids outright (a proposal row's
// `distinct_from`).
//
// Every query is a `$queryRaw` tagged template — values are bound parameters,
// never concatenated.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { normalizeAlias } from '../write/normalize';
import { vectorLiteral } from './graph-embedder.service';

export const TRIGRAM_THRESHOLD = 0.4;
export const TRIGRAM_LIMIT = 20;
export const VECTOR_K = 10;

export interface CandidateMention {
  type: string;
  label: string;
  aliases: readonly string[];
  /** The mention's profile vector, and the embedding model it came from. */
  vector?: { values: readonly number[]; model: string } | null;
  /** Bulk mode: use this committed entity's STORED vector (and its model) instead. */
  vectorOfEntityId?: string | null;
  /** Bulk mode: entities whose distinct pairs (and themselves) are excluded. */
  excludeIds?: readonly string[];
  /** Ids never to return, whatever the arms say. */
  excludeCandidateIds?: readonly string[];
}

export interface RawCandidate {
  entityId: string;
  label: string;
  type: string;
  aliasExact: boolean;
  trigram: number | null;
  cosine: number | null;
}

type Db = PrismaService | Prisma.TransactionClient;

/** Normalized forms of a label and its aliases; names that normalize to nothing are skipped. */
export function normalizedNames(label: string, aliases: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of [label, ...aliases]) {
    try {
      out.add(normalizeAlias(name));
    } catch {
      // A name with no letters or digits cannot match anything.
    }
  }
  return [...out];
}

@Injectable()
export class CandidateService {
  constructor(private readonly prisma: PrismaService) {}

  /** Candidates for one mention. Opens its own transaction unless `tx` is given. */
  async forMention(ownerId: string, mention: CandidateMention, tx?: Prisma.TransactionClient): Promise<RawCandidate[]> {
    if (tx) return this.run(tx, ownerId, mention);
    return this.prisma.$transaction((t) => this.run(t, ownerId, mention));
  }

  private async run(db: Db, ownerId: string, mention: CandidateMention): Promise<RawCandidate[]> {
    const names = normalizedNames(mention.label, mention.aliases);
    const byId = new Map<string, Omit<RawCandidate, 'label' | 'type'>>();
    const touch = (id: string) => {
      let row = byId.get(id);
      if (!row) {
        row = { entityId: id, aliasExact: false, trigram: null, cosine: null };
        byId.set(id, row);
      }
      return row;
    };

    // --- A: alias / label exact -------------------------------------------
    if (names.length > 0) {
      const exact = await db.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT e.id::text AS id
          FROM kg_entities e
          JOIN kg_entity_aliases a ON a.entity_id = e.id
         WHERE e.owner_id = ${ownerId}::uuid
           AND e.type = ${mention.type}
           AND e.review_status IN ('accepted', 'edited')
           AND e.merged_into_id IS NULL
           AND a.normalized = ANY(${names}::text[])`;
      for (const r of exact) touch(r.id).aliasExact = true;
    }

    // --- B: trigram --------------------------------------------------------
    const rawLabel = mention.label.trim();
    const normLabel = names[0] ?? rawLabel.toLowerCase();
    if (rawLabel.length > 0) {
      await db.$queryRaw`SELECT set_config('pg_trgm.similarity_threshold', ${String(TRIGRAM_THRESHOLD)}, true)`;
      const fuzzy = await db.$queryRaw<Array<{ id: string; sim: number }>>`
        SELECT e.id::text AS id,
               GREATEST(similarity(e.label, ${rawLabel}),
                        COALESCE(MAX(similarity(a.normalized, ${normLabel})), 0))::float8 AS sim
          FROM kg_entities e
          LEFT JOIN kg_entity_aliases a ON a.entity_id = e.id
         WHERE e.owner_id = ${ownerId}::uuid
           AND e.type = ${mention.type}
           AND e.review_status IN ('accepted', 'edited')
           AND e.merged_into_id IS NULL
           AND (e.label % ${rawLabel} OR a.normalized % ${normLabel})
         GROUP BY e.id
         ORDER BY sim DESC, e.id
         LIMIT ${TRIGRAM_LIMIT}`;
      for (const r of fuzzy) {
        const sim = Number(r.sim);
        if (sim >= TRIGRAM_THRESHOLD) touch(r.id).trigram = sim;
      }
    }

    // --- C: vector kNN -----------------------------------------------------
    if (mention.vector && mention.vector.values.length > 0) {
      const literal = vectorLiteral(mention.vector.values);
      const near = await db.$queryRaw<Array<{ id: string; sim: number }>>`
        SELECT e.id::text AS id, (1 - (e.embedding <=> ${literal}::vector))::float8 AS sim
          FROM kg_entities e
         WHERE e.owner_id = ${ownerId}::uuid
           AND e.type = ${mention.type}
           AND e.review_status IN ('accepted', 'edited')
           AND e.merged_into_id IS NULL
           AND e.embedding IS NOT NULL
           AND e.embedding_model = ${mention.vector.model}
         ORDER BY e.embedding <=> ${literal}::vector
         LIMIT ${VECTOR_K}`;
      for (const r of near) touch(r.id).cosine = Number(r.sim);
    } else if (mention.vectorOfEntityId) {
      // The stored vector stays in the database: no 1536-float round trip per entity.
      const near = await db.$queryRaw<Array<{ id: string; sim: number }>>`
        WITH src AS (
          SELECT embedding, embedding_model FROM kg_entities
           WHERE id = ${mention.vectorOfEntityId}::uuid AND owner_id = ${ownerId}::uuid AND embedding IS NOT NULL
        )
        SELECT e.id::text AS id, (1 - (e.embedding <=> src.embedding))::float8 AS sim
          FROM kg_entities e, src
         WHERE e.owner_id = ${ownerId}::uuid
           AND e.type = ${mention.type}
           AND e.review_status IN ('accepted', 'edited')
           AND e.merged_into_id IS NULL
           AND e.embedding IS NOT NULL
           AND e.embedding_model = src.embedding_model
           AND e.id <> ${mention.vectorOfEntityId}::uuid
         ORDER BY e.embedding <=> src.embedding
         LIMIT ${VECTOR_K}`;
      for (const r of near) touch(r.id).cosine = Number(r.sim);
    }

    // --- exclusions --------------------------------------------------------
    const excluded = new Set<string>([...(mention.excludeCandidateIds ?? []), ...(mention.excludeIds ?? [])]);
    const excludeIds = [...new Set(mention.excludeIds ?? [])];
    if (excludeIds.length > 0 && byId.size > 0) {
      const pairs = await db.kgDistinctPair.findMany({
        where: { ownerId, OR: [{ aId: { in: excludeIds } }, { bId: { in: excludeIds } }] },
        select: { aId: true, bId: true },
      });
      for (const p of pairs) {
        excluded.add(p.aId);
        excluded.add(p.bId);
      }
    }
    for (const id of excluded) byId.delete(id);
    if (byId.size === 0) return [];

    const rows = await db.kgEntity.findMany({
      where: { id: { in: [...byId.keys()] }, ownerId },
      select: { id: true, label: true, type: true },
    });
    return rows
      .map((row) => ({ ...byId.get(row.id)!, label: row.label, type: row.type }))
      .sort((a, b) => a.entityId.localeCompare(b.entityId));
  }
}
