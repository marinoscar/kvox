// =============================================================================
// ProposalRevertService (#366, epic #346; docs/specs/ontology.md §19.4)
// =============================================================================
//
// Undo a commit — but never silently destroy what the owner did SINCE (§19:
// "only rows untouched since; the others are listed"). Reads the commit's own
// `commit_log`, never a blind inverse replay.
//
// A logged change is REVERTIBLE when:
//   created entity/relation/item  `updated_at ≤ committed_at + 1s`, no
//                                 citations other than this commit's, not
//                                 named by a relation/item created after the
//                                 commit, not merged (either side) since —
//                                 else kept as `edited_since` /
//                                 `evidence_since` / `referenced_since` /
//                                 `merged_since`. An entity that a KEPT row of
//                                 this same commit still names is kept too
//                                 (`referenced_since`): deleting it would
//                                 cascade the kept row away.
//   evidence, aliases, mentions,  always
//   distinct pairs
//   item changes / closings       the row still holds exactly what this commit
//                                 wrote — else `edited_since` (or
//                                 `referenced_since` when the row that
//                                 superseded it is itself kept)
//   merges                        reversed through `MergeService.reverse`
//                                 inside a SAVEPOINT; a `revert_conflict` from
//                                 it becomes `merged_since`
//
// With conflicts and `confirmPartial: false` → 409 `revert_conflict` listing
// them and the revertible count; NOTHING is written (the transaction rolls
// back). Otherwise, in one Serializable transaction: evidence first, then
// created items → relations → entities (their evidence deleted explicitly —
// evidence is polymorphic, never FK-cascaded), then item changes and closings
// restored, then aliases / mentions / distinct pairs; the proposal becomes
// `reverted`. Its items keep their decisions — a reverted proposal is a
// read-only record.
//
// ⚠ Ids and counts only in logs and audit meta.
// =============================================================================

import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { GraphAccessService } from '../access/graph-access.service';
import { GRAPH_CONFLICT_REASONS } from '../graph-conflict-reasons';
import { MergeService, type ReverseResult } from '../resolution/merge.service';
import { toGraphHttpException } from '../write/graph-write.errors';
import type { RevertKept, RevertResponse, RevertResult } from './dto/proposal.dto';
import {
  emptyCommitLog,
  isSerializationFailure,
  itemState,
  ProposalCommitService,
  type CommitLog,
  type ItemState,
} from './proposal-commit.service';
import { asObject } from './proposal-view.mapper';
import { KG_PROPOSAL_TARGET_TYPE, lockProposal, ProposalsService } from './proposals.service';

type Tx = Prisma.TransactionClient;

export const GRAPH_PROPOSAL_REVERTED_ACTION = 'graph.proposal_reverted';
/** Slack between the commit's own writes and `committed_at`. */
export const REVERT_EDIT_SLACK_MS = 1_000;
const MAX_ATTEMPTS = 3;

interface RevertOutcome {
  result: RevertResult;
  survivingEntities: string[];
  reversedMerges: ReverseResult[];
}

/** Read a stored commit log tolerantly: missing arrays are empty. */
export function readCommitLog(raw: unknown): CommitLog {
  const log = asObject(raw);
  const base = emptyCommitLog();
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const created = asObject(log.created);
  return {
    created: { entities: arr(created.entities), relations: arr(created.relations), items: arr(created.items) },
    createdEvidence: arr(log.createdEvidence),
    evidenceAdded: arr(log.evidenceAdded),
    aliasesAdded: arr(log.aliasesAdded),
    distinctPairs: arr(log.distinctPairs),
    mentions: arr(log.mentions),
    merges: arr(log.merges),
    itemChanges: arr(log.itemChanges),
    closings: arr(log.closings),
    ...(raw === null || raw === undefined ? base : {}),
  };
}

function sameItemState(a: ItemState, b: ItemState): boolean {
  return (
    a.status === b.status &&
    (a.dueAt ?? null) === (b.dueAt ?? null) &&
    a.reviewStatus === b.reviewStatus &&
    (a.supersededById ?? null)?.toLowerCase() === (b.supersededById ?? null)?.toLowerCase()
  );
}

@Injectable()
export class ProposalRevertService {
  private readonly logger = new Logger(ProposalRevertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GraphAccessService,
    private readonly merges: MergeService,
    private readonly commits: ProposalCommitService,
    private readonly proposals: ProposalsService,
  ) {}

  async revert(user: RequestUser, proposalId: string, confirmPartial: boolean): Promise<RevertResponse> {
    await this.access.require(user.id, 'proposal', proposalId, 'edit', user.permissions);

    let outcome: RevertOutcome | undefined;
    for (let attempt = 1; outcome === undefined; attempt += 1) {
      try {
        outcome = await this.prisma.$transaction((tx) => this.revertIn(tx, user.id, proposalId, confirmPartial), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 60_000,
          maxWait: 10_000,
        });
      } catch (err) {
        if (attempt < MAX_ATTEMPTS && isSerializationFailure(err)) continue;
        if (err instanceof HttpException) throw err;
        throw toGraphHttpException(err, this.logger) ?? err;
      }
    }

    await this.afterRevert(user.id, proposalId, outcome);
    this.logger.log(
      `kg.revert proposal=${proposalId} reverted=${outcome.result.reverted} kept=${outcome.result.kept.length}`,
    );
    return { proposal: await this.proposals.summary(proposalId), result: outcome.result };
  }

  // ===========================================================================
  // The transaction
  // ===========================================================================

  async revertIn(tx: Tx, ownerId: string, proposalId: string, confirmPartial: boolean): Promise<RevertOutcome> {
    const status = await lockProposal(tx, proposalId);
    if (status !== 'committed') {
      throw new ConflictException({
        message: `This proposal is ${status}, not committed, so there is nothing to revert.`,
        details: { reason: GRAPH_CONFLICT_REASONS.PROPOSAL_NOT_COMMITTED, status },
      });
    }
    const proposal = await tx.kgProposal.findUniqueOrThrow({ where: { id: proposalId } });
    const log = readCommitLog(proposal.commitLog);
    const committedAt = proposal.committedAt ?? proposal.updatedAt;
    const threshold = new Date(committedAt.getTime() + REVERT_EDIT_SLACK_MS);
    const kept: RevertKept[] = [];
    const keep = (k: RevertKept) => {
      if (!kept.some((x) => x.kind === k.kind && x.id === k.id)) kept.push(k);
    };

    // --- created rows ----------------------------------------------------------
    const [entities, relations, items] = await Promise.all([
      log.created.entities.length === 0 ? [] : tx.kgEntity.findMany({
        where: { id: { in: log.created.entities }, ownerId },
        select: { id: true, label: true, updatedAt: true, mergedIntoId: true, reviewStatus: true },
      }),
      log.created.relations.length === 0 ? [] : tx.kgRelation.findMany({
        where: { id: { in: log.created.relations }, ownerId },
        select: { id: true, type: true, fromId: true, toId: true, updatedAt: true },
      }),
      log.created.items.length === 0 ? [] : tx.kgItem.findMany({
        where: { id: { in: log.created.items }, ownerId },
        select: { id: true, title: true, statement: true, updatedAt: true, subjectId: true, ownerPersonId: true, counterpartyId: true, meetingId: true },
      }),
    ]);
    const createdIds = new Set([...log.created.entities, ...log.created.relations, ...log.created.items].map((id) => id.toLowerCase()));
    const ownEvidence = new Set([...log.createdEvidence, ...log.evidenceAdded].map((id) => id.toLowerCase()));

    const subjectFilter = [
      ...entities.map((e) => ({ subjectKind: 'entity' as const, subjectId: e.id })),
      ...relations.map((r) => ({ subjectKind: 'relation' as const, subjectId: r.id })),
      ...items.map((i) => ({ subjectKind: 'item' as const, subjectId: i.id })),
    ];
    const createdEvidence = subjectFilter.length === 0 ? [] : await tx.kgEvidence.findMany({
      where: { ownerId, OR: subjectFilter },
      select: { id: true, subjectId: true },
    });
    const foreignEvidence = new Set(
      createdEvidence.filter((e) => !ownEvidence.has(e.id.toLowerCase())).map((e) => e.subjectId.toLowerCase()),
    );

    const endpointLabels = await this.labels(tx, ownerId, relations.flatMap((r) => [r.fromId, r.toId].filter((v): v is string => !!v)));
    const relationLabel = (r: { type: string; fromId: string | null; toId: string }) =>
      `${(r.fromId && endpointLabels.get(r.fromId)) ?? '?'} → ${r.type} → ${endpointLabels.get(r.toId) ?? '?'}`;
    const itemLabel = (i: { title: string | null; statement: string }) => i.title ?? i.statement.slice(0, 80);

    // Entities: merged, edited, extra evidence, or named by something newer.
    const entityIds = entities.map((e) => e.id);
    const [laterMerges, laterRelations, laterItems] = await Promise.all([
      entityIds.length === 0 ? [] : tx.kgMerge.findMany({
        where: { ownerId, reversedAt: null, createdAt: { gt: committedAt }, OR: [{ survivorId: { in: entityIds } }, { mergedId: { in: entityIds } }] },
        select: { survivorId: true, mergedId: true },
      }),
      entityIds.length === 0 ? [] : tx.kgRelation.findMany({
        where: { ownerId, createdAt: { gt: committedAt }, OR: [{ fromId: { in: entityIds } }, { toId: { in: entityIds } }] },
        select: { id: true, fromId: true, toId: true },
      }),
      entityIds.length === 0 ? [] : tx.kgItem.findMany({
        where: {
          ownerId,
          createdAt: { gt: committedAt },
          OR: [
            { subjectId: { in: entityIds } },
            { ownerPersonId: { in: entityIds } },
            { counterpartyId: { in: entityIds } },
            { meetingId: { in: entityIds } },
          ],
        },
        select: { id: true, subjectId: true, ownerPersonId: true, counterpartyId: true, meetingId: true },
      }),
    ]);
    const mergedSince = new Set(laterMerges.flatMap((m) => [m.survivorId.toLowerCase(), m.mergedId.toLowerCase()]));
    const referencedSince = new Set<string>();
    for (const r of laterRelations) {
      if (createdIds.has(r.id.toLowerCase())) continue;
      [r.fromId, r.toId].forEach((id) => id && referencedSince.add(id.toLowerCase()));
    }
    for (const i of laterItems) {
      if (createdIds.has(i.id.toLowerCase())) continue;
      [i.subjectId, i.ownerPersonId, i.counterpartyId, i.meetingId].forEach((id) => id && referencedSince.add(id.toLowerCase()));
    }

    for (const e of entities) {
      const id = e.id.toLowerCase();
      if (e.mergedIntoId !== null || e.reviewStatus === 'merged' || mergedSince.has(id)) keep({ kind: 'entity', id: e.id, label: e.label, why: 'merged_since' });
      else if (e.updatedAt > threshold) keep({ kind: 'entity', id: e.id, label: e.label, why: 'edited_since' });
      else if (foreignEvidence.has(id)) keep({ kind: 'entity', id: e.id, label: e.label, why: 'evidence_since' });
      else if (referencedSince.has(id)) keep({ kind: 'entity', id: e.id, label: e.label, why: 'referenced_since' });
    }
    for (const r of relations) {
      const id = r.id.toLowerCase();
      if (r.updatedAt > threshold) keep({ kind: 'relation', id: r.id, label: relationLabel(r), why: 'edited_since' });
      else if (foreignEvidence.has(id)) keep({ kind: 'relation', id: r.id, label: relationLabel(r), why: 'evidence_since' });
    }
    for (const i of items) {
      const id = i.id.toLowerCase();
      if (i.updatedAt > threshold) keep({ kind: 'item', id: i.id, label: itemLabel(i), why: 'edited_since' });
      else if (foreignEvidence.has(id)) keep({ kind: 'item', id: i.id, label: itemLabel(i), why: 'evidence_since' });
    }
    // A created entity that a KEPT row of this commit names must stay, or deleting it would cascade that row away.
    const keptIds = () => new Set(kept.map((k) => k.id.toLowerCase()));
    const keptNow = keptIds();
    const namedByKept = new Set<string>();
    for (const r of relations) if (keptNow.has(r.id.toLowerCase())) [r.fromId, r.toId].forEach((id) => id && namedByKept.add(id.toLowerCase()));
    for (const i of items) {
      if (keptNow.has(i.id.toLowerCase())) {
        [i.subjectId, i.ownerPersonId, i.counterpartyId, i.meetingId].forEach((id) => id && namedByKept.add(id.toLowerCase()));
      }
    }
    for (const e of entities) {
      if (namedByKept.has(e.id.toLowerCase())) keep({ kind: 'entity', id: e.id, label: e.label, why: 'referenced_since' });
    }

    // --- item changes and closings --------------------------------------------
    const changedItems = log.itemChanges.length === 0 ? [] : await tx.kgItem.findMany({
      where: { id: { in: log.itemChanges.map((c) => c.itemId) }, ownerId },
    });
    const keptSet = keptIds();
    const revertibleChanges: CommitLog['itemChanges'] = [];
    for (const change of log.itemChanges) {
      const row = changedItems.find((i) => i.id.toLowerCase() === change.itemId.toLowerCase());
      if (!row) continue; // gone since: nothing left to restore
      const successorKept = change.after.supersededById && keptSet.has(change.after.supersededById.toLowerCase());
      if (successorKept) keep({ kind: 'item_change', id: row.id, label: itemLabel(row), why: 'referenced_since' });
      else if (!sameItemState(itemState(row), change.after)) keep({ kind: 'item_change', id: row.id, label: itemLabel(row), why: 'edited_since' });
      else revertibleChanges.push(change);
    }

    const revertibleClosings: CommitLog['closings'] = [];
    for (const closing of log.closings) {
      const [row] = await tx.$queryRaw<Array<{ id: string; type: string; from_id: string | null; to_id: string; valid: string | null; valid_precision: string | null; superseded_by_id: string | null }>>`
        SELECT id::text AS id, type, from_id::text AS from_id, to_id::text AS to_id, valid::text AS valid,
               valid_precision::text AS valid_precision, superseded_by_id::text AS superseded_by_id
          FROM kg_relations WHERE id = ${closing.relationId}::uuid AND owner_id = ${ownerId}::uuid FOR UPDATE`;
      if (!row) continue;
      const labels = await this.labels(tx, ownerId, [row.from_id, row.to_id].filter((v): v is string => !!v));
      const label = `${(row.from_id && labels.get(row.from_id)) ?? '?'} → ${row.type} → ${labels.get(row.to_id) ?? '?'}`;
      const closerKept = closing.after.supersededById && keptSet.has(closing.after.supersededById.toLowerCase());
      const unchanged =
        row.valid === closing.after.valid &&
        row.valid_precision === closing.after.validPrecision &&
        (row.superseded_by_id ?? null) === (closing.after.supersededById ?? null);
      if (closerKept) keep({ kind: 'closing', id: row.id, label, why: 'referenced_since' });
      else if (!unchanged) keep({ kind: 'closing', id: row.id, label, why: 'edited_since' });
      else revertibleClosings.push(closing);
    }

    // --- the tally, before anything is written ---------------------------------
    const finalKept = keptIds();
    const revertEntities = entities.filter((e) => !finalKept.has(e.id.toLowerCase()));
    const revertRelations = relations.filter((r) => !finalKept.has(r.id.toLowerCase()));
    const revertItems = items.filter((i) => !finalKept.has(i.id.toLowerCase()));
    const unreversedMerges = log.merges.length === 0 ? [] : await tx.kgMerge.findMany({
      where: { id: { in: log.merges }, ownerId, reversedAt: null },
      select: { id: true, survivorId: true },
    });
    const revertible =
      revertEntities.length + revertRelations.length + revertItems.length +
      log.evidenceAdded.length + log.aliasesAdded.length + log.mentions.length + log.distinctPairs.length +
      revertibleChanges.length + revertibleClosings.length + unreversedMerges.length;

    const conflict = () =>
      new ConflictException({
        message: 'Some of what this commit added has changed since. Revert the rest, or keep everything.',
        details: { reason: GRAPH_CONFLICT_REASONS.REVERT_CONFLICT, conflicts: kept, revertible },
      });
    if (kept.length > 0 && !confirmPartial) throw conflict();

    // --- writes -----------------------------------------------------------------
    let reverted = 0;
    const survivingEntities = new Set<string>(entities.filter((e) => finalKept.has(e.id.toLowerCase())).map((e) => e.id));
    const reversedMerges: ReverseResult[] = [];

    // Merges (resolution proposals), each in its own savepoint.
    for (const merge of unreversedMerges) {
      await tx.$executeRawUnsafe('SAVEPOINT kg_revert_merge');
      try {
        reversedMerges.push(await this.merges.reverse({ ownerId, mergeId: merge.id, actorId: ownerId }, tx));
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT kg_revert_merge');
        reverted += 1;
      } catch (err) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT kg_revert_merge');
        const reason = err instanceof ConflictException ? asObject(asObject(err.getResponse()).details).reason : undefined;
        if (reason !== GRAPH_CONFLICT_REASONS.REVERT_CONFLICT) throw err;
        const survivor = await tx.kgEntity.findUnique({ where: { id: merge.survivorId }, select: { label: true } });
        keep({ kind: 'entity', id: merge.survivorId, label: survivor?.label ?? '', why: 'merged_since' });
      }
    }
    if (kept.length > 0 && !confirmPartial) throw conflict();

    // Evidence appended to pre-existing subjects — never the LAST citation of a live subject.
    const appended = log.evidenceAdded.length === 0 ? [] : await tx.kgEvidence.findMany({
      where: { id: { in: log.evidenceAdded }, ownerId },
      select: { id: true, subjectKind: true, subjectId: true },
    });
    const deletable: string[] = [];
    const bySubject = new Map<string, typeof appended>();
    for (const e of appended) {
      const key = `${e.subjectKind}:${e.subjectId}`;
      bySubject.set(key, [...(bySubject.get(key) ?? []), e]);
    }
    for (const [, rows] of bySubject) {
      const { subjectKind, subjectId } = rows[0];
      const total = await tx.kgEvidence.count({ where: { subjectKind, subjectId } });
      if (total > rows.length) deletable.push(...rows.map((r) => r.id));
      if (subjectKind === 'entity') survivingEntities.add(subjectId);
    }
    if (deletable.length > 0) reverted += (await tx.kgEvidence.deleteMany({ where: { id: { in: deletable } } })).count;

    // Created rows: their evidence, then items → relations → entities.
    const evidenceOf = (kind: 'entity' | 'relation' | 'item', ids: string[]) =>
      ids.length === 0 ? Promise.resolve() : tx.kgEvidence.deleteMany({ where: { ownerId, subjectKind: kind, subjectId: { in: ids } } }).then(() => undefined);
    await evidenceOf('item', revertItems.map((i) => i.id));
    await evidenceOf('relation', revertRelations.map((r) => r.id));
    await evidenceOf('entity', revertEntities.map((e) => e.id));
    if (revertItems.length > 0) reverted += (await tx.kgItem.deleteMany({ where: { id: { in: revertItems.map((i) => i.id) } } })).count;
    if (revertRelations.length > 0) reverted += (await tx.kgRelation.deleteMany({ where: { id: { in: revertRelations.map((r) => r.id) } } })).count;
    if (revertEntities.length > 0) reverted += (await tx.kgEntity.deleteMany({ where: { id: { in: revertEntities.map((e) => e.id) } } })).count;

    // Item changes and closings back to what they were.
    for (const change of revertibleChanges) {
      await tx.kgItem.update({
        where: { id: change.itemId },
        data: {
          status: change.before.status,
          dueAt: change.before.dueAt ? new Date(change.before.dueAt) : null,
          reviewStatus: change.before.reviewStatus as never,
          supersededById: change.before.supersededById,
        },
      });
      reverted += 1;
    }
    for (const closing of revertibleClosings) {
      const b = closing.before;
      await tx.$executeRaw`
        UPDATE kg_relations
           SET valid = ${b.valid}::tstzrange,
               valid_precision = ${b.validPrecision}::kg_valid_precision,
               superseded_by_id = ${b.supersededById}::uuid,
               updated_at = now()
         WHERE id = ${closing.relationId}::uuid`;
      reverted += 1;
    }

    // Learning undone. An alias/mention of a deleted entity already went with it (Cascade).
    if (log.aliasesAdded.length > 0) {
      const aliasRows = await tx.kgEntityAlias.findMany({ where: { id: { in: log.aliasesAdded }, ownerId }, select: { entityId: true } });
      aliasRows.forEach((a) => survivingEntities.add(a.entityId));
      reverted += (await tx.kgEntityAlias.deleteMany({ where: { id: { in: log.aliasesAdded }, ownerId } })).count;
    }
    if (log.mentions.length > 0) {
      reverted += (await tx.kgMention.deleteMany({ where: { id: { in: log.mentions }, ownerId } })).count;
    }
    for (const [aId, bId] of log.distinctPairs) {
      reverted += (await tx.kgDistinctPair.deleteMany({ where: { ownerId, aId, bId } })).count;
    }

    const result: RevertResult = { reverted, kept };
    await tx.kgProposal.update({
      where: { id: proposalId },
      data: {
        status: 'reverted',
        revertedAt: new Date(),
        stats: { ...asObject(proposal.stats), revert: result } as Prisma.InputJsonValue,
      },
    });

    const deleted = new Set(revertEntities.map((e) => e.id.toLowerCase()));
    return {
      result,
      survivingEntities: [...survivingEntities].filter((id) => !deleted.has(id.toLowerCase())),
      reversedMerges,
    };
  }

  // ===========================================================================
  // After
  // ===========================================================================

  private async afterRevert(ownerId: string, proposalId: string, outcome: RevertOutcome): Promise<void> {
    try {
      await this.commits.enqueueDigests(ownerId, outcome.survivingEntities);
    } catch (err) {
      this.logger.warn(`Digest enqueue after reverting proposal ${proposalId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const reversed of outcome.reversedMerges) {
      try {
        await this.merges.afterReverse({ ownerId, actorId: ownerId }, reversed);
      } catch (err) {
        this.logger.warn(`After-reverse work for merge ${reversed.merge.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: ownerId,
          action: GRAPH_PROPOSAL_REVERTED_ACTION,
          targetType: KG_PROPOSAL_TARGET_TYPE,
          targetId: proposalId,
          meta: { reverted: outcome.result.reverted, kept: outcome.result.kept.length, partial: outcome.result.kept.length > 0 },
        },
      });
    } catch (err) {
      this.logger.warn(`Audit after reverting proposal ${proposalId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async labels(tx: Tx, ownerId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.kgEntity.findMany({ where: { id: { in: [...new Set(ids)] }, ownerId }, select: { id: true, label: true } });
    return new Map(rows.map((r) => [r.id, r.label]));
  }
}
