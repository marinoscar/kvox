// =============================================================================
// Proposal pipeline stages (#363, epic #346; docs/specs/ontology.md §6–§8)
// =============================================================================
//
// `kg.extract` writes the model's validated rows as proposal items, then runs
// every registered stage IN ORDER over them before the pre-check decides what
// is ticked. This issue ships the seam and registers nothing:
//
//   #364 → `resolution`        (order 100)
//   #365 → `work-item-dedup`   (order 200), `temporal-closing` (300),
//          `rejection-memory`  (400)
//
// A stage self-registers from `onModuleInit`, the same shape job handlers use.
// A stage that throws `RateLimitError` defers the whole job (the handler
// rethrows it); any other throw fails the proposal with a message naming the
// stage. A stage writes ONLY `kg_proposal_items` rows of `ctx.proposalId` and
// their `kg_evidence` rows — never the graph itself (§8: nothing enters the
// graph except through a reviewed commit).
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import type { AiModelResolution } from '../../ai/ai-task-model-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { GraphPreferences } from '../preferences/graph-preferences.defaults';

/** The resolver's result — named as the spec names it. */
export type ResolvedTaskModel = AiModelResolution;

export interface ProposalStageContext {
  proposalId: string;
  userId: string;
  noteId: string;
  /** #369 — thresholds, resolution mode, adjudication switch. */
  preferences: GraphPreferences;
  /** Resolver result for `graph.adjudicate`; null — a stage resolves lazily. */
  ai: ResolvedTaskModel | null;
  /** Stages write only `kg_proposal_items` / their evidence. */
  prisma: PrismaService;
  /** Merged into `kg_proposals.stats.<stageName>`. */
  stats: Record<string, unknown>;
}

export interface ProposalStage {
  readonly name: string;
  readonly order: number;
  run(ctx: ProposalStageContext): Promise<void>;
}

@Injectable()
export class ProposalStageRegistry {
  private readonly logger = new Logger(ProposalStageRegistry.name);
  private readonly stages = new Map<string, ProposalStage>();

  /** A second stage with the same name replaces the first, with a warning. */
  register(stage: ProposalStage): void {
    if (this.stages.has(stage.name)) {
      this.logger.warn(`Proposal stage '${stage.name}' registered twice; the later registration wins`);
    }
    this.stages.set(stage.name, stage);
  }

  /** Every stage, ascending `order`, ties broken by name so the order is total. */
  ordered(): ProposalStage[] {
    return [...this.stages.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }
}
