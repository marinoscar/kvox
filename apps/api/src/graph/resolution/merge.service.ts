// =============================================================================
// MergeService (#364, epic #346; docs/specs/ontology.md §5.5, §7, §10, §12)
// =============================================================================
//
// A merge TOMBSTONES the redundant entity (`review_status: 'merged'`,
// `merged_into_id` set) and re-points everything that named it onto the
// survivor, in ONE transaction — and records every single change in
// `kg_merges.reversal`, so `reverse` restores exactly what the merge undid,
// row by row, not an approximation of it.
//
//   merge   lock both rows FOR UPDATE → re-point relations (from/to), items
//           (subject/owner_person/counterparty/meeting), entity evidence,
//           mentions and aliases (an alias the survivor already has, by its
//           normalized form, stays on the tombstone) → add the merged label as
//           an alias → collapse relations that became duplicates (same type,
//           endpoints and `valid`: evidence moved onto the kept row, the
//           duplicate `merged`) and items that became duplicates (same kind,
//           statement hash and subject — `kg_items_live_statement_uniq_idx`
//           would otherwise refuse the re-point) → self-loops `merged` →
//           distinct pairs rewritten onto the survivor → the tombstone.
//   reverse the inverse, skipping (and reporting) rows deleted or moved since;
//           409 `revert_conflict` when the survivor has itself been merged
//           since (reverse that merge first).
//
// THE CURATED-SURVIVOR RULE (§7): in an automatic path (a resolution
// proposal's decision), when exactly one side is curated (`accepted`/`edited`)
// that side survives, unconditionally. A manual merge is a person's decision
// and keeps the survivor they named.
//
// The `tx` convention: each method opens its own `$transaction` when `tx` is
// omitted and joins the caller's when given (#366's commit and revert). The
// audit row and the follow-up enqueues run only after a transaction THIS
// service opened has committed; a caller passing `tx` calls `afterMerge` /
// `afterReverse` itself once its own transaction commits.
//
// Merges are graph writes, and the rules `GraphWriteService` exists for still
// hold: the merged label is added through `GraphWriteService.addAliases`, and
// the deferred no-orphans trigger checks the final state at COMMIT — every
// evidence row moves together with (never ahead of) its subject's status.
//
// ⚠ Ids and counts only in logs and audit meta — never a label.
// =============================================================================

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type KgAliasSource } from '@prisma/client';

import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GRAPH_NOT_FOUND_MESSAGES } from '../access/graph-access.service';
import { GRAPH_CONFLICT_REASONS } from '../graph-conflict-reasons';
import { GraphEntitiesService } from '../graph-entities.service';
import { KG_RESOLVE_JOB_TYPE, KG_SUBJECT_ENTITY, KG_SUBJECT_USER } from '../job-types';
import { GraphValidationError } from '../write/graph-write.errors';
import { GraphWriteService } from '../write/graph-write.service';
import { orderPair } from './distinct-pair.service';

type Tx = Prisma.TransactionClient;

export type MergeSource = 'manual' | 'resolution_proposal';
export type RelationField = 'from_id' | 'to_id';
export type ItemField = 'subject_id' | 'owner_person_id' | 'counterparty_id' | 'meeting_id';
export type SkippedKind = 'relation' | 'item' | 'evidence' | 'mention' | 'alias';

export const GRAPH_ENTITY_MERGED_ACTION = 'graph.entity_merged';
export const GRAPH_MERGE_REVERSED_ACTION = 'graph.merge_reversed';
export const MERGE_TYPE_MISMATCH_REASON = 'type_mismatch';

const CURATED = new Set(['accepted', 'edited']);
const MERGEABLE = new Set(['accepted', 'edited', 'unreviewed']);
const ITEM_FIELDS: readonly ItemField[] = ['subject_id', 'owner_person_id', 'counterparty_id', 'meeting_id'];

/** `kg_merges.reversal` — every change a merge made. */
export interface MergeReversal {
  mergedSnapshot: { review_status: string; label: string; props: unknown; merged_into_id: null };
  repointed: {
    relations: Array<{ id: string; field: RelationField }>;
    items: Array<{ id: string; field: ItemField }>;
    evidence: string[];
    mentions: string[];
    aliases: string[];
  };
  aliasAdded: string | null;
  collapsed: Array<{ relationId: string; keptId: string; movedEvidence: string[]; previousStatus: string }>;
  /** Additive to the issue's shape: item duplicates collapsed by the live-statement index. */
  collapsedItems: Array<{ itemId: string; keptId: string; movedEvidence: string[]; previousStatus: string }>;
  selfLoops: Array<{ relationId: string; previousStatus: string }>;
  /** `afterExisted`: the rewritten pair was already recorded — a reverse must not delete it. */
  distinctPairsRewritten: Array<{ before: [string, string]; after: [string, string] | null; afterExisted?: boolean }>;
}

export interface MergeInput {
  ownerId: string;
  mergedId: string;
  survivorId: string;
  actorId: string | null;
  source: MergeSource;
}

export interface MergeResult {
  merge: { id: string; survivorId: string; mergedId: string; createdAt: string };
  survivor: { id: string; type: string; label: string; aliasCount: number };
}

export interface ReverseInput {
  ownerId: string;
  mergeId: string;
  actorId: string | null;
}

export interface ReverseResult {
  merge: { id: string; survivorId: string; mergedId: string; reversedAt: string };
  restored: { id: string; type: string; label: string };
  skipped: Array<{ kind: SkippedKind; id: string; why: 'deleted_since' | 'moved_since' }>;
}

interface LockedEntity {
  id: string;
  type: string;
  label: string;
  props: unknown;
  review_status: string;
  merged_into_id: string | null;
}

/**
 * PURE. Which side survives. A manual merge keeps the requested survivor; an
 * automatic one keeps the curated side when exactly one side is curated.
 */
export function chooseSurvivor(
  requested: { survivorId: string; mergedId: string },
  statuses: Readonly<Record<string, string>>,
  source: MergeSource,
): { survivorId: string; mergedId: string } {
  if (source === 'manual') return requested;
  const survivorCurated = CURATED.has(statuses[requested.survivorId]);
  const mergedCurated = CURATED.has(statuses[requested.mergedId]);
  if (mergedCurated && !survivorCurated) return { survivorId: requested.mergedId, mergedId: requested.survivorId };
  return requested;
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

@Injectable()
export class MergeService {
  private readonly logger = new Logger(MergeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly write: GraphWriteService,
    private readonly jobs: JobsService,
    private readonly registry: JobHandlerRegistry,
    private readonly entities: GraphEntitiesService,
  ) {}

  // ===========================================================================
  // merge
  // ===========================================================================

  async merge(input: MergeInput, tx?: Tx): Promise<MergeResult> {
    if (input.mergedId.toLowerCase() === input.survivorId.toLowerCase()) {
      throw new BadRequestException('An entity cannot be merged into itself.');
    }
    if (tx) return this.mergeIn(tx, input);
    const result = await this.prisma.$transaction((t) => this.mergeIn(t, input), { timeout: 60_000 });
    await this.afterMerge(input, result);
    return result;
  }

  /** Audit + follow-up enqueues, after the merge's transaction committed. */
  async afterMerge(input: Pick<MergeInput, 'ownerId' | 'actorId' | 'source'>, result: MergeResult): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: input.actorId,
        action: GRAPH_ENTITY_MERGED_ACTION,
        targetType: KG_SUBJECT_ENTITY,
        targetId: result.merge.survivorId,
        meta: { mergeId: result.merge.id, mergedId: result.merge.mergedId, source: input.source },
      },
    });
    await this.entities.enqueueFollowUps(input.ownerId, result.merge.survivorId);
  }

  private async mergeIn(t: Tx, input: MergeInput): Promise<MergeResult> {
    const { ownerId } = input;
    const locked = await this.lock(t, ownerId, [input.mergedId, input.survivorId]);
    const a = locked.get(input.mergedId.toLowerCase());
    const b = locked.get(input.survivorId.toLowerCase());
    const usable = (e: LockedEntity | undefined) => e && e.merged_into_id === null && MERGEABLE.has(e.review_status);
    if (!usable(a) || !usable(b)) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);
    if (a!.type !== b!.type) {
      throw new BadRequestException({
        message: `Only entities of the same type can be merged (${a!.type} vs ${b!.type}).`,
        details: { reason: MERGE_TYPE_MISMATCH_REASON },
      });
    }
    const { survivorId: s, mergedId: m } = chooseSurvivor(
      { survivorId: b!.id, mergedId: a!.id },
      { [a!.id]: a!.review_status, [b!.id]: b!.review_status },
      input.source,
    );
    const merged = locked.get(m)!;
    const survivor = locked.get(s)!;

    const reversal: MergeReversal = {
      mergedSnapshot: { review_status: merged.review_status, label: merged.label, props: merged.props, merged_into_id: null },
      repointed: { relations: [], items: [], evidence: [], mentions: [], aliases: [] },
      aliasAdded: null,
      collapsed: [],
      collapsedItems: [],
      selfLoops: [],
      distinctPairsRewritten: [],
    };

    // --- relations ---------------------------------------------------------
    const fromRows = await t.$queryRaw<Array<{ id: string }>>`
      UPDATE kg_relations SET from_id = ${s}::uuid, updated_at = now()
       WHERE owner_id = ${ownerId}::uuid AND from_id = ${m}::uuid RETURNING id::text AS id`;
    const toRows = await t.$queryRaw<Array<{ id: string }>>`
      UPDATE kg_relations SET to_id = ${s}::uuid, updated_at = now()
       WHERE owner_id = ${ownerId}::uuid AND to_id = ${m}::uuid RETURNING id::text AS id`;
    reversal.repointed.relations.push(
      ...fromRows.map((r) => ({ id: r.id, field: 'from_id' as const })),
      ...toRows.map((r) => ({ id: r.id, field: 'to_id' as const })),
    );
    const touchedRelations = [...new Set([...ids(fromRows), ...ids(toRows)])];

    // --- items: collapse live duplicates BEFORE the subject re-point --------
    const itemDupes = await t.$queryRaw<Array<{ id: string; kept_id: string; status: string }>>`
      SELECT DISTINCT ON (i.id) i.id::text AS id, k.id::text AS kept_id, i.review_status::text AS status
        FROM kg_items i
        JOIN kg_items k ON k.owner_id = i.owner_id AND k.kind = i.kind AND k.statement_hash = i.statement_hash
                       AND k.subject_id = ${s}::uuid AND k.review_status IN ('accepted', 'edited')
       WHERE i.owner_id = ${ownerId}::uuid AND i.subject_id = ${m}::uuid
         AND i.review_status IN ('accepted', 'edited')
       ORDER BY i.id, k.created_at, k.id`;
    for (const d of itemDupes) {
      const moved = await t.$queryRaw<Array<{ id: string }>>`
        UPDATE kg_evidence SET subject_id = ${d.kept_id}::uuid
         WHERE subject_kind = 'item' AND subject_id = ${d.id}::uuid RETURNING id::text AS id`;
      await t.$executeRaw`UPDATE kg_items SET review_status = 'merged', updated_at = now() WHERE id = ${d.id}::uuid`;
      reversal.collapsedItems.push({ itemId: d.id, keptId: d.kept_id, movedEvidence: ids(moved), previousStatus: d.status });
    }
    for (const field of ITEM_FIELDS) {
      const rows = await this.repointItemField(t, ownerId, field, m, s);
      reversal.repointed.items.push(...rows.map((id) => ({ id, field })));
    }

    // --- evidence, mentions, aliases ----------------------------------------
    reversal.repointed.evidence = ids(
      await t.$queryRaw<Array<{ id: string }>>`
        UPDATE kg_evidence SET subject_id = ${s}::uuid
         WHERE owner_id = ${ownerId}::uuid AND subject_kind = 'entity' AND subject_id = ${m}::uuid
        RETURNING id::text AS id`,
    );
    reversal.repointed.mentions = ids(
      await t.$queryRaw<Array<{ id: string }>>`
        UPDATE kg_mentions SET entity_id = ${s}::uuid
         WHERE owner_id = ${ownerId}::uuid AND entity_id = ${m}::uuid RETURNING id::text AS id`,
    );
    reversal.repointed.aliases = ids(
      await t.$queryRaw<Array<{ id: string }>>`
        UPDATE kg_entity_aliases a SET entity_id = ${s}::uuid
         WHERE a.entity_id = ${m}::uuid
           AND NOT EXISTS (SELECT 1 FROM kg_entity_aliases b WHERE b.entity_id = ${s}::uuid AND b.normalized = a.normalized)
        RETURNING a.id::text AS id`,
    );
    const aliasSource: KgAliasSource = input.source === 'manual' ? 'user' : 'extraction';
    try {
      const added = await this.write.addAliases(t, ownerId, s, [{ alias: merged.label, source: aliasSource }]);
      reversal.aliasAdded = added[0]?.id ?? null;
    } catch (error) {
      // A label with no letters or digits has no alias form; nothing to add.
      if (!(error instanceof GraphValidationError)) throw error;
    }

    // --- self-loops, then duplicate relations --------------------------------
    if (touchedRelations.length > 0) {
      const loops = await t.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id::text AS id, review_status::text AS status FROM kg_relations
         WHERE id = ANY(${touchedRelations}::uuid[]) AND from_id = to_id AND review_status <> 'merged'
         ORDER BY id`;
      for (const loop of loops) {
        await t.$executeRaw`UPDATE kg_relations SET review_status = 'merged', updated_at = now() WHERE id = ${loop.id}::uuid`;
        reversal.selfLoops.push({ relationId: loop.id, previousStatus: loop.status });
      }
      for (const relationId of [...touchedRelations].sort()) {
        const [dupe] = await t.$queryRaw<Array<{ kept_id: string; status: string }>>`
          SELECT k.id::text AS kept_id, r.review_status::text AS status
            FROM kg_relations r
            JOIN kg_relations k ON k.owner_id = r.owner_id AND k.type = r.type AND k.id <> r.id
                               AND k.from_id IS NOT DISTINCT FROM r.from_id
                               AND k.from_speaker_id IS NOT DISTINCT FROM r.from_speaker_id
                               AND k.to_id = r.to_id
                               AND k.valid IS NOT DISTINCT FROM r.valid
                               AND k.review_status IN ('accepted', 'edited')
           WHERE r.id = ${relationId}::uuid AND r.review_status IN ('accepted', 'edited')
           ORDER BY (k.id = ANY(${touchedRelations}::uuid[])), k.created_at, k.id
           LIMIT 1`;
        if (!dupe) continue;
        const moved = await t.$queryRaw<Array<{ id: string }>>`
          UPDATE kg_evidence SET subject_id = ${dupe.kept_id}::uuid
           WHERE subject_kind = 'relation' AND subject_id = ${relationId}::uuid RETURNING id::text AS id`;
        await t.$executeRaw`UPDATE kg_relations SET review_status = 'merged', updated_at = now() WHERE id = ${relationId}::uuid`;
        reversal.collapsed.push({ relationId, keptId: dupe.kept_id, movedEvidence: ids(moved), previousStatus: dupe.status });
      }
    }

    // --- distinct pairs ------------------------------------------------------
    const pairs = await t.kgDistinctPair.findMany({
      where: { ownerId, OR: [{ aId: m }, { bId: m }] },
      select: { aId: true, bId: true },
      orderBy: [{ aId: 'asc' }, { bId: 'asc' }],
    });
    for (const p of pairs) {
      const other = p.aId === m ? p.bId : p.aId;
      await t.kgDistinctPair.delete({ where: { ownerId_aId_bId: { ownerId, aId: p.aId, bId: p.bId } } });
      if (other === s) {
        reversal.distinctPairsRewritten.push({ before: [p.aId, p.bId], after: null });
        continue;
      }
      const after = orderPair(s, other);
      const inserted = await t.$queryRaw<Array<{ a_id: string }>>`
        INSERT INTO kg_distinct_pairs (owner_id, a_id, b_id, created_at)
        VALUES (${ownerId}::uuid, ${after[0]}::uuid, ${after[1]}::uuid, now())
        ON CONFLICT DO NOTHING RETURNING a_id::text`;
      reversal.distinctPairsRewritten.push({ before: [p.aId, p.bId], after, afterExisted: inserted.length === 0 });
    }

    // --- the tombstone -------------------------------------------------------
    await t.$executeRaw`
      UPDATE kg_entities SET review_status = 'merged', merged_into_id = ${s}::uuid, updated_at = now()
       WHERE id = ${m}::uuid`;

    const row = await t.kgMerge.create({
      data: { ownerId, survivorId: s, mergedId: m, reversal: reversal as unknown as Prisma.InputJsonValue },
    });
    const aliasCount = await t.kgEntityAlias.count({ where: { entityId: s } });

    this.logger.log(
      `Merged entity ${m} into ${s} (merge ${row.id}, source=${input.source}, relations=${reversal.repointed.relations.length}, ` +
        `items=${reversal.repointed.items.length}, evidence=${reversal.repointed.evidence.length}, collapsed=${reversal.collapsed.length})`,
    );
    return {
      merge: { id: row.id, survivorId: s, mergedId: m, createdAt: row.createdAt.toISOString() },
      survivor: { id: s, type: survivor.type, label: survivor.label, aliasCount },
    };
  }

  // ===========================================================================
  // reverse
  // ===========================================================================

  async reverse(input: ReverseInput, tx?: Tx): Promise<ReverseResult> {
    if (tx) return this.reverseIn(tx, input);
    const result = await this.prisma.$transaction((t) => this.reverseIn(t, input), { timeout: 60_000 });
    await this.afterReverse(input, result);
    return result;
  }

  /** Audit + follow-up enqueues, after the reverse's transaction committed. */
  async afterReverse(input: Pick<ReverseInput, 'ownerId' | 'actorId'>, result: ReverseResult): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: input.actorId,
        action: GRAPH_MERGE_REVERSED_ACTION,
        targetType: KG_SUBJECT_ENTITY,
        targetId: result.merge.mergedId,
        meta: { mergeId: result.merge.id, skipped: result.skipped.length },
      },
    });
    // kg.embed (+ kg.entity_digest, guarded) for both sides, then a re-check
    // of the restored entity against the graph.
    await this.entities.enqueueFollowUps(input.ownerId, result.merge.survivorId);
    await this.entities.enqueueFollowUps(input.ownerId, result.merge.mergedId);
    try {
      if (this.registry.get(KG_RESOLVE_JOB_TYPE)) {
        await this.jobs.enqueue({
          type: KG_RESOLVE_JOB_TYPE,
          reason: 'rerun',
          subjectType: KG_SUBJECT_USER,
          subjectId: input.ownerId,
          payload: { userId: input.ownerId, scope: 'entity', entityId: result.merge.mergedId, reason: 'merge_reversed' },
        });
      }
    } catch (err) {
      this.logger.warn(`Could not enqueue ${KG_RESOLVE_JOB_TYPE} after reversing merge ${result.merge.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async reverseIn(t: Tx, input: ReverseInput): Promise<ReverseResult> {
    const notFound = () => new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.merge);
    const [mergeRow] = await t.$queryRaw<Array<{ id: string; survivor_id: string; merged_id: string; reversal: MergeReversal; reversed_at: Date | null }>>`
      SELECT id::text AS id, survivor_id::text AS survivor_id, merged_id::text AS merged_id, reversal, reversed_at
        FROM kg_merges WHERE id = ${input.mergeId}::uuid AND owner_id = ${input.ownerId}::uuid FOR UPDATE`;
    if (!mergeRow || mergeRow.reversed_at !== null) throw notFound();
    const s = mergeRow.survivor_id;
    const m = mergeRow.merged_id;
    const locked = await this.lock(t, input.ownerId, [s, m]);
    const survivor = locked.get(s);
    const merged = locked.get(m);
    if (!survivor || !merged) throw notFound();
    if (survivor.merged_into_id !== null || survivor.review_status === 'merged') {
      throw new ConflictException({
        message: 'The surviving entity has since been merged into another one. Reverse that merge first.',
        details: {
          reason: GRAPH_CONFLICT_REASONS.REVERT_CONFLICT,
          conflicts: [{ entity: 'survivor', id: s, mergedInto: survivor.merged_into_id }],
        },
      });
    }

    const r = mergeRow.reversal;
    const skipped: ReverseResult['skipped'] = [];

    // --- relations and items back to the merged entity -----------------------
    for (const rel of r.repointed.relations) {
      const n = rel.field === 'from_id'
        ? await t.$executeRaw`UPDATE kg_relations SET from_id = ${m}::uuid, updated_at = now() WHERE id = ${rel.id}::uuid AND from_id = ${s}::uuid`
        : await t.$executeRaw`UPDATE kg_relations SET to_id = ${m}::uuid, updated_at = now() WHERE id = ${rel.id}::uuid AND to_id = ${s}::uuid`;
      if (n === 0) skipped.push({ kind: 'relation', id: rel.id, why: (await t.kgRelation.findUnique({ where: { id: rel.id }, select: { id: true } })) ? 'moved_since' : 'deleted_since' });
    }
    for (const item of r.repointed.items) {
      const n = await this.restoreItemField(t, item.id, item.field, m, s);
      if (n === 0) skipped.push({ kind: 'item', id: item.id, why: (await t.kgItem.findUnique({ where: { id: item.id }, select: { id: true } })) ? 'moved_since' : 'deleted_since' });
    }

    // --- collapsed rows and self-loops: evidence back, then status back ------
    for (const c of r.collapsed) {
      if (c.movedEvidence.length > 0) {
        await t.$executeRaw`UPDATE kg_evidence SET subject_id = ${c.relationId}::uuid
                             WHERE id = ANY(${c.movedEvidence}::uuid[]) AND subject_kind = 'relation' AND subject_id = ${c.keptId}::uuid`;
      }
      await t.$executeRaw`UPDATE kg_relations SET review_status = ${c.previousStatus}::kg_review_status, updated_at = now()
                           WHERE id = ${c.relationId}::uuid AND review_status = 'merged'`;
    }
    for (const c of r.collapsedItems ?? []) {
      if (c.movedEvidence.length > 0) {
        await t.$executeRaw`UPDATE kg_evidence SET subject_id = ${c.itemId}::uuid
                             WHERE id = ANY(${c.movedEvidence}::uuid[]) AND subject_kind = 'item' AND subject_id = ${c.keptId}::uuid`;
      }
      await t.$executeRaw`UPDATE kg_items SET review_status = ${c.previousStatus}::kg_review_status, updated_at = now()
                           WHERE id = ${c.itemId}::uuid AND review_status = 'merged'`;
    }
    for (const loop of r.selfLoops) {
      await t.$executeRaw`UPDATE kg_relations SET review_status = ${loop.previousStatus}::kg_review_status, updated_at = now()
                           WHERE id = ${loop.relationId}::uuid AND review_status = 'merged'`;
    }

    // --- evidence, mentions, aliases -----------------------------------------
    await this.restoreSet(t, 'evidence', r.repointed.evidence, skipped, (idsToMove) =>
      t.$queryRaw<Array<{ id: string }>>`UPDATE kg_evidence SET subject_id = ${m}::uuid
        WHERE id = ANY(${idsToMove}::uuid[]) AND subject_kind = 'entity' AND subject_id = ${s}::uuid RETURNING id::text AS id`,
      async (missing) => ids(await t.kgEvidence.findMany({ where: { id: { in: missing } }, select: { id: true } })),
    );
    await this.restoreSet(t, 'mention', r.repointed.mentions, skipped, (idsToMove) =>
      t.$queryRaw<Array<{ id: string }>>`UPDATE kg_mentions SET entity_id = ${m}::uuid
        WHERE id = ANY(${idsToMove}::uuid[]) AND entity_id = ${s}::uuid RETURNING id::text AS id`,
      async (missing) => ids(await t.kgMention.findMany({ where: { id: { in: missing } }, select: { id: true } })),
    );
    await this.restoreSet(t, 'alias', r.repointed.aliases, skipped, (idsToMove) =>
      t.$queryRaw<Array<{ id: string }>>`UPDATE kg_entity_aliases SET entity_id = ${m}::uuid
        WHERE id = ANY(${idsToMove}::uuid[]) AND entity_id = ${s}::uuid RETURNING id::text AS id`,
      async (missing) => ids(await t.kgEntityAlias.findMany({ where: { id: { in: missing } }, select: { id: true } })),
    );
    if (r.aliasAdded) {
      await t.kgEntityAlias.deleteMany({ where: { id: r.aliasAdded, entityId: s } });
    }

    // --- distinct pairs --------------------------------------------------------
    for (const rw of r.distinctPairsRewritten) {
      if (rw.after && !rw.afterExisted) {
        await t.kgDistinctPair.deleteMany({ where: { ownerId: input.ownerId, aId: rw.after[0], bId: rw.after[1] } });
      }
      await t.$executeRaw`
        INSERT INTO kg_distinct_pairs (owner_id, a_id, b_id, created_at)
        SELECT ${input.ownerId}::uuid, ${rw.before[0]}::uuid, ${rw.before[1]}::uuid, now()
         WHERE (SELECT count(*) FROM kg_entities WHERE id IN (${rw.before[0]}::uuid, ${rw.before[1]}::uuid)) = 2
        ON CONFLICT DO NOTHING`;
    }

    // --- the entity itself -------------------------------------------------------
    const snap = r.mergedSnapshot;
    if (CURATED.has(snap.review_status)) {
      const evidenceLeft = await t.kgEvidence.count({ where: { subjectKind: 'entity', subjectId: m } });
      if (evidenceLeft === 0) {
        throw new ConflictException({
          message: 'None of the merged entity\'s citations are left to give back to it, so the merge cannot be reversed.',
          details: { reason: GRAPH_CONFLICT_REASONS.REVERT_CONFLICT, conflicts: [{ entity: 'merged', id: m, mergedInto: s }] },
        });
      }
    }
    await t.$executeRaw`
      UPDATE kg_entities
         SET review_status = ${snap.review_status}::kg_review_status,
             merged_into_id = NULL,
             label = ${snap.label},
             props = ${JSON.stringify(snap.props ?? {})}::jsonb,
             updated_at = now()
       WHERE id = ${m}::uuid`;
    const [{ reversed_at }] = await t.$queryRaw<Array<{ reversed_at: Date }>>`
      UPDATE kg_merges SET reversed_at = now() WHERE id = ${mergeRow.id}::uuid RETURNING reversed_at`;

    this.logger.log(`Reversed merge ${mergeRow.id} (restored ${m} from ${s}, skipped=${skipped.length})`);
    return {
      merge: { id: mergeRow.id, survivorId: s, mergedId: m, reversedAt: reversed_at.toISOString() },
      restored: { id: m, type: merged.type, label: snap.label },
      skipped,
    };
  }

  // ===========================================================================
  // private
  // ===========================================================================

  private async lock(t: Tx, ownerId: string, entityIds: string[]): Promise<Map<string, LockedEntity>> {
    const rows = await t.$queryRaw<LockedEntity[]>`
      SELECT id::text AS id, type, label, props, review_status::text AS review_status, merged_into_id::text AS merged_into_id
        FROM kg_entities
       WHERE owner_id = ${ownerId}::uuid AND id = ANY(${entityIds.map((i) => i.toLowerCase())}::uuid[])
       ORDER BY id
         FOR UPDATE`;
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async repointItemField(t: Tx, ownerId: string, field: ItemField, m: string, s: string): Promise<string[]> {
    let rows: Array<{ id: string }>;
    switch (field) {
      case 'subject_id':
        rows = await t.$queryRaw<Array<{ id: string }>>`UPDATE kg_items SET subject_id = ${s}::uuid, updated_at = now() WHERE owner_id = ${ownerId}::uuid AND subject_id = ${m}::uuid RETURNING id::text AS id`;
        break;
      case 'owner_person_id':
        rows = await t.$queryRaw<Array<{ id: string }>>`UPDATE kg_items SET owner_person_id = ${s}::uuid, updated_at = now() WHERE owner_id = ${ownerId}::uuid AND owner_person_id = ${m}::uuid RETURNING id::text AS id`;
        break;
      case 'counterparty_id':
        rows = await t.$queryRaw<Array<{ id: string }>>`UPDATE kg_items SET counterparty_id = ${s}::uuid, updated_at = now() WHERE owner_id = ${ownerId}::uuid AND counterparty_id = ${m}::uuid RETURNING id::text AS id`;
        break;
      case 'meeting_id':
        rows = await t.$queryRaw<Array<{ id: string }>>`UPDATE kg_items SET meeting_id = ${s}::uuid, updated_at = now() WHERE owner_id = ${ownerId}::uuid AND meeting_id = ${m}::uuid RETURNING id::text AS id`;
        break;
    }
    return ids(rows);
  }

  private restoreItemField(t: Tx, id: string, field: ItemField, m: string, s: string): Promise<number> {
    switch (field) {
      case 'subject_id':
        return t.$executeRaw`UPDATE kg_items SET subject_id = ${m}::uuid, updated_at = now() WHERE id = ${id}::uuid AND subject_id = ${s}::uuid`;
      case 'owner_person_id':
        return t.$executeRaw`UPDATE kg_items SET owner_person_id = ${m}::uuid, updated_at = now() WHERE id = ${id}::uuid AND owner_person_id = ${s}::uuid`;
      case 'counterparty_id':
        return t.$executeRaw`UPDATE kg_items SET counterparty_id = ${m}::uuid, updated_at = now() WHERE id = ${id}::uuid AND counterparty_id = ${s}::uuid`;
      case 'meeting_id':
        return t.$executeRaw`UPDATE kg_items SET meeting_id = ${m}::uuid, updated_at = now() WHERE id = ${id}::uuid AND meeting_id = ${s}::uuid`;
    }
  }

  /** Move a set back in one statement; report each row that did not move. */
  private async restoreSet(
    _t: Tx,
    kind: SkippedKind,
    all: readonly string[],
    skipped: ReverseResult['skipped'],
    move: (ids: string[]) => Promise<Array<{ id: string }>>,
    existing: (ids: string[]) => Promise<string[]>,
  ): Promise<void> {
    if (all.length === 0) return;
    const moved = new Set(ids(await move([...all])));
    const missing = all.filter((id) => !moved.has(id));
    if (missing.length === 0) return;
    const stillThere = new Set(await existing(missing));
    for (const id of missing) skipped.push({ kind, id, why: stillThere.has(id) ? 'moved_since' : 'deleted_since' });
  }
}
