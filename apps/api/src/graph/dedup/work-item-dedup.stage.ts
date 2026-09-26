// =============================================================================
// The `work-item-dedup` proposal stage (issue #365; docs/specs/ontology.md
// §5.4, §7 "Work-item dedup", §8 "Known, skipped")
// =============================================================================
//
// Order 200 — after #364's `resolution` (100), because an item's subject and a
// relation's endpoints must be resolved before either can be matched.
//
// Items:
//   1. subject is a proposal-new entity  → `new` (nothing to match against)
//   2. same kind + subject + statement hash as a live item → `known`, flag
//      `known` (pre-accepted, collapsed; the commit only appends evidence)
//   3. a `sensitive` PersonFact stops here → `new` (never sent to a model, §5.6)
//   4. candidates: live, same kind + subject (+ owner for a commitment),
//      cosine ≥ 0.80 against the proposed text embedded on the fly (ONE
//      batched embed call per proposal), else token-set Jaccard ≥ 0.5 — top 5
//   5. adjudication (`graph.adjudicate`) → same / supersedes / new, mapped by
//      `mapItemVerdicts`; adjudication off or unavailable → `new` pointing at
//      the best candidate, flagged `possible_duplicate`
// Relations:
//   6. both endpoints existing and #353's planner says `attach_evidence` →
//      `known`, flag `known`; otherwise `new`
//
// Soft failures (no embedding key, adjudication refused) DEGRADE and are
// recorded in stats; a `RateLimitError` propagates and defers `kg.extract`.
// ⚠ Logs carry ids and counts only.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { RateLimitError } from '../../jobs/rate-limit.error';
import { ProposalStageRegistry, type ProposalStage, type ProposalStageContext } from '../extraction/proposal-stage';
import { KG_EXTRACT_JOB_TYPE } from '../job-types';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import type { ItemDedup, ItemPayload, RelationDedup } from '../proposals/proposal-payload.schema';
import { AdjudicationService } from '../resolution/adjudication.service';
import { buildItemProfileText } from '../resolution/profile-text';
import { ResolutionService } from '../resolution/resolution.service';
import {
  WORK_ITEM_DEDUP_STAGE,
  existingId,
  mapItemVerdicts,
  relationKnown,
  resolveEndpoint,
  ruleForEffectiveRelation,
  selectCandidates,
  type ItemAdjudication,
} from './dedup-core';
import type { ItemAdjudicationPair } from './item-adjudication-prompt';
import { ItemCandidateService, type ItemCandidateResult } from './item-candidates.service';
import { asJson, loadProposalRows, type ProposalRow } from './proposal-rows';

export interface WorkItemDedupStats {
  items: number;
  relations: number;
  known: number;
  same: number;
  supersedes: number;
  new: number;
  possibleDuplicates: number;
  adjudicated: number;
  /** `'lexical'` when no embedding was available for this proposal. */
  fallback?: 'lexical';
  embedding?: string;
  adjudication?: string;
  ms: number;
}

interface PendingItem {
  row: ProposalRow<ItemPayload>;
  subjectId: string | null;
  ownerPersonId: string | null;
  text: string;
  candidates: ItemCandidateResult[];
}

@Injectable()
export class WorkItemDedupStage implements ProposalStage, OnModuleInit {
  readonly name = WORK_ITEM_DEDUP_STAGE.name;
  readonly order = WORK_ITEM_DEDUP_STAGE.order;
  private readonly logger = new Logger(WorkItemDedupStage.name);

  constructor(
    private readonly registry: ProposalStageRegistry,
    private readonly ontology: GraphOntologyService,
    private readonly candidates: ItemCandidateService,
    private readonly resolution: ResolutionService,
    private readonly adjudication: AdjudicationService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(ctx: ProposalStageContext): Promise<void> {
    const started = Date.now();
    const { userId, proposalId } = ctx;
    const stats: WorkItemDedupStats = {
      items: 0, relations: 0, known: 0, same: 0, supersedes: 0, new: 0, possibleDuplicates: 0, adjudicated: 0, ms: 0,
    };
    const rows = await loadProposalRows(ctx.prisma, proposalId);
    const schema = await this.ontology.effectiveSchemaFor(userId);

    // ---- Relations: known or new ------------------------------------------------
    for (const row of rows.relations) {
      stats.relations += 1;
      const p = row.payload;
      const fromId = existingId(resolveEndpoint(p.from, rows.entities));
      const toId = existingId(resolveEndpoint(p.to, rows.entities));
      const type = schema.relationType(p.type);
      let dedup: RelationDedup = { verdict: 'new', targetRelationId: null, candidateTo: null };
      if (fromId && toId && type) {
        const known = relationKnown(await this.candidates.liveEdges(userId, p.type, fromId), p, fromId, toId, ruleForEffectiveRelation(type));
        if (known.known) dedup = { verdict: 'known', targetRelationId: known.edgeId, candidateTo: null };
      }
      if (dedup.verdict === 'known') stats.known += 1;
      await this.write(ctx, row, { ...p, dedup }, dedup.verdict === 'known' ? ['known'] : []);
    }

    // ---- Items: known by hash, else candidates ------------------------------------
    const pending: PendingItem[] = [];
    const subjectLabelIds: string[] = [];
    for (const row of rows.items) {
      stats.items += 1;
      const p = row.payload;
      const subject = resolveEndpoint(p.subject, rows.entities);
      if (subject.kind === 'new') {
        stats.new += 1;
        await this.write(ctx, row, { ...p, dedup: newDedup() }, []);
        continue;
      }
      const subjectId = existingId(subject);
      const knownId = await this.candidates.knownItem(userId, { kind: p.kind, subjectId, statementHash: p.statementHash });
      if (knownId) {
        stats.known += 1;
        await this.write(ctx, row, { ...p, dedup: { ...newDedup(), verdict: 'known', targetItemId: knownId } }, ['known']);
        continue;
      }
      const owner = resolveEndpoint(p.owner, rows.entities);
      if ((p.kind === 'person_fact' && p.sensitivity === 'sensitive') || (p.kind === 'commitment' && owner.kind === 'new')) {
        stats.new += 1;
        await this.write(ctx, row, { ...p, dedup: newDedup() }, []);
        continue;
      }
      if (subjectId) subjectLabelIds.push(subjectId);
      pending.push({ row, subjectId, ownerPersonId: existingId(owner), text: '', candidates: [] });
    }

    // One batched embedding call for every pending item.
    const labels = await this.candidates.entityLabels(userId, subjectLabelIds);
    for (const item of pending) {
      const p = item.row.payload;
      item.text = buildItemProfileText({
        kind: p.kind,
        title: p.title,
        statement: p.statement,
        subjectLabel: item.subjectId ? (labels.get(item.subjectId)?.label ?? null) : null,
      });
    }
    const embedded = await this.resolution.embedMentions(userId, pending.map((i) => i.text), KG_EXTRACT_JOB_TYPE);
    if (pending.length > 0 && embedded.vectorArm !== 'ok') {
      stats.fallback = 'lexical';
      stats.embedding = embedded.vectorArm;
    }
    for (const [i, item] of pending.entries()) {
      const all = await this.candidates.itemCandidates(userId, {
        kind: item.row.payload.kind,
        subjectId: item.subjectId,
        ownerPersonId: item.ownerPersonId,
        statement: item.row.payload.statement,
        vector: embedded.vectors[i] ?? null,
      });
      const keep = new Set(selectCandidates(all).map((c) => c.itemId));
      item.candidates = all.filter((c) => keep.has(c.itemId));
    }

    // Adjudicate every (item, candidate) pair in one batched pass.
    const withCandidates = pending.filter((i) => i.candidates.length > 0);
    let verdicts: Map<string, ItemAdjudication & { model: string }> | null = null;
    let unavailable: string | null = null;
    const pairIndex = new Map<string, { rowId: string; itemId: string }>();
    if (withCandidates.length > 0 && ctx.preferences.resolution.adjudication === 'llm') {
      const pairs = await this.buildPairs(userId, withCandidates, labels, pairIndex);
      try {
        verdicts = await this.adjudication.adjudicateItems(userId, pairs, { jobType: KG_EXTRACT_JOB_TYPE });
        stats.adjudicated = pairs.length;
      } catch (error) {
        if (error instanceof RateLimitError) throw error;
        unavailable =
          (error as { getResponse?: () => { details?: { reason?: string } } }).getResponse?.()?.details?.reason ??
          (error instanceof Error ? error.name : 'error');
        stats.adjudication = `unavailable:${unavailable}`;
        this.logger.warn(`Item adjudication unavailable for user ${userId}: ${unavailable}`);
      }
    } else if (withCandidates.length > 0) {
      unavailable = 'adjudication off';
      stats.adjudication = 'off';
    }

    for (const item of pending) {
      let byItem: Map<string, ItemAdjudication> | null = null;
      if (verdicts) {
        byItem = new Map();
        for (const [pairId, v] of verdicts) {
          const at = pairIndex.get(pairId);
          if (at && at.rowId === item.row.id) byItem.set(at.itemId, v);
        }
      }
      const mapped = mapItemVerdicts(item.row.payload.kind, item.candidates, byItem, unavailable);
      stats[mapped.dedup.verdict] += 1;
      if (mapped.flags.includes('possible_duplicate')) stats.possibleDuplicates += 1;
      await this.write(ctx, item.row, { ...item.row.payload, dedup: mapped.dedup }, mapped.flags);
    }

    stats.ms = Date.now() - started;
    Object.assign(ctx.stats, stats);
    this.logger.log(
      `kg.stage ${this.name} proposal=${proposalId} known=${stats.known} same=${stats.same} ` +
        `supersedes=${stats.supersedes} closings=0 overlaps=0 suppressed=0 ms=${stats.ms}`,
    );
  }

  private async buildPairs(
    userId: string,
    items: readonly PendingItem[],
    subjectLabels: ReadonlyMap<string, { label: string; type: string }>,
    pairIndex: Map<string, { rowId: string; itemId: string }>,
  ): Promise<ItemAdjudicationPair[]> {
    const ownerIds = new Set<string>();
    for (const item of items) {
      if (item.ownerPersonId) ownerIds.add(item.ownerPersonId);
      for (const c of item.candidates) if (c.row.ownerPersonId) ownerIds.add(c.row.ownerPersonId);
    }
    const [owners, quotes] = await Promise.all([
      this.candidates.entityLabels(userId, [...ownerIds]),
      this.candidates.proposalQuotes(userId, items.map((i) => i.row.id)),
    ]);
    const pairs: ItemAdjudicationPair[] = [];
    for (const item of items) {
      const p = item.row.payload;
      for (const c of item.candidates) {
        const pairId = `p${pairs.length + 1}`;
        pairIndex.set(pairId, { rowId: item.row.id, itemId: c.itemId });
        pairs.push({
          pairId,
          kind: p.kind,
          subjectType: item.subjectId ? (subjectLabels.get(item.subjectId)?.type ?? null) : null,
          proposed: {
            title: p.title,
            statement: p.statement,
            occurredAt: p.occurredAt,
            dueAt: p.dueAt,
            ownerLabel: item.ownerPersonId ? (owners.get(item.ownerPersonId)?.label ?? null) : null,
            quotes: quotes.get(item.row.id) ?? [],
          },
          existing: {
            title: c.row.title,
            statement: c.row.statement,
            occurredAt: c.row.occurredAt,
            dueAt: c.row.dueAt,
            status: c.row.status,
            ownerLabel: c.row.ownerPersonId ? (owners.get(c.row.ownerPersonId)?.label ?? null) : null,
          },
        });
      }
    }
    return pairs;
  }

  private async write(
    ctx: ProposalStageContext,
    row: ProposalRow<unknown>,
    payload: unknown,
    add: readonly string[],
  ): Promise<void> {
    const flags = [...new Set([...row.flags, ...add])];
    await ctx.prisma.kgProposalItem.update({
      where: { id: row.id },
      data: {
        payload: asJson(payload),
        flags,
        // The pre-check (#363) runs after every stage and decides; this is the
        // stage's own intent, so a reader between stages sees it too.
        ...(add.includes('known') ? { decision: 'accept' as const } : {}),
      },
    });
  }
}

function newDedup(): ItemDedup {
  return { verdict: 'new', targetItemId: null, changes: {}, rationale: null, score: null };
}
