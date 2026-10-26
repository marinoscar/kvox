// =============================================================================
// DuplicatesService (issue #766)
// =============================================================================
//
// "Possible duplicates": pairs of the caller's own live entities that probably
// are one thing.
//
//   list()  GET  /api/graph/duplicates      two sources, merged and de-duplicated
//     name_pass            a fast pass over the caller's live entities (accepted/
//                          edited, not merged: the reviewed graph the reads show),
//                          same type only, `kg_distinct_pairs` excluded:
//                            - SQL `pg_trgm` self-join, `label % label` at
//                              `SIMILAR_NAME_THRESHOLD` (uses `kg_entities_label_trgm_idx`),
//                              at most `TRIGRAM_PAIR_LIMIT` pairs;
//                            - TS name signals (`duplicate-names.ts`: containment,
//                              initials, shared name) over the `NAME_PASS_MAX_ENTITIES`
//                              most recently updated entities, through inverted indexes
//                              (never all-pairs).
//     resolution_proposal  items of the caller's open (draft) `resolution`
//                          proposals that still suggest a merge.
//   scan()  POST /api/graph/duplicates/scan queue `kg.resolve` (reason `manual`).
//
// Nothing here writes the graph: a pair is a suggestion; merging is
// `POST /api/graph/entities/:id/merge`. Everything is the caller's own, so
// there is no id to answer 404 about. The scan spends the caller's own AI key.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';
import type {
  DuplicatePair,
  DuplicatesScanResponse,
  ListDuplicatesQuery,
  ListDuplicatesResponse,
} from '@marinoscar/kvox-contract/graph';

import { aiProviderThrottleKey } from '../../core/index.js';
import { GraphAiRunResolver, graphDisabledConflict, normalizeAlias, KG_SUBJECT_USER, KG_RESOLVE_JOB_TYPE } from '../../graph/index.js';
import type { GraphActor, KvoxGraphDb } from '../../graph/index.js';
import { KVOX_JOBS, KVOX_PRISMA, type KvoxJobsPort } from '../../ports/index.js';
import {
  NAME_PASS_MAX_ENTITIES,
  SIMILAR_NAME_THRESHOLD,
  duplicateScore,
  findNamePairs,
  pairKey,
  type NameReason,
} from './duplicate-names.js';

export const TRIGRAM_PAIR_LIMIT = 200;
const LIVE = ['accepted', 'edited'] as const;

type Reason = NameReason | 'resolution_proposal';
interface Found {
  aId: string;
  bId: string;
  reasons: Set<Reason>;
  trigram: number | null;
  proposalItemId?: string;
  proposalScore?: number;
}

/**
 * DuplicatesService: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class DuplicatesService {
  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    private readonly resolver: GraphAiRunResolver,
  ) {}

  async list(user: GraphActor, query: ListDuplicatesQuery): Promise<ListDuplicatesResponse> {
    const ownerId = user.id;
    const limit = query.limit ?? 50;
    const found = new Map<string, Found>();
    const touch = (a: string, b: string): Found => {
      const key = pairKey(a, b);
      let f = found.get(key);
      if (!f) {
        const [aId, bId] = key.split(':');
        f = { aId, bId, reasons: new Set(), trigram: null };
        found.set(key, f);
      }
      return f;
    };

    // --- the entities the TS pass reads, with their names ---------------------
    const scanned = await this.prisma.kgEntity.findMany({
      where: { ownerId, reviewStatus: { in: [...LIVE] }, mergedIntoId: null, ...(query.type ? { type: query.type } : {}) },
      select: { id: true, type: true, label: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: NAME_PASS_MAX_ENTITIES,
    });
    const aliases = new Map<string, AliasRow[]>();
    const loadAliases = async (ids: string[]) => {
      const missing = ids.filter((id) => !aliases.has(id));
      if (missing.length === 0) return;
      for (const id of missing) aliases.set(id, []);
      const rows = await this.prisma.kgEntityAlias.findMany({ where: { ownerId, entityId: { in: missing } }, select: { entityId: true, alias: true, normalized: true } });
      for (const r of rows) aliases.get(r.entityId)?.push({ alias: r.alias, normalized: r.normalized });
    };
    await loadAliases(scanned.map((e) => e.id));
    for (const p of findNamePairs(scanned.map((e) => ({ id: e.id, type: e.type, names: namesOf(e.label, aliases.get(e.id) ?? []) })))) {
      const f = touch(p.aId, p.bId);
      for (const r of p.reasons) f.reasons.add(r);
    }

    // --- trigram, in SQL -------------------------------------------------------
    const typeFilter = query.type ?? null;
    const trigram = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('pg_trgm.similarity_threshold', ${String(SIMILAR_NAME_THRESHOLD)}, true)`;
      return tx.$queryRaw<Array<{ a_id: string; b_id: string; sim: number }>>`
        SELECT a.id::text AS a_id, b.id::text AS b_id, similarity(a.label, b.label)::float8 AS sim
          FROM kg_entities a
          JOIN kg_entities b
            ON b.owner_id = a.owner_id AND b.type = a.type AND a.id < b.id AND a.label % b.label
         WHERE a.owner_id = ${ownerId}::uuid
           AND (${typeFilter}::text IS NULL OR a.type = ${typeFilter}::text)
           AND a.review_status IN ('accepted', 'edited') AND a.merged_into_id IS NULL
           AND b.review_status IN ('accepted', 'edited') AND b.merged_into_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM kg_distinct_pairs d
              WHERE d.owner_id = a.owner_id AND d.a_id = a.id AND d.b_id = b.id)
         ORDER BY sim DESC, a.id, b.id
         LIMIT ${TRIGRAM_PAIR_LIMIT}`;
    });
    for (const r of trigram) {
      const sim = Number(r.sim);
      if (sim < SIMILAR_NAME_THRESHOLD) continue;
      const f = touch(r.a_id, r.b_id);
      f.reasons.add('similar_name');
      f.trigram = sim;
    }

    // --- open resolution proposals ---------------------------------------------
    const items = await this.prisma.kgProposalItem.findMany({
      where: { proposal: { ownerId, kind: 'resolution', status: 'draft' }, kind: 'entity', decision: 'pending' },
      select: { id: true, payload: true, resolution: true, mergeIntoId: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    for (const item of items) {
      const existing = (item.payload as { existingEntityId?: unknown } | null)?.existingEntityId;
      const res = item.resolution as { ref?: unknown; score?: unknown; candidates?: Array<{ entityId?: unknown; score?: unknown }> } | null;
      const other = item.mergeIntoId ?? (typeof res?.ref === 'string' ? res.ref : res?.candidates?.[0]?.entityId);
      if (typeof existing !== 'string' || typeof other !== 'string' || existing.toLowerCase() === other.toLowerCase()) continue;
      const f = touch(existing, other);
      f.reasons.add('resolution_proposal');
      f.proposalItemId ??= item.id;
      const score = typeof res?.score === 'number' ? res.score : typeof res?.candidates?.[0]?.score === 'number' ? res.candidates[0].score : undefined;
      if (score !== undefined) f.proposalScore = Math.max(f.proposalScore ?? 0, Math.min(1, Math.max(0, score)));
    }
    if (found.size === 0) return { pairs: [] };

    // --- the entities behind every pair: live, same type, yours, not "distinct" ---
    const ids = [...new Set([...found.values()].flatMap((f) => [f.aId, f.bId]))];
    const [rows, distinct, mentions] = await Promise.all([
      this.prisma.kgEntity.findMany({
        where: { id: { in: ids }, ownerId, reviewStatus: { in: [...LIVE] }, mergedIntoId: null },
        select: { id: true, type: true, label: true },
      }),
      this.prisma.kgDistinctPair.findMany({ where: { ownerId, aId: { in: ids } }, select: { aId: true, bId: true } }),
      this.prisma.kgMention.groupBy({ by: ['entityId'], where: { ownerId, entityId: { in: ids } }, _count: { _all: true } }),
      loadAliases(ids),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const distinctKeys = new Set(distinct.map((d) => pairKey(d.aId, d.bId)));
    const mentionCount = new Map(mentions.map((m) => [m.entityId, m._count._all]));
    const side = (id: string) => {
      const e = byId.get(id)!;
      const own = e.label.trim().toLowerCase();
      return {
        id: e.id,
        type: e.type,
        label: e.label,
        aliases: [...new Set((aliases.get(e.id) ?? []).map((a) => a.alias).filter((a) => a.trim().toLowerCase() !== own))].sort(),
        mentionCount: mentionCount.get(e.id) ?? 0,
      };
    };

    const pairs: DuplicatePair[] = [];
    for (const [key, f] of found) {
      const a = byId.get(f.aId);
      const b = byId.get(f.bId);
      if (!a || !b || a.type !== b.type || distinctKeys.has(key)) continue;
      if (query.type && a.type !== query.type) continue;
      const reasons = [...f.reasons];
      const pair: DuplicatePair = {
        a: side(f.aId),
        b: side(f.bId),
        score: duplicateScore(reasons, Math.max(f.trigram ?? 0, f.proposalScore ?? 0)),
        reasons: orderReasons(reasons),
        source: f.proposalItemId ? 'resolution_proposal' : 'name_pass',
        ...(f.proposalItemId ? { proposalItemId: f.proposalItemId } : {}),
      };
      pairs.push(pair);
    }
    pairs.sort((x, y) => y.score - x.score || x.a.label.localeCompare(y.a.label) || x.a.id.localeCompare(y.a.id) || x.b.id.localeCompare(y.b.id));
    return { pairs: pairs.slice(0, limit) };
  }

  /** Queue a manual `kg.resolve` scan for the caller; joins one already pending or running. */
  async scan(user: GraphActor): Promise<DuplicatesScanResponse> {
    if (!(await this.resolver.graphEnabled())) throw graphDisabledConflict();
    // The job port passes the organization explicitly on every enqueue (the host binding's adapter).
    const queued = await this.jobs.enqueue({
      type: KG_RESOLVE_JOB_TYPE,
      reason: 'rerun',
      subjectType: KG_SUBJECT_USER,
      subjectId: user.id,
      payload: { userId: user.id, scope: 'all', reason: 'manual' },
      throttleKey: aiProviderThrottleKey(user.id),
    });
    return { queued: true, alreadyRunning: queued.deduplicated, jobId: queued.id };
  }
}

/** Normalized names of an entity, its label first. */
interface AliasRow {
  alias: string;
  normalized: string;
}

function namesOf(label: string, aliasRows: readonly AliasRow[]): string[] {
  const out = new Set<string>();
  try {
    out.add(normalizeAlias(label));
  } catch {
    // A label with no letters or digits has no comparable name.
  }
  for (const a of aliasRows) if (a.normalized) out.add(a.normalized);
  return [...out];
}

const REASON_ORDER: readonly Reason[] = ['alias_match', 'name_contained', 'initials', 'similar_name', 'resolution_proposal'];
function orderReasons(reasons: readonly Reason[]): Reason[] {
  return REASON_ORDER.filter((r) => reasons.includes(r));
}
