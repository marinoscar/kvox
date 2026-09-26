// =============================================================================
// The `temporal-closing` proposal stage (issue #365; docs/specs/ontology.md
// §5.4 closing / out-of-order / overlap rules, §7 "Closing a temporal edge is
// a proposal row")
// =============================================================================
//
// Order 300. For every proposed relation whose type the caller's EFFECTIVE
// schema declares `temporal: true, exclusive: 'soft'` (never a hardcoded list)
// and whose source is an existing entity, ask #353's `planTemporalInsert`
// against that entity's live edges of the type (`exclusiveScope: 'from_to'` —
// HAS_ROLE — narrows it to the same organization):
//
//   closes      → one `closing` row per closed edge: `origin: 'ai'`, NEVER
//                 pre-checked, citing copies of the new relation's evidence
//   flags       → `overlaps` / `unordered` copied onto the relation row
//   candidateTo → `dedup.candidateTo` (#353 rule 5: an older open fact is
//                 committed already closed at the next edge's start)
//   WORKS_FOR   → the person's open commitments listed on the closing, flagged
//                 `closing_affects_commitments` (§5.4's company change);
//                 PersonFacts are untouched
//
// A relation `work-item-dedup` already found `known` is skipped: it adds
// evidence to an edge, it opens nothing. Re-running the stage replaces its
// own earlier closing rows, so it is idempotent. Nothing here writes the graph.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ProposalStageRegistry, type ProposalStage, type ProposalStageContext } from '../extraction/proposal-stage';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import type { ClosingPayload, RelationDedup } from '../proposals/proposal-payload.schema';
import { commitmentsToReview, planTemporalInsert, type TemporalEdge } from '../temporal';
import {
  TEMPORAL_CLOSING_STAGE,
  candidateEdge,
  existingId,
  isExclusiveTemporal,
  isoDay,
  placeholderId,
  resolveEndpoint,
  ruleForEffectiveRelation,
} from './dedup-core';
import { ItemCandidateService, type ExistingItemRow } from './item-candidates.service';
import { asJson, loadProposalRows } from './proposal-rows';

export interface TemporalClosingStats {
  planned: number;
  closings: number;
  overlaps: number;
  unordered: number;
  selfClosed: number;
  affectedCommitments: number;
  ms: number;
}

@Injectable()
export class TemporalClosingStage implements ProposalStage, OnModuleInit {
  readonly name = TEMPORAL_CLOSING_STAGE.name;
  readonly order = TEMPORAL_CLOSING_STAGE.order;
  private readonly logger = new Logger(TemporalClosingStage.name);

  constructor(
    private readonly registry: ProposalStageRegistry,
    private readonly ontology: GraphOntologyService,
    private readonly graph: ItemCandidateService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(ctx: ProposalStageContext): Promise<void> {
    const started = Date.now();
    const { userId, proposalId } = ctx;
    const stats: TemporalClosingStats = { planned: 0, closings: 0, overlaps: 0, unordered: 0, selfClosed: 0, affectedCommitments: 0, ms: 0 };

    await this.removeOwnClosings(ctx);
    const rows = await loadProposalRows(ctx.prisma, proposalId);
    const schema = await this.ontology.effectiveSchemaFor(userId);

    const closedEdgeIds = new Set<string>();
    const edgeCache = new Map<string, TemporalEdge[]>();
    const commitmentCache = new Map<string, ExistingItemRow[]>();
    let sortOrder = rows.maxSortOrder;

    for (const row of rows.relations) {
      const p = row.payload;
      if (p.dedup?.verdict === 'known') continue;
      const type = schema.relationType(p.type);
      if (!type) continue;
      const rule = ruleForEffectiveRelation(type);
      if (!isExclusiveTemporal(rule)) continue;
      const fromId = existingId(resolveEndpoint(p.from, rows.entities));
      if (!fromId) continue; // a proposal-new person has no edges to close

      stats.planned += 1;
      const key = `${p.type}|${fromId}`;
      if (!edgeCache.has(key)) edgeCache.set(key, await this.graph.liveEdges(userId, p.type, fromId));
      const edges = edgeCache.get(key)!;
      const candidate = candidateEdge(p, fromId, placeholderId(resolveEndpoint(p.to, rows.entities)), rule);
      const plan = planTemporalInsert(edges, candidate, rule);
      if (plan.action !== 'create') continue;

      // Flags and the self-close go onto the relation row itself.
      const add = plan.flags.filter((f) => f === 'overlaps' || f === 'unordered');
      if (add.includes('overlaps')) stats.overlaps += 1;
      if (add.includes('unordered')) stats.unordered += 1;
      let dedup: RelationDedup | null | undefined = p.dedup;
      if (plan.candidateTo) {
        stats.selfClosed += 1;
        dedup = { verdict: 'new', targetRelationId: null, ...(dedup ?? {}), candidateTo: isoDay(plan.candidateTo) };
      }
      if (add.length > 0 || plan.candidateTo) {
        await ctx.prisma.kgProposalItem.update({
          where: { id: row.id },
          data: { flags: [...new Set([...row.flags, ...add])], payload: asJson({ ...p, dedup }) },
        });
      }

      // One `closing` row per closed edge (an edge two new facts would close is
      // proposed once — by the first).
      if (plan.closes.length === 0) continue;
      const evidence = await ctx.prisma.kgEvidence.findMany({
        where: { ownerId: userId, subjectKind: 'proposal_item', subjectId: row.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const close of plan.closes) {
        if (closedEdgeIds.has(close.edgeId)) continue;
        const edge = edges.find((e) => e.id === close.edgeId);
        if (!edge || candidate.precision === 'unknown') continue;
        closedEdgeIds.add(close.edgeId);

        if (!commitmentCache.has(edge.fromId)) {
          commitmentCache.set(edge.fromId, await this.graph.openCommitments(userId, edge.fromId));
        }
        const open = commitmentCache.get(edge.fromId)!;
        const reviewIds = new Set(commitmentsToReview({ ...plan, closes: [close] }, [edge], open));
        const affected: ClosingPayload['affectedCommitments'] = open
          .filter((c) => reviewIds.has(c.id))
          .map((c) => ({
            itemId: c.id,
            title: (c.title?.trim() || c.statement).slice(0, 200),
            role: c.ownerPersonId === edge.fromId ? ('owner' as const) : ('counterparty' as const),
          }));
        stats.affectedCommitments += affected.length;

        const labels = await this.graph.entityLabels(userId, [edge.fromId, edge.toId]);
        const title = edge.props.title;
        const payload: ClosingPayload = {
          relationId: edge.id,
          relationType: edge.type,
          fromLabel: labels.get(edge.fromId)?.label ?? '',
          toLabel: labels.get(edge.toId)?.label ?? '',
          roleTitle: typeof title === 'string' && title.trim() ? title.trim() : null,
          previousValid: {
            from: edge.valid?.from ? isoDay(edge.valid.from) : null,
            to: edge.valid?.to ? isoDay(edge.valid.to) : null,
            precision: edge.precision ?? 'unknown',
          },
          closeAt: isoDay(close.newTo),
          precision: candidate.precision,
          closedByRef: p.ref,
          affectedCommitments: affected,
        };

        sortOrder += 1;
        const created = await ctx.prisma.kgProposalItem.create({
          data: {
            proposalId,
            kind: 'closing',
            payload: asJson(payload),
            flags: affected.length > 0 ? ['closing_affects_commitments'] : [],
            decision: 'pending',
            origin: 'ai',
            sortOrder,
          },
          select: { id: true },
        });
        if (evidence.length > 0) {
          await ctx.prisma.kgEvidence.createMany({
            data: evidence.map(({ id: _id, createdAt: _c, subjectId: _s, ...rest }) => ({ ...rest, subjectId: created.id })),
          });
        }
        stats.closings += 1;
      }
    }

    stats.ms = Date.now() - started;
    Object.assign(ctx.stats, stats);
    this.logger.log(
      `kg.stage ${this.name} proposal=${proposalId} known=0 same=0 supersedes=0 closings=${stats.closings} ` +
        `overlaps=${stats.overlaps} suppressed=0 ms=${stats.ms}`,
    );
  }

  /** This stage's own earlier closing rows (an AI closing), with their evidence. */
  private async removeOwnClosings(ctx: ProposalStageContext): Promise<void> {
    const old = await ctx.prisma.kgProposalItem.findMany({
      where: { proposalId: ctx.proposalId, kind: 'closing', origin: 'ai' },
      select: { id: true },
    });
    if (old.length === 0) return;
    const ids = old.map((o) => o.id);
    await ctx.prisma.kgEvidence.deleteMany({ where: { subjectKind: 'proposal_item', subjectId: { in: ids } } });
    await ctx.prisma.kgProposalItem.deleteMany({ where: { id: { in: ids } } });
  }
}
