// =============================================================================
// kg.resolve (#364, epic #346; docs/specs/ontology.md §7, §11)
// =============================================================================
//
// The BULK re-scan: committed entities resolved against each other, for a
// threshold change, a reversed merge, or on request. Its ONLY output is a
// `resolution` proposal (`kind: 'resolution'`, no note, `draft`) of suggested
// merges for a person to review — it never merges anything itself, because
// curated entities are never auto-merged with each other (§7: two things a
// human confirmed separately need a human to join them). #366's commit
// dispatches each `merge_into` decision to `MergeService.merge(existingEntityId
// → mergeIntoId)` and each `reject` to `DistinctPairService.record`.
//
//   profile   { maxRuntimeMs: 20 min, maxAttempts: 1 } — a retry would re-spend
//             the user's key on adjudication for a non-deterministic answer
//   server-only the user's own AI key (the `note.generate` argument)
//   throttle  `aiProviderThrottleKey(userId)` before any adjudication call
//   subject   `user` / userId — ordinary dedup, one scan per user at a time
//   payload   { userId, scope: 'all' | 'entity', entityId?, reason }
//
// `scope: 'all'` scans at most 2 000 live entities (most recently updated
// first) and records `stats.truncated` when there were more. Pairs already
// recorded as distinct, and pairs already suggested by an open `resolution`
// proposal, are skipped. Nothing scoring ≥ `newThreshold` → no proposal.
// The vector arm uses each entity's STORED profile vector (`kg.embed`); an
// entity without one is matched by name alone.
//
// ⚠ Logs carry ids and counts only.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, type Job } from '@prisma/client';
import { z } from 'zod';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { PrismaService } from '../../prisma/prisma.service';
import { KG_RESOLVE_JOB_TYPE } from '../job-types';
import { GraphPreferencesService } from '../preferences/graph-preferences.service';
import type { ProposalResolution } from '../proposals/proposal-payload.schema';
import type { AdjudicationPair } from '../resolution/adjudication-prompt';
import { AdjudicationService, type AdjudicationResult } from '../resolution/adjudication.service';
import type { ResolutionContext } from '../resolution/context-features.service';
import { orderPair } from '../resolution/distinct-pair.service';
import { decide, ResolutionService, type MentionOutcome, type MentionToRank } from '../resolution/resolution.service';

export const KG_RESOLVE_MAX_RUNTIME_MS = 20 * 60_000;
export const KG_RESOLVE_MAX_ENTITIES = 2_000;

const payloadSchema = z.object({
  userId: z.guid(),
  scope: z.enum(['all', 'entity']),
  entityId: z.guid().optional(),
  reason: z.enum(['threshold_change', 'merge_reversed', 'manual']),
});
export type KgResolvePayload = z.infer<typeof payloadSchema>;

export function readKgResolvePayload(payload: unknown): KgResolvePayload | null {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  if (parsed.data.scope === 'entity' && !parsed.data.entityId) return null;
  return parsed.data;
}

export interface KgResolveStats {
  scanned: number;
  suggested: number;
  adjudicated: number;
  truncated: boolean;
  reason: KgResolvePayload['reason'];
  adjudication?: string;
}

const LIVE = ['accepted', 'edited'] as const;

@Injectable()
export class KgResolveHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(KgResolveHandler.name);

  readonly type = KG_RESOLVE_JOB_TYPE;
  readonly profile: JobExecutionProfile = { maxRuntimeMs: KG_RESOLVE_MAX_RUNTIME_MS, maxAttempts: 1 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly preferences: GraphPreferencesService,
    private readonly resolution: ResolutionService,
    private readonly adjudication: AdjudicationService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = readKgResolvePayload(job.payload);
    if (!payload) {
      this.logger.warn(`${KG_RESOLVE_JOB_TYPE} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }
    const started = Date.now();
    const { userId } = payload;
    const thresholds = (await this.preferences.get(userId)).resolution;

    // --- which entities ------------------------------------------------------
    const entities = await this.prisma.kgEntity.findMany({
      where: {
        ownerId: userId,
        reviewStatus: { in: [...LIVE] },
        mergedIntoId: null,
        ...(payload.scope === 'entity' ? { id: payload.entityId } : {}),
      },
      select: { id: true, type: true, label: true, embeddingHash: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: KG_RESOLVE_MAX_ENTITIES + 1,
    });
    const truncated = entities.length > KG_RESOLVE_MAX_ENTITIES;
    const scan = entities.slice(0, KG_RESOLVE_MAX_ENTITIES);
    const stats: KgResolveStats = { scanned: scan.length, suggested: 0, adjudicated: 0, truncated, reason: payload.reason };
    if (scan.length === 0) {
      this.logger.log(`${KG_RESOLVE_JOB_TYPE} job ${job.id}: nothing to scan`);
      return;
    }

    const ids = scan.map((e) => e.id);
    const [aliases, contexts, openPairs] = await Promise.all([
      this.prisma.kgEntityAlias.findMany({ where: { entityId: { in: ids } }, select: { entityId: true, alias: true } }),
      this.contexts(userId, ids),
      this.openSuggestedPairs(userId),
    ]);

    // --- rank every entity against the rest ----------------------------------
    const mentions: MentionToRank[] = scan.map((e) => ({
      key: e.id,
      type: e.type,
      label: e.label,
      aliases: aliases.filter((a) => a.entityId === e.id).map((a) => a.alias),
      vectorOfEntityId: e.embeddingHash ? e.id : null,
      excludeIds: [e.id],
      context: contexts.get(e.id)!,
    }));
    const outcomes = await this.resolution.rankMentions(userId, mentions, thresholds);

    // --- one suggestion per unordered pair ------------------------------------
    const seen = new Set<string>(openPairs);
    const suggestions: Array<{ entity: (typeof scan)[number]; outcome: MentionOutcome }> = [];
    for (const e of scan) {
      const outcome = outcomes.get(e.id)!;
      const top = outcome.candidates[0];
      if (!top || outcome.band === 'new') continue;
      const key = orderPair(e.id, top.entityId).join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({ entity: e, outcome });
    }

    // --- adjudicate the middle band -------------------------------------------
    const middle = suggestions.filter((s) => s.outcome.band === 'middle');
    const verdicts = new Map<string, AdjudicationResult>();
    if (middle.length > 0 && thresholds.adjudication === 'llm') {
      const pairs = await this.buildPairs(userId, middle.map((s) => ({ entityId: s.entity.id, type: s.entity.type, candidateId: s.outcome.candidates[0].entityId })));
      const result = await this.resolution.adjudicateSafely(userId, pairs.pairs, KG_RESOLVE_JOB_TYPE);
      if (result.reason) stats.adjudication = `unavailable:${result.reason}`;
      for (const [pairId, v] of result.verdicts ?? []) verdicts.set(pairs.entityByPair.get(pairId)!, v);
      stats.adjudicated = result.verdicts?.size ?? 0;
    } else if (middle.length > 0) {
      stats.adjudication = 'off';
    }

    // --- the proposal ---------------------------------------------------------
    const rows: Array<{ payload: Record<string, unknown>; resolution: ProposalResolution; flags: string[] }> = [];
    for (const s of suggestions) {
      const verdict = verdicts.get(s.entity.id) ?? null;
      if (verdict?.verdict === 'different') continue; // judged not the same: nothing to suggest
      const decision = decide(s.outcome, thresholds, verdict);
      // A bulk suggestion always names its candidate, so the reviewer sees what to merge into.
      const resolution: ProposalResolution = decision.resolution.ref
        ? decision.resolution
        : { ...decision.resolution, ref: s.outcome.candidates[0].entityId };
      rows.push({
        payload: {
          ref: `x${rows.length + 1}`,
          type: s.entity.type,
          label: s.entity.label,
          aliases: [],
          props: {},
          existingEntityId: s.entity.id,
        },
        resolution,
        flags: [...new Set([...decision.flags, 'possible_duplicate'])],
      });
    }
    stats.suggested = rows.length;

    if (rows.length === 0) {
      this.logger.log(
        `${KG_RESOLVE_JOB_TYPE} job ${job.id} user=${userId} scanned=${stats.scanned} suggested=0 ms=${Date.now() - started}`,
      );
      return;
    }

    const proposal = await this.prisma.$transaction(async (tx) => {
      const created = await tx.kgProposal.create({
        data: {
          ownerId: userId,
          kind: 'resolution',
          status: 'draft',
          jobId: job.id,
          stats: { phase: 'ready', truncated, resolution: stats } as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.kgProposalItem.createMany({
        data: rows.map((row, i) => ({
          proposalId: created.id,
          kind: 'entity' as const,
          payload: row.payload as Prisma.InputJsonValue,
          resolution: row.resolution as unknown as Prisma.InputJsonValue,
          flags: row.flags,
          decision: 'pending' as const,
          origin: 'ai' as const,
          sortOrder: i,
        })),
      });
      return created;
    });

    this.logger.log(
      `${KG_RESOLVE_JOB_TYPE} job ${job.id} user=${userId} proposal=${proposal.id} scanned=${stats.scanned} ` +
        `suggested=${stats.suggested} adjudicated=${stats.adjudicated} truncated=${truncated} ms=${Date.now() - started}`,
    );
  }

  /** Per entity: the meetings it attended, its organizations, its neighbours. */
  private async contexts(ownerId: string, ids: string[]): Promise<Map<string, ResolutionContext>> {
    const edges = await this.prisma.kgRelation.findMany({
      where: { ownerId, reviewStatus: { in: [...LIVE] }, OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] },
      select: { type: true, fromId: true, toId: true },
    });
    const out = new Map<string, { meetingIds: Set<string>; orgIds: Set<string>; neighbourIds: Set<string> }>(
      ids.map((id) => [id, { meetingIds: new Set(), orgIds: new Set(), neighbourIds: new Set() }]),
    );
    for (const r of edges) {
      const from = r.fromId ? out.get(r.fromId) : undefined;
      if (from) {
        if (r.type === 'ATTENDED') from.meetingIds.add(r.toId);
        else if (r.type === 'WORKS_FOR' || r.type === 'HAS_ROLE') from.orgIds.add(r.toId);
        else from.neighbourIds.add(r.toId);
      }
      const to = out.get(r.toId);
      if (to && r.fromId) to.neighbourIds.add(r.fromId);
    }
    return new Map(
      [...out].map(([id, c]) => [id, { speakerPersonIds: new Set<string>(), orgNames: new Set<string>(), ...c }]),
    );
  }

  /** Pairs an open (draft) resolution proposal already suggests, as `a:b` keys. */
  private async openSuggestedPairs(ownerId: string): Promise<string[]> {
    const items = await this.prisma.kgProposalItem.findMany({
      where: { proposal: { ownerId, kind: 'resolution', status: 'draft' }, kind: 'entity' },
      select: { payload: true, resolution: true },
    });
    const out: string[] = [];
    for (const item of items) {
      const existing = (item.payload as { existingEntityId?: unknown } | null)?.existingEntityId;
      const res = item.resolution as { ref?: unknown; candidates?: Array<{ entityId?: unknown }> } | null;
      const other = typeof res?.ref === 'string' ? res.ref : res?.candidates?.[0]?.entityId;
      if (typeof existing === 'string' && typeof other === 'string') out.push(orderPair(existing, other).join(':'));
    }
    return out;
  }

  /** Both sides are committed entities: two candidate dossiers per pair. */
  private async buildPairs(
    ownerId: string,
    wanted: Array<{ entityId: string; type: string; candidateId: string }>,
  ): Promise<{ pairs: AdjudicationPair[]; entityByPair: Map<string, string> }> {
    const dossiers = await this.adjudication.buildCandidateDossiers(ownerId, wanted.flatMap((w) => [w.entityId, w.candidateId]));
    const pairs: AdjudicationPair[] = [];
    const entityByPair = new Map<string, string>();
    for (const w of wanted) {
      const mention = dossiers.get(w.entityId);
      const candidate = dossiers.get(w.candidateId);
      if (!mention || !candidate) continue;
      const pairId = `p${pairs.length + 1}`;
      entityByPair.set(pairId, w.entityId);
      pairs.push({
        pairId,
        type: w.type,
        mention: { label: mention.label, aliases: mention.aliases, props: mention.props, quotes: mention.quotes },
        candidate,
      });
    }
    return { pairs, entityByPair };
  }
}
