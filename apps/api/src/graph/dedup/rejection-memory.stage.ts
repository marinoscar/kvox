// =============================================================================
// The `rejection-memory` proposal stage (issue #365; docs/specs/ontology.md
// §5.5 `rejected` rows are kept, §7 "Learning")
// =============================================================================
//
// Order 400. A "no" a reviewer committed is remembered — only a COMMITTED
// proposal counts (a discarded, failed or reverted one said nothing):
//
//   PersonFact  whose `statementHash` equals a person_fact this owner rejected
//               in ANY committed proposal → removed from this proposal, with
//               its evidence (`stats.suppressedPersonFacts`) — §7 "suppressed
//               by its statement hash", never re-proposed verbatim
//   any other   relation/item whose rejection key (kind, type, resolved
//               endpoints, props for a relation, statement hash for an item)
//               matches a rejected row of a committed proposal FOR THE SAME
//               NOTE → kept, flagged `previously_rejected`, defaulted to
//               `reject` (visible, collapsed; the reviewer can flip it)
//
// A row `work-item-dedup` found `known` is left alone: it restates what the
// graph already holds, so an older "no" to a different wording is moot.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ProposalStageRegistry, type ProposalStage, type ProposalStageContext } from '../extraction/proposal-stage';
import type { EntityPayload, ItemPayload, ProposalResolution, RelationPayload } from '../proposals/proposal-payload.schema';
import { REJECTION_MEMORY_STAGE, rejectionKey, type ProposalEntityView } from './dedup-core';
import { loadProposalRows } from './proposal-rows';

export interface RejectionMemoryStats {
  suppressedPersonFacts: number;
  previouslyRejected: number;
  ms: number;
}

@Injectable()
export class RejectionMemoryStage implements ProposalStage, OnModuleInit {
  readonly name = REJECTION_MEMORY_STAGE.name;
  readonly order = REJECTION_MEMORY_STAGE.order;
  private readonly logger = new Logger(RejectionMemoryStage.name);

  constructor(private readonly registry: ProposalStageRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(ctx: ProposalStageContext): Promise<void> {
    const started = Date.now();
    const { userId, proposalId, noteId } = ctx;
    const stats: RejectionMemoryStats = { suppressedPersonFacts: 0, previouslyRejected: 0, ms: 0 };
    const rows = await loadProposalRows(ctx.prisma, proposalId);

    // ---- PersonFacts: suppressed across every note -------------------------------
    const personFacts = rows.items.filter((r) => r.payload.kind === 'person_fact' && !r.flags.includes('known'));
    const hashes = [...new Set(personFacts.map((r) => r.payload.statementHash))];
    const suppressed = new Set<string>();
    if (hashes.length > 0) {
      const rejected = await ctx.prisma.$queryRaw<Array<{ hash: string }>>`
        SELECT DISTINCT pi.payload->>'statementHash' AS hash
          FROM kg_proposal_items pi
          JOIN kg_proposals p ON p.id = pi.proposal_id
         WHERE p.owner_id = ${userId}::uuid
           AND p.status = 'committed'
           AND p.id <> ${proposalId}::uuid
           AND pi.kind = 'item'
           AND pi.decision = 'reject'
           AND pi.payload->>'kind' = 'person_fact'
           AND pi.payload->>'statementHash' = ANY(${hashes}::text[])`;
      const rejectedHashes = new Set(rejected.map((r) => r.hash));
      const drop = personFacts.filter((r) => rejectedHashes.has(r.payload.statementHash)).map((r) => r.id);
      if (drop.length > 0) {
        await ctx.prisma.kgEvidence.deleteMany({ where: { subjectKind: 'proposal_item', subjectId: { in: drop } } });
        await ctx.prisma.kgProposalItem.deleteMany({ where: { proposalId, id: { in: drop } } });
        for (const id of drop) suppressed.add(id);
        stats.suppressedPersonFacts = drop.length;
      }
    }

    // ---- Everything else: flagged when rejected before for THIS note -------------
    const remaining = [
      ...rows.relations.map((r) => ({ ...r, kind: 'relation' as const })),
      ...rows.items.map((r) => ({ ...r, kind: 'item' as const })),
    ].filter((r) => !suppressed.has(r.id) && !r.flags.includes('known'));
    if (remaining.length > 0) {
      const rejectedKeys = await this.rejectedKeysForNote(ctx, noteId);
      for (const row of remaining) {
        if (!rejectedKeys.has(rejectionKey(row.kind, row.payload, rows.entities))) continue;
        await ctx.prisma.kgProposalItem.update({
          where: { id: row.id },
          data: { flags: [...new Set([...row.flags, 'previously_rejected'])], decision: 'reject' },
        });
        stats.previouslyRejected += 1;
      }
    }

    stats.ms = Date.now() - started;
    Object.assign(ctx.stats, stats);
    this.logger.log(
      `kg.stage ${this.name} proposal=${proposalId} known=0 same=0 supersedes=0 closings=0 overlaps=0 ` +
        `suppressed=${stats.suppressedPersonFacts} ms=${stats.ms}`,
    );
  }

  /** Rejection keys of every rejected relation/item in this owner's committed proposals for the note. */
  private async rejectedKeysForNote(ctx: ProposalStageContext, noteId: string): Promise<Set<string>> {
    const rows = await ctx.prisma.kgProposalItem.findMany({
      where: {
        proposal: { ownerId: ctx.userId, noteId, status: 'committed', id: { not: ctx.proposalId } },
        OR: [{ kind: 'entity' }, { kind: { in: ['relation', 'item'] }, decision: 'reject' }],
      },
      select: {
        proposalId: true,
        kind: true,
        payload: true,
        resolution: true,
        committedRefId: true,
        mergeIntoId: true,
      },
    });
    // Each earlier proposal's own `ref → entity`: what its entity rows became.
    const entitiesByProposal = new Map<string, Map<string, ProposalEntityView>>();
    for (const r of rows) {
      if (r.kind !== 'entity') continue;
      const p = r.payload as unknown as EntityPayload;
      const resolution = (r.resolution ?? null) as ProposalResolution | null;
      const map = entitiesByProposal.get(r.proposalId) ?? new Map<string, ProposalEntityView>();
      map.set(p.ref, {
        ref: p.ref,
        type: p.type,
        label: p.label,
        resolvedId: r.committedRefId ?? r.mergeIntoId ?? resolution?.ref ?? null,
      });
      entitiesByProposal.set(r.proposalId, map);
    }
    const keys = new Set<string>();
    for (const r of rows) {
      if (r.kind !== 'relation' && r.kind !== 'item') continue;
      const entities = entitiesByProposal.get(r.proposalId) ?? new Map<string, ProposalEntityView>();
      keys.add(rejectionKey(r.kind, r.payload as unknown as RelationPayload | ItemPayload, entities));
    }
    return keys;
  }
}
