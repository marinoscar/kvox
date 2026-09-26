// =============================================================================
// ResolutionService (#364, epic #346; docs/specs/ontology.md §4, §7, §8, §19)
// =============================================================================
//
// Links a mention to an existing entity, or says it is new — and says WHY
// (`resolution.candidates[].signals`). Two callers:
//
//   PROPOSAL MODE — `resolveProposal(ctx)`, the `resolution` stage (order 100)
//   inside `kg.extract`. Writes `kg_proposal_items.resolution` (#363's schema)
//   and flags for every entity row; never the graph (§8).
//
//     speaker-identified Person   → { ref, score: 1, source: 'speaker' }
//     top ≥ autoLinkThreshold     → linked, source = the arm that found it
//     top < newThreshold / none   → new
//     between                     → adjudication (`graph.adjudicate`) when
//                                   `adjudication: 'llm'`, else new +
//                                   `possible_duplicate`
//       same      → linked, score = max(score, autoLinkThreshold), 'adjudication'
//       different → new
//       uncertain → linked + `possible_duplicate` (never pre-checked)
//
//   A `model_claimed_match` row (the model named a `k#`) is scored exactly like
//   any other: the claim adds nothing. `review_all` changes nothing here — it
//   only changes the pre-check, which runs after every stage.
//
//   BULK MODE — `rankMentions` / `decide`, shared with `kg.resolve`.
//
// A stage failure other than a rate limit fails the extraction (#363), so the
// soft failures here — no embedding key, an adjudication the resolver refuses —
// DEGRADE (recorded in stats) rather than throw. A `RateLimitError` from an
// embedding or adjudication call is rethrown: it defers the whole job.
//
// ⚠ One log line per run, ids and counts only — never a label or a quote.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { RateLimitError } from '../../jobs/rate-limit.error';
import { aiProviderThrottleKey } from '../../notes/job-types';
import { PrismaService } from '../../prisma/prisma.service';
import { defaultSpeakerName, parseSpeakerIdentities } from '../../transcripts/editing/speaker-identity';
import { normalizeForMatch } from '../extraction/extraction-context';
import type { ProposalStageContext } from '../extraction/proposal-stage';
import type { GraphPreferences } from '../preferences/graph-preferences.defaults';
import type {
  EndpointRef,
  EntityPayload,
  ProposalItemFlag,
  ProposalResolution,
} from '../proposals/proposal-payload.schema';
import { normalizeAlias } from '../write/normalize';
import type { AdjudicationPair } from './adjudication-prompt';
import { AdjudicationService, type AdjudicationResult } from './adjudication.service';
import { CandidateService, type CandidateMention } from './candidate.service';
import { ContextFeatureService, type ResolutionContext } from './context-features.service';
import { GraphEmbedder } from './graph-embedder.service';
import { buildEntityProfileText } from './profile-text';
import {
  bandFor,
  rankCandidates,
  scoreCandidate,
  sourceForArm,
  type Band,
  type RankedCandidate,
} from './score';

export const RESOLUTION_STAGE_NAME = 'resolution';
export const RESOLUTION_STAGE_ORDER = 100;
export const MAX_RESOLUTION_CANDIDATES = 10;

type Thresholds = GraphPreferences['resolution'];

export interface RankedMentionCandidate extends RankedCandidate {
  label: string;
  type: string;
}

export interface MentionOutcome {
  candidates: RankedMentionCandidate[];
  ambiguous: boolean;
  band: Band;
}

export interface MentionToRank extends CandidateMention {
  key: string;
  context: ResolutionContext;
}

export interface ResolutionStats {
  entities: number;
  linked: number;
  new: number;
  adjudicated: number;
  uncertain: number;
  speaker: number;
  vectorArm: string;
  adjudication?: string;
  ms: number;
}

/** A decided row: the resolution to store and the flags to add. */
export interface Decision {
  resolution: ProposalResolution;
  flags: ProposalItemFlag[];
}

/**
 * PURE. The outcome for one mention, given its ranked candidates and — for the
 * middle band — an adjudication verdict (null when adjudication did not run).
 */
export function decide(outcome: MentionOutcome, thresholds: Thresholds, verdict: AdjudicationResult | null): Decision {
  const top = outcome.candidates[0] ?? null;
  const candidates = outcome.candidates.slice(0, MAX_RESOLUTION_CANDIDATES).map((c) => ({
    entityId: c.entityId,
    label: c.label,
    type: c.type,
    score: c.score,
    signals: [...c.signals],
  }));
  const flags: ProposalItemFlag[] = outcome.ambiguous ? ['ambiguous'] : [];
  const base = { candidates, adjudication: null } as const;

  if (!top || outcome.band === 'new') {
    return { resolution: { ref: null, score: top?.score ?? null, source: null, ...base }, flags };
  }
  if (outcome.band === 'link') {
    return { resolution: { ref: top.entityId, score: top.score, source: sourceForArm(top.arm), ...base }, flags };
  }
  if (!verdict) {
    return { resolution: { ref: null, score: top.score, source: null, ...base }, flags: [...flags, 'possible_duplicate'] };
  }
  const adjudication = { verdict: verdict.verdict, rationale: verdict.rationale.slice(0, 500), model: verdict.model };
  switch (verdict.verdict) {
    case 'same':
      return {
        resolution: {
          ref: top.entityId,
          score: Math.max(top.score, thresholds.autoLinkThreshold),
          source: 'adjudication',
          candidates,
          adjudication,
        },
        flags,
      };
    case 'different':
      return { resolution: { ref: null, score: top.score, source: null, candidates, adjudication }, flags };
    default:
      return {
        resolution: { ref: top.entityId, score: top.score, source: sourceForArm(top.arm), candidates, adjudication },
        flags: [...flags, 'possible_duplicate'],
      };
  }
}

interface EntityRow {
  id: string;
  payload: EntityPayload;
  resolution: ProposalResolution | null;
  flags: string[];
  distinctFrom: string[];
}

@Injectable()
export class ResolutionService {
  private readonly logger = new Logger(ResolutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly candidates: CandidateService,
    private readonly features: ContextFeatureService,
    private readonly embedder: GraphEmbedder,
    private readonly adjudication: AdjudicationService,
    private readonly throttle: ProviderThrottleService,
  ) {}

  // ===========================================================================
  // Shared: rank a batch of mentions
  // ===========================================================================

  async rankMentions(
    ownerId: string,
    mentions: readonly MentionToRank[],
    thresholds: Thresholds,
  ): Promise<Map<string, MentionOutcome>> {
    const out = new Map<string, MentionOutcome>();
    for (const mention of mentions) {
      const raw = await this.candidates.forMention(ownerId, mention);
      const feats = await this.features.features(
        ownerId,
        raw.map((r) => r.entityId),
        mention.context,
      );
      const scored: RankedMentionCandidate[] = raw.map((r) => {
        const f = feats.get(r.entityId)!;
        const s = scoreCandidate({ aliasExact: r.aliasExact, trigram: r.trigram, cosine: r.cosine, ...f });
        return { entityId: r.entityId, label: r.label, type: r.type, ...s };
      });
      const ranked = rankCandidates(scored, thresholds);
      out.set(mention.key, {
        candidates: ranked.candidates,
        ambiguous: ranked.ambiguous,
        band: bandFor(ranked.candidates[0]?.score ?? null, thresholds),
      });
    }
    return out;
  }

  /**
   * Embed profile texts for arm C. `null` vectors with the reason when the
   * caller cannot embed; a provider failure other than a rate limit also
   * degrades (recorded) — arm C is an over-generator, never a requirement.
   */
  async embedMentions(
    userId: string,
    texts: readonly string[],
    jobType: string,
  ): Promise<{ vectors: Array<{ values: number[]; model: string } | null>; vectorArm: string }> {
    const none = (reason: string) => ({ vectors: texts.map(() => null), vectorArm: `skipped:${reason}` });
    if (texts.length === 0) return { vectors: [], vectorArm: 'ok' };
    const embedder = await this.embedder.resolve(userId);
    if (!embedder.ok) return none(embedder.reason);
    try {
      this.throttle.registerProviderKey(jobType, aiProviderThrottleKey(userId));
      const vectors = await embedder.embed(texts);
      return { vectors: vectors.map((v) => ({ values: v, model: embedder.model })), vectorArm: 'ok' };
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      return none('embedding_failed');
    }
  }

  /**
   * Adjudicate the middle band. Returns null (and the reason) when adjudication
   * is switched off or the resolver/provider refuses; rethrows a rate limit.
   */
  async adjudicateSafely(
    userId: string,
    pairs: readonly AdjudicationPair[],
    jobType: string,
  ): Promise<{ verdicts: Map<string, AdjudicationResult> | null; reason: string | null }> {
    if (pairs.length === 0) return { verdicts: new Map(), reason: null };
    try {
      return { verdicts: await this.adjudication.adjudicate(userId, pairs, { jobType }), reason: null };
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      const reason =
        (error as { getResponse?: () => { details?: { reason?: string } } }).getResponse?.()?.details?.reason ??
        (error instanceof Error ? error.name : 'error');
      this.logger.warn(`Adjudication unavailable for user ${userId}: ${reason}`);
      return { verdicts: null, reason };
    }
  }

  // ===========================================================================
  // Proposal mode — the `resolution` stage
  // ===========================================================================

  async resolveProposal(ctx: ProposalStageContext, jobType: string): Promise<ResolutionStats> {
    const started = Date.now();
    const { proposalId, userId } = ctx;
    const thresholds = ctx.preferences.resolution;
    const stats: ResolutionStats = { entities: 0, linked: 0, new: 0, adjudicated: 0, uncertain: 0, speaker: 0, vectorArm: 'ok', ms: 0 };

    const items = await this.prisma.kgProposalItem.findMany({
      where: { proposalId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, kind: true, payload: true, resolution: true, flags: true, distinctFrom: true },
    });
    const entities: EntityRow[] = items
      .filter((i) => i.kind === 'entity')
      .map((i) => ({
        id: i.id,
        payload: i.payload as unknown as EntityPayload,
        resolution: (i.resolution ?? null) as ProposalResolution | null,
        flags: i.flags,
        distinctFrom: i.distinctFrom,
      }));
    const others = items
      .filter((i) => i.kind === 'relation' || i.kind === 'item')
      .map((i) => i.payload as Record<string, unknown>);
    // The deterministic Meeting row keeps what extraction decided (§6).
    const toResolve = entities.filter((e) => e.resolution?.source !== 'meeting' && e.payload.ref !== 'meeting');
    stats.entities = toResolve.length;

    const context = await this.proposalContext(userId, items.map((i) => i.id), entities, others);

    // Speaker shortcut.
    const decisions = new Map<string, Decision>();
    for (const row of toResolve) {
      if (row.payload.type !== 'Person') continue;
      const names = [row.payload.label, ...row.payload.aliases].map(normalizeForMatch);
      const personId = names.map((n) => context.speakerNames.get(n)).find((id) => id !== undefined);
      if (personId) {
        decisions.set(row.id, {
          resolution: { ref: personId, score: 1, source: 'speaker', candidates: [], adjudication: null },
          flags: [],
        });
        stats.speaker += 1;
      }
    }

    // Everything else: candidates → score → band.
    const pending = toResolve.filter((row) => !decisions.has(row.id));
    const texts = pending.map((row) => buildEntityProfileText(row.payload, this.mentionProfileContext(row, entities, others, context.labels)));
    const embedded = await this.embedMentions(userId, texts, jobType);
    stats.vectorArm = embedded.vectorArm;
    const outcomes = await this.rankMentions(
      userId,
      pending.map((row, i) => ({
        key: row.id,
        type: row.payload.type,
        label: row.payload.label,
        aliases: row.payload.aliases,
        vector: embedded.vectors[i],
        excludeCandidateIds: row.distinctFrom,
        context: context.features,
      })),
      thresholds,
    );

    // Middle band → adjudication, one pair per mention (its top candidate).
    const middle = pending.filter((row) => outcomes.get(row.id)!.band === 'middle');
    let verdicts: Map<string, AdjudicationResult> | null = null;
    if (middle.length > 0 && thresholds.adjudication === 'llm') {
      const pairs = await this.buildMentionPairs(userId, middle, outcomes);
      const result = await this.adjudicateSafely(userId, pairs.pairs, jobType);
      if (result.reason) stats.adjudication = `unavailable:${result.reason}`;
      if (result.verdicts) {
        verdicts = new Map();
        for (const [pairId, v] of result.verdicts) verdicts.set(pairs.rowByPair.get(pairId)!, v);
        stats.adjudicated = result.verdicts.size;
      }
    } else if (middle.length > 0) {
      stats.adjudication = 'off';
    }

    for (const row of pending) {
      decisions.set(row.id, decide(outcomes.get(row.id)!, thresholds, verdicts?.get(row.id) ?? null));
    }

    // Write.
    for (const row of toResolve) {
      const decision = decisions.get(row.id)!;
      if (decision.resolution.ref) stats.linked += 1;
      else stats.new += 1;
      if (decision.flags.includes('possible_duplicate')) stats.uncertain += 1;
      const flags = [...new Set([...row.flags, ...decision.flags])];
      await this.prisma.kgProposalItem.update({
        where: { id: row.id },
        data: { resolution: decision.resolution as never, flags },
      });
    }

    stats.ms = Date.now() - started;
    this.logger.log(
      `kg.resolve stage proposal=${proposalId} entities=${stats.entities} linked=${stats.linked} new=${stats.new} ` +
        `adjudicated=${stats.adjudicated} uncertain=${stats.uncertain} vectorArm=${stats.vectorArm} ms=${stats.ms}`,
    );
    return stats;
  }

  /** Pairs for the middle band, with dossiers; `pN` → proposal item id. */
  private async buildMentionPairs(
    ownerId: string,
    rows: readonly EntityRow[],
    outcomes: ReadonlyMap<string, MentionOutcome>,
  ): Promise<{ pairs: AdjudicationPair[]; rowByPair: Map<string, string> }> {
    const topIds = rows.map((r) => outcomes.get(r.id)!.candidates[0].entityId);
    const [dossiers, quotes] = await Promise.all([
      this.adjudication.buildCandidateDossiers(ownerId, topIds),
      this.prisma.kgEvidence.findMany({
        where: { ownerId, subjectKind: 'proposal_item', subjectId: { in: rows.map((r) => r.id) } },
        select: { subjectId: true, quote: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const pairs: AdjudicationPair[] = [];
    const rowByPair = new Map<string, string>();
    rows.forEach((row, i) => {
      const candidate = dossiers.get(topIds[i]);
      if (!candidate) return;
      const pairId = `p${pairs.length + 1}`;
      rowByPair.set(pairId, row.id);
      pairs.push({
        pairId,
        type: row.payload.type,
        mention: {
          label: row.payload.label,
          aliases: row.payload.aliases,
          props: row.payload.props ?? {},
          quotes: quotes.filter((q) => q.subjectId === row.id).map((q) => q.quote),
        },
        candidate,
      });
    });
    return { pairs, rowByPair };
  }

  /** The mention's profile context: its organizations and roles in this proposal, and co-mentions. */
  private mentionProfileContext(
    row: EntityRow,
    entities: readonly EntityRow[],
    others: ReadonlyArray<Record<string, unknown>>,
    existingLabels: ReadonlyMap<string, string>,
  ) {
    const labelOf = (ref: EndpointRef | undefined): string | null => {
      if (!ref || typeof ref !== 'object') return null;
      if ('entityId' in ref) return existingLabels.get(ref.entityId) ?? null;
      return entities.find((e) => e.payload.ref === ref.ref)?.payload.label ?? null;
    };
    const orgLabels: string[] = [];
    const roleTitles: string[] = [];
    for (const rel of others) {
      const from = rel.from as EndpointRef | undefined;
      if (!from || !('ref' in from) || from.ref !== row.payload.ref) continue;
      if (rel.type === 'WORKS_FOR' || rel.type === 'HAS_ROLE') {
        const org = labelOf(rel.to as EndpointRef);
        if (org) orgLabels.push(org);
      }
      if (rel.type === 'HAS_ROLE') {
        const title = (rel.props as Record<string, unknown> | undefined)?.title;
        if (typeof title === 'string') roleTitles.push(title);
      }
    }
    const coMentioned = entities
      .filter((e) => e.id !== row.id && e.payload.type !== 'Meeting')
      .map((e) => e.payload.label);
    return { orgLabels, roleTitles, coMentioned };
  }

  /**
   * The proposal's context: its transcript's identified speakers (by name and
   * as persons), its meeting, the organizations it mentions (linked by id or
   * named), and the existing entities it co-mentions.
   */
  private async proposalContext(
    ownerId: string,
    itemIds: readonly string[],
    entities: readonly EntityRow[],
    others: ReadonlyArray<Record<string, unknown>>,
  ): Promise<{ features: ResolutionContext; speakerNames: Map<string, string>; labels: Map<string, string> }> {
    const speakerNames = new Map<string, string>();
    const speakerPersonIds = new Set<string>();

    const anchor = itemIds.length
      ? await this.prisma.kgEvidence.findFirst({
          where: { ownerId, subjectKind: 'proposal_item', subjectId: { in: [...itemIds] }, transcriptId: { not: null } },
          select: { transcriptId: true },
        })
      : null;
    if (anchor?.transcriptId) {
      const transcript = await this.prisma.transcript.findFirst({
        where: { id: anchor.transcriptId, ownerId },
        select: { id: true, speakerIdentities: true },
      });
      if (transcript) {
        const speakers = await this.prisma.transcriptSpeaker.findMany({
          where: { transcriptId: transcript.id },
          select: { id: true, label: true, displayName: true },
        });
        const identities = parseSpeakerIdentities(transcript.speakerIdentities ?? {});
        const links = speakers.length
          ? await this.prisma.kgRelation.findMany({
              where: { ownerId, type: 'IDENTIFIED_AS', fromSpeakerId: { in: speakers.map((s) => s.id) } },
              select: { fromSpeakerId: true, toId: true },
            })
          : [];
        const live = new Set(
          (
            await this.prisma.kgEntity.findMany({
              where: { id: { in: links.map((l) => l.toId) }, ownerId, reviewStatus: { in: ['accepted', 'edited'] }, mergedIntoId: null },
              select: { id: true },
            })
          ).map((e) => e.id),
        );
        const personBySpeaker = new Map(links.filter((l) => live.has(l.toId)).map((l) => [l.fromSpeakerId as string, l.toId]));
        for (const s of speakers) {
          const personId = personBySpeaker.get(s.id);
          if (!personId) continue;
          speakerPersonIds.add(personId);
          const placeholder = s.label !== null && s.displayName === defaultSpeakerName(s.label);
          const name = placeholder ? (identities[s.id] ?? null) : s.displayName;
          if (name && name.trim()) speakerNames.set(normalizeForMatch(name), personId);
        }
      }
    }

    const meeting = entities.find((e) => e.payload.ref === 'meeting')?.resolution?.ref ?? null;
    const existingIds = new Set<string>();
    for (const row of others) {
      for (const key of ['from', 'to', 'subject', 'owner', 'counterparty']) {
        const ref = row[key] as EndpointRef | null | undefined;
        if (ref && typeof ref === 'object' && 'entityId' in ref) existingIds.add(ref.entityId);
      }
    }
    const existing = existingIds.size
      ? await this.prisma.kgEntity.findMany({
          where: { id: { in: [...existingIds] }, ownerId },
          select: { id: true, type: true, label: true },
        })
      : [];
    const orgIds = new Set(existing.filter((e) => e.type === 'Organization').map((e) => e.id));
    const orgNames = new Set<string>();
    for (const e of entities) {
      if (e.payload.type !== 'Organization') continue;
      if (e.resolution?.ref) orgIds.add(e.resolution.ref);
      for (const name of [e.payload.label, ...e.payload.aliases]) {
        try {
          orgNames.add(normalizeAlias(name));
        } catch {
          // nothing matchable
        }
      }
    }

    return {
      features: {
        speakerPersonIds,
        meetingIds: new Set(meeting ? [meeting] : []),
        orgIds,
        orgNames,
        neighbourIds: new Set([...existingIds].filter((id) => !orgIds.has(id) && id !== meeting)),
      },
      speakerNames,
      labels: new Map(existing.map((e) => [e.id, e.label])),
    };
  }
}

