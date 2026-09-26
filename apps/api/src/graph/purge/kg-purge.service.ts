// =============================================================================
// KgPurgeService (#357, epic #344; docs/specs/ontology.md §11, §12, §15)
// =============================================================================
//
// Deletes graph rows in bulk, for exactly two requests:
//
//   purgePerson(userId, entityId) — "Forget this person" (§15). The Person,
//     every tombstone merged into it (the same human, merged earlier), and
//     everything derived ABOUT them: items where they are subject, owner or
//     counterparty; relations naming them on either end (IDENTIFIED_AS
//     included — the Person is its `to_id`); aliases, mentions, digests,
//     views, merge records and distinct pairs; draft proposal items that
//     would re-create them; and every `kg_evidence` row of each of those.
//
//   purgeAll(userId) — the Danger Zone's `graph` category (§11): every
//     `kg_*` row the user owns, plus their own `kg_entity_views`.
//
// Called only by the `kg.purge` job handler — never inline from a request
// (CLAUDE.md "Every Long-Running Activity Is a Queue Job").
//
// -----------------------------------------------------------------------------
// ⚠ IT NEVER TOUCHES PRIMARY CONTENT
// -----------------------------------------------------------------------------
//
// `transcripts`, `transcript_segments`, `transcript_speakers`, `notes`,
// `note_versions` and `storage_objects` are the account holder's own content;
// the graph's authority stops at the graph (§15). No statement below names
// one of those tables, and `test/graph/kg-purge.db.spec.ts` asserts their row
// counts and texts are unchanged. Every anchor FK from `kg_evidence` into them
// is SetNull, so deleting evidence never cascades the other way either.
//
// -----------------------------------------------------------------------------
// ⚠ AN EXPLICIT PLAN, NOT FK CASCADES
// -----------------------------------------------------------------------------
//
// `kg_evidence` is polymorphic with NO foreign key to its subject, and a draft
// proposal holds entity ids inside JSON. Deleting `kg_entities` and trusting
// `ON DELETE CASCADE` would leave both behind: citations (with their quotes —
// the very text about the person) pointing at nothing, and a draft that would
// re-create the person on commit. The plan below names every table.
//
// The ORDER is data (`KG_PURGE_PERSON_PLAN`, `KG_PURGE_ALL_PLAN`), so it is
// testable without a database; `kg-purge.service.spec.ts` pins it.
//
// -----------------------------------------------------------------------------
// ⚠ EVIDENCE GOES IN THE SAME TRANSACTION AS ITS SUBJECT
// -----------------------------------------------------------------------------
//
// Batches of `KG_PURGE_BATCH` ids, each its own transaction — so no single
// statement or lock grows with the size of a library. That makes the ORDER of
// evidence and subject load-bearing: the deferred no-orphans trigger (#355)
// re-reads a subject's review status at COMMIT when one of its citations is
// deleted, and refuses the commit if an `accepted`/`edited` subject is left
// with none. So every batch that deletes evidence deletes the subjects it
// cites in the SAME transaction (the trigger then finds no row and passes).
//
// For `purgeAll` this is why evidence is not a first step of its own, as the
// issue's order listed it: a first "delete all evidence" pass in separate
// batch transactions would fail at the first COMMIT. Subject evidence goes
// with each items/relations/entities batch instead, and a final `evidence`
// step sweeps what has no graph subject (proposal-item and import anchors,
// and any residue).
//
// -----------------------------------------------------------------------------
// RE-ENTRANT
// -----------------------------------------------------------------------------
//
// Every step selects what is still there and deletes it, so a second run over
// a half-finished purge deletes the rest and a run over a finished one deletes
// nothing. `kg.purge` is still `maxAttempts: 1` (see the handler): re-entrancy
// makes a person-initiated retry safe, not an automatic one honest.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

/** Ids per statement, and per transaction. */
export const KG_PURGE_BATCH = 500;

/**
 * Most batches any one step runs before giving up.
 *
 * A STOP, NOT A BUDGET — the same device `USER_DATA_PURGE_MAX_BATCHES` is.
 * Every loop ends by its own predicate (a deleted row no longer matches), so
 * reaching this means a row is being selected and not deleted; throwing names
 * the step instead of holding a worker slot until the timeout.
 */
export const KG_PURGE_MAX_BATCHES = 10_000;

/** The shipped ontology key of the one type "forget" applies to. */
export const KG_PERSON_TYPE = 'Person';

/** Proposal statuses whose items are still work in progress, not history. */
export const KG_PURGE_OPEN_PROPOSAL_STATUSES = ['draft', 'extracting'] as const;

/** `scope: 'person'`, in order. */
export const KG_PURGE_PERSON_PLAN = [
  'items',
  'relations',
  'entityRows',
  'draftProposalItems',
  'entities',
] as const;

/** `scope: 'all'`, in order. See the header for where evidence went. */
export const KG_PURGE_ALL_PLAN = [
  'mentions',
  'proposalItems',
  'proposals',
  'merges',
  'distinctPairs',
  'digests',
  'views',
  'items',
  'relations',
  'aliases',
  'entities',
  'evidence',
  'attributeDefs',
  // #371 — the whole-graph layout snapshots. Ids and coordinates only (labels
  // are never stored), but they are still a map of the graph being wiped.
  'graphLayouts',
] as const;

export type KgPurgePersonStep = (typeof KG_PURGE_PERSON_PLAN)[number];
export type KgPurgeAllStep = (typeof KG_PURGE_ALL_PLAN)[number];

/** Rows deleted, per table. Counts only — never a label, never a quote. */
export interface KgPurgeCounts {
  entities: number;
  aliases: number;
  relations: number;
  items: number;
  evidence: number;
  mentions: number;
  proposalItems: number;
  proposals: number;
  merges: number;
  distinctPairs: number;
  digests: number;
  views: number;
  attributeDefs: number;
  graphLayouts: number;
}

/** What `purgePerson` reports: the counts, and the set of ids it forgot. */
export interface KgPurgePersonResult {
  counts: KgPurgeCounts;
  /** The target plus every tombstone merged into it, recursively. */
  entityIds: string[];
}

export function emptyKgPurgeCounts(): KgPurgeCounts {
  return {
    entities: 0,
    aliases: 0,
    relations: 0,
    items: 0,
    evidence: 0,
    mentions: 0,
    proposalItems: 0,
    proposals: 0,
    merges: 0,
    distinctPairs: 0,
    digests: 0,
    views: 0,
    attributeDefs: 0,
    graphLayouts: 0,
  };
}

/** Split `ids` into runs of at most `size`. Pure. */
export function chunk<T>(ids: readonly T[], size: number = KG_PURGE_BATCH): T[][] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

type Tx = Prisma.TransactionClient;

@Injectable()
export class KgPurgeService {
  private readonly logger = new Logger(KgPurgeService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // scope: 'person'
  // ===========================================================================

  /**
   * Forget one Person, or return `null` (deleting nothing) when `entityId`
   * is not an entity `userId` owns, or is not a `Person`.
   */
  async purgePerson(userId: string, entityId: string): Promise<KgPurgePersonResult | null> {
    const set = await this.collectPersonSet(userId, entityId);
    if (!set) return null;

    const counts = emptyKgPurgeCounts();
    for (const step of KG_PURGE_PERSON_PLAN) {
      await this.runPersonStep(step, userId, set, counts);
    }
    return { counts, entityIds: set };
  }

  /**
   * The target plus every entity recursively `merged_into_id` it, all owned
   * by `userId` — or `null` when the target is missing, someone else's, or not
   * a Person.
   *
   * Walked breadth-first with a visited set, so a (never legitimate) merge
   * cycle terminates instead of looping.
   */
  async collectPersonSet(userId: string, entityId: string): Promise<string[] | null> {
    const target = await this.prisma.kgEntity.findUnique({
      where: { id: entityId },
      select: { id: true, ownerId: true, type: true },
    });
    if (!target || target.ownerId !== userId || target.type !== KG_PERSON_TYPE) return null;

    const seen = new Set<string>([target.id]);
    let frontier = [target.id];
    for (let depth = 0; frontier.length > 0; depth += 1) {
      if (depth >= KG_PURGE_MAX_BATCHES) {
        throw new Error(`Merged-set closure for entity ${entityId} did not converge`);
      }
      const rows = await this.prisma.kgEntity.findMany({
        where: { ownerId: userId, mergedIntoId: { in: frontier } },
        select: { id: true },
      });
      frontier = rows.map((r) => r.id).filter((id) => !seen.has(id));
      frontier.forEach((id) => seen.add(id));
    }
    return [...seen];
  }

  private async runPersonStep(
    step: KgPurgePersonStep,
    userId: string,
    set: string[],
    counts: KgPurgeCounts,
  ): Promise<void> {
    switch (step) {
      case 'items':
        return this.drain(step, () =>
          this.prisma.kgItem.findMany({
            where: {
              ownerId: userId,
              OR: [
                { subjectId: { in: set } },
                { ownerPersonId: { in: set } },
                { counterpartyId: { in: set } },
              ],
            },
            select: { id: true },
            take: KG_PURGE_BATCH,
          }),
          (tx, ids) => this.deleteItems(tx, userId, ids, counts),
        );

      case 'relations':
        return this.drain(step, () =>
          this.prisma.kgRelation.findMany({
            where: { ownerId: userId, OR: [{ fromId: { in: set } }, { toId: { in: set } }] },
            select: { id: true },
            take: KG_PURGE_BATCH,
          }),
          (tx, ids) => this.deleteRelations(tx, userId, ids, counts),
        );

      case 'entityRows':
        for (const ids of chunk(set)) {
          await this.prisma.$transaction(async (tx) => {
            counts.aliases += (await tx.kgEntityAlias.deleteMany({ where: { entityId: { in: ids } } })).count;
            counts.mentions += (await tx.kgMention.deleteMany({ where: { entityId: { in: ids } } })).count;
            counts.digests += (await tx.kgEntityDigest.deleteMany({ where: { entityId: { in: ids } } })).count;
            // Every viewer's "recently viewed" row for this person, not only
            // the owner's — the entity is going, and so is any trace of it.
            counts.views += (await tx.kgEntityView.deleteMany({ where: { entityId: { in: ids } } })).count;
            counts.merges += (
              await tx.kgMerge.deleteMany({
                where: { OR: [{ survivorId: { in: ids } }, { mergedId: { in: ids } }] },
              })
            ).count;
            counts.distinctPairs += (
              await tx.kgDistinctPair.deleteMany({
                where: { OR: [{ aId: { in: ids } }, { bId: { in: ids } }] },
              })
            ).count;
          });
        }
        return;

      case 'draftProposalItems':
        // BEFORE `entities`: `merge_into_id` is SetNull, so once the entity is
        // gone the column no longer names it and the item could not be found.
        await this.drain(step, () => this.selectDraftItemsReferencing(userId, set), async (tx, ids) => {
          counts.evidence += (
            await tx.kgEvidence.deleteMany({
              where: { ownerId: userId, subjectKind: 'proposal_item', subjectId: { in: ids } },
            })
          ).count;
          counts.proposalItems += (await tx.kgProposalItem.deleteMany({ where: { id: { in: ids } } })).count;
        });
        await this.stripDistinctFrom(userId, set);
        return;

      case 'entities':
        for (const ids of chunk(set)) {
          await this.prisma.$transaction((tx) => this.deleteEntities(tx, userId, ids, counts));
        }
        return;
    }
  }

  /**
   * Draft/extracting proposal items that name any id of `set`: `merge_into_id`,
   * `resolution.ref`, any `resolution.candidates[*].entityId`, and any
   * `entityId`/`existingEntityId` at any depth of `payload`/`edited_payload`
   * (#363's payloads express every endpoint as `{ entityId }` or `{ ref }`).
   * Committed proposals are history, and are left alone.
   */
  private async selectDraftItemsReferencing(userId: string, set: string[]): Promise<Array<{ id: string }>> {
    const statuses = [...KG_PURGE_OPEN_PROPOSAL_STATUSES];
    return this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT pi.id::text AS id
        FROM kg_proposal_items pi
        JOIN kg_proposals p ON p.id = pi.proposal_id
       WHERE p.owner_id = ${userId}::uuid
         AND p.status::text = ANY(${statuses}::text[])
         AND (
              pi.merge_into_id = ANY(${set}::uuid[])
           OR pi.resolution->>'ref' = ANY(${set}::text[])
           OR EXISTS (
                SELECT 1 FROM unnest(${set}::text[]) AS s(id)
                 WHERE jsonb_path_exists(pi.payload,
                         '$.** ? (@.entityId == $id || @.existingEntityId == $id)',
                         jsonb_build_object('id', s.id))
                    OR jsonb_path_exists(coalesce(pi.edited_payload, '{}'::jsonb),
                         '$.** ? (@.entityId == $id || @.existingEntityId == $id)',
                         jsonb_build_object('id', s.id))
                    OR jsonb_path_exists(coalesce(pi.resolution, '{}'::jsonb),
                         '$.candidates[*] ? (@.entityId == $id)',
                         jsonb_build_object('id', s.id))
              )
         )
       LIMIT ${KG_PURGE_BATCH}`;
  }

  /** Remove the forgotten ids from other open items' `distinct_from` lists. */
  private async stripDistinctFrom(userId: string, set: string[]): Promise<void> {
    const statuses = [...KG_PURGE_OPEN_PROPOSAL_STATUSES];
    await this.prisma.$executeRaw`
      UPDATE kg_proposal_items pi
         SET distinct_from = ARRAY(
               SELECT x FROM unnest(pi.distinct_from) AS x WHERE NOT (x = ANY(${set}::text[]))
             )
        FROM kg_proposals p
       WHERE p.id = pi.proposal_id
         AND p.owner_id = ${userId}::uuid
         AND p.status::text = ANY(${statuses}::text[])
         AND pi.distinct_from && ${set}::text[]`;
  }

  // ===========================================================================
  // scope: 'all'
  // ===========================================================================

  /** Delete every `kg_*` row `userId` owns, and their own entity views. */
  async purgeAll(userId: string): Promise<KgPurgeCounts> {
    const counts = emptyKgPurgeCounts();
    for (const step of KG_PURGE_ALL_PLAN) {
      await this.runAllStep(step, userId, counts);
    }
    return counts;
  }

  private async runAllStep(step: KgPurgeAllStep, userId: string, counts: KgPurgeCounts): Promise<void> {
    const owned = { ownerId: userId };
    const byId = { select: { id: true }, take: KG_PURGE_BATCH } as const;

    switch (step) {
      case 'mentions':
        return this.drain(step, () => this.prisma.kgMention.findMany({ where: owned, ...byId }), async (tx, ids) => {
          counts.mentions += (await tx.kgMention.deleteMany({ where: { id: { in: ids } } })).count;
        });

      case 'proposalItems':
        return this.drain(
          step,
          () => this.prisma.kgProposalItem.findMany({ where: { proposal: owned }, ...byId }),
          async (tx, ids) => {
            counts.evidence += (
              await tx.kgEvidence.deleteMany({
                where: { ownerId: userId, subjectKind: 'proposal_item', subjectId: { in: ids } },
              })
            ).count;
            counts.proposalItems += (await tx.kgProposalItem.deleteMany({ where: { id: { in: ids } } })).count;
          },
        );

      case 'proposals':
        return this.drain(step, () => this.prisma.kgProposal.findMany({ where: owned, ...byId }), async (tx, ids) => {
          counts.proposals += (await tx.kgProposal.deleteMany({ where: { id: { in: ids } } })).count;
        });

      case 'merges':
        return this.drain(step, () => this.prisma.kgMerge.findMany({ where: owned, ...byId }), async (tx, ids) => {
          counts.merges += (await tx.kgMerge.deleteMany({ where: { id: { in: ids } } })).count;
        });

      case 'distinctPairs':
        // A composite primary key and no `id`: the batch is a list of pairs.
        for (let batch = 0; batch < KG_PURGE_MAX_BATCHES; batch += 1) {
          const pairs = await this.prisma.kgDistinctPair.findMany({
            where: owned,
            select: { aId: true, bId: true },
            take: KG_PURGE_BATCH,
          });
          if (pairs.length === 0) return;
          await this.prisma.$transaction(async (tx) => {
            counts.distinctPairs += (
              await tx.kgDistinctPair.deleteMany({
                where: { ownerId: userId, OR: pairs.map((p) => ({ aId: p.aId, bId: p.bId })) },
              })
            ).count;
          });
        }
        throw this.nonConvergence(step, userId);

      case 'digests':
        return this.drain(
          step,
          async () =>
            (
              await this.prisma.kgEntityDigest.findMany({
                where: owned,
                select: { entityId: true },
                take: KG_PURGE_BATCH,
              })
            ).map((d) => ({ id: d.entityId })),
          async (tx, ids) => {
            counts.digests += (await tx.kgEntityDigest.deleteMany({ where: { entityId: { in: ids } } })).count;
          },
        );

      case 'views':
        // `kg_entity_views` is keyed on the VIEWER (`user_id`), not an owner.
        // Other viewers' rows for this user's entities go by cascade with the
        // entities below.
        return this.drain(
          step,
          () => this.prisma.kgEntityView.findMany({ where: { userId }, ...byId }),
          async (tx, ids) => {
            counts.views += (await tx.kgEntityView.deleteMany({ where: { id: { in: ids } } })).count;
          },
        );

      case 'items':
        return this.drain(step, () => this.prisma.kgItem.findMany({ where: owned, ...byId }), (tx, ids) =>
          this.deleteItems(tx, userId, ids, counts),
        );

      case 'relations':
        return this.drain(step, () => this.prisma.kgRelation.findMany({ where: owned, ...byId }), (tx, ids) =>
          this.deleteRelations(tx, userId, ids, counts),
        );

      case 'aliases':
        return this.drain(step, () => this.prisma.kgEntityAlias.findMany({ where: owned, ...byId }), async (tx, ids) => {
          counts.aliases += (await tx.kgEntityAlias.deleteMany({ where: { id: { in: ids } } })).count;
        });

      case 'entities':
        return this.drain(step, () => this.prisma.kgEntity.findMany({ where: owned, ...byId }), (tx, ids) =>
          this.deleteEntities(tx, userId, ids, counts),
        );

      case 'evidence':
        // What is left has no graph subject: proposal-item and import anchors.
        return this.drain(step, () => this.prisma.kgEvidence.findMany({ where: owned, ...byId }), async (tx, ids) => {
          counts.evidence += (await tx.kgEvidence.deleteMany({ where: { id: { in: ids } } })).count;
        });

      case 'attributeDefs':
        // `content` means "everything you made" — the note-templates line.
        return this.drain(
          step,
          () => this.prisma.kgAttributeDef.findMany({ where: owned, ...byId }),
          async (tx, ids) => {
            counts.attributeDefs += (await tx.kgAttributeDef.deleteMany({ where: { id: { in: ids } } })).count;
          },
        );

      case 'graphLayouts':
        // A handful of rows per owner (retention keeps two): one statement.
        counts.graphLayouts += (await this.prisma.kgGraphLayout.deleteMany({ where: owned })).count;
        return;
    }
  }

  // ===========================================================================
  // Shared batch bodies — each runs inside ONE transaction
  // ===========================================================================

  /** An items batch: its evidence, pointers onto it, then the items. */
  private async deleteItems(tx: Tx, userId: string, ids: string[], counts: KgPurgeCounts): Promise<void> {
    counts.evidence += (
      await tx.kgEvidence.deleteMany({ where: { ownerId: userId, subjectKind: 'item', subjectId: { in: ids } } })
    ).count;
    // An item that merely superseded-pointed at a deleted one survives, with
    // the pointer cleared (the FK would SetNull it anyway; saying so is clearer).
    await tx.kgItem.updateMany({
      where: { ownerId: userId, supersededById: { in: ids } },
      data: { supersededById: null },
    });
    counts.items += (await tx.kgItem.deleteMany({ where: { ownerId: userId, id: { in: ids } } })).count;
  }

  /** A relations batch: its evidence, pointers onto it, then the relations. */
  private async deleteRelations(tx: Tx, userId: string, ids: string[], counts: KgPurgeCounts): Promise<void> {
    counts.evidence += (
      await tx.kgEvidence.deleteMany({
        where: { ownerId: userId, subjectKind: 'relation', subjectId: { in: ids } },
      })
    ).count;
    await tx.kgRelation.updateMany({
      where: { ownerId: userId, supersededById: { in: ids } },
      data: { supersededById: null },
    });
    counts.relations += (await tx.kgRelation.deleteMany({ where: { ownerId: userId, id: { in: ids } } })).count;
  }

  /** An entities batch: their evidence, then the entities. */
  private async deleteEntities(tx: Tx, userId: string, ids: string[], counts: KgPurgeCounts): Promise<void> {
    counts.evidence += (
      await tx.kgEvidence.deleteMany({ where: { ownerId: userId, subjectKind: 'entity', subjectId: { in: ids } } })
    ).count;
    counts.entities += (await tx.kgEntity.deleteMany({ where: { ownerId: userId, id: { in: ids } } })).count;
  }

  /**
   * Select up to one batch of ids, delete them in one transaction, repeat
   * until the selection comes back empty.
   */
  private async drain(
    step: string,
    select: () => Promise<Array<{ id: string }>>,
    apply: (tx: Tx, ids: string[]) => Promise<void>,
  ): Promise<void> {
    for (let batch = 0; batch < KG_PURGE_MAX_BATCHES; batch += 1) {
      const ids = (await select()).map((row) => row.id);
      if (ids.length === 0) return;
      await this.prisma.$transaction((tx) => apply(tx, ids));
    }
    throw this.nonConvergence(step);
  }

  private nonConvergence(step: string, userId?: string): Error {
    const message =
      `kg.purge step "${step}"${userId ? ` for user ${userId}` : ''} did not converge after ` +
      `${KG_PURGE_MAX_BATCHES} batches`;
    this.logger.error(message);
    return new Error(message);
  }
}
