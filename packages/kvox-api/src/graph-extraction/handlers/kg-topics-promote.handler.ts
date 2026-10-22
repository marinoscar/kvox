// =============================================================================
// kg.topics_promote (#666, epic #661; docs/specs/ontology.md §11)
// =============================================================================
//
// The history stays invisible to the graph until someone promotes it: months of
// meetings carry only the free-text `topics` list the extraction stored on each
// Meeting entity (`props.topics`). This job turns those strings into DRAFT
// PROPOSALS of Topic entities plus `Meeting DISCUSSED Topic` edges, for a person
// to review at `/graph/review`. It NEVER writes the graph: a proposal is not the
// graph (§8), and nothing enters the graph except through a reviewed commit.
//
//   profile     { maxRuntimeMs: 30 min, maxAttempts: 3 } — a retry is safe: every
//               proposal is written whole (one transaction) and the next attempt
//               skips what is already proposed
//   server-only the user's own AI key (embedding and adjudication), the
//               `kg.resolve` argument: NO nodeResultSchema, NO persistNodeResult
//   subject     `user` / userId — ordinary dedup, one run per user at a time
//   payload     { userId }
//   trigger     only a person's click (`POST /api/graph/topics/promote`); never a
//               cron, never an event — it spends the user's key
//
//   1. Scan the owner's live Meeting entities in keyset batches of 200 (`id >
//      cursor`), collecting the distinct normalized topic strings and the meetings
//      that carry each.
//   2. Drop every (meeting, topic) pair that already has a live DISCUSSED edge, or
//      a pending (draft) topics-promote proposal row.
//   3. Resolve each remaining string against the owner's Topic entities with the
//      existing pipeline: candidates (alias, trigram, vector), score, band, and
//      adjudication for the middle band. "licence costs" lands on "licensing cost".
//   4. Group by concept — one existing Topic, or one new concept — and write ONE
//      draft proposal per Topic through `ProposalWriter.createDraft`, so the Review
//      page accepts a topic and all its meetings together, or a batch of topics.
//      Rows stay `pending`: business sensitivity, never pre-checked.
//
// Evidence is the Meeting's own citation (the note span or transcript line the
// meeting was extracted from). A meeting with no readable citation is skipped.
//
// Re-running creates nothing new: step 2 sees the earlier proposals, or — once
// they are committed — the edges, and the label a committed proposal learned as
// an alias of its Topic.
//
// ⚠ Logs carry ids and counts only — never a topic string.
// =============================================================================

import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { z } from 'zod';

import { KG_TOPICS_PROMOTE_JOB_TYPE, GraphPreferencesService, normalizeAlias } from '../../graph/index.js';
import type { KvoxGraphDb } from '../../graph/index.js';
import { KVOX_PRISMA, KVOX_JOBS, type KvoxJobsPort, type KvoxJobHandler, type KvoxJobProfile, type KvoxJob } from '../../ports/index.js';
import type { EvidenceDraft, ProposedRow } from '../extraction/validate.js';
import { ProposalWriter } from '../extraction/proposal-writer.service.js';
import type { ProposalItemFlag, ProposalResolution } from '../proposals/proposal-payload.schema.js';
import type { AdjudicationPair } from '../resolution/adjudication-prompt.js';
import { AdjudicationService, type AdjudicationResult } from '../resolution/adjudication.service.js';
import { emptyContext } from '../resolution/context-features.service.js';
import { decide, ResolutionService, type MentionOutcome } from '../resolution/resolution.service.js';

/** Meetings read per keyset batch. */
export const KG_TOPICS_PROMOTE_BATCH_SIZE = 200;
/** The longest one attempt may run. */
export const KG_TOPICS_PROMOTE_MAX_RUNTIME_MS = 30 * 60_000;
/** `kg_proposals.stats.source` of every proposal this job writes. */
export const KG_TOPICS_PROMOTE_SOURCE = 'topics_promote';
/** Strings resolved per round (one embedding call, one adjudication call per round). */
const RESOLVE_CHUNK = 100;
/** The Topic row cites at most this many of its meetings. */
const TOPIC_ROW_CITATIONS = 3;
/** `entityPayloadSchema.aliases` holds at most 10. */
const MAX_ALIASES = 10;
const LIVE = ['accepted', 'edited'] as const;
const ID_CHUNK = 1000;

const payloadSchema = z.object({ userId: z.guid() });
export type KgTopicsPromotePayload = z.infer<typeof payloadSchema>;

/** Reads the payload; null when unreadable (the job is a no-op, never a failure loop). */
export function readKgTopicsPromotePayload(payload: unknown): KgTopicsPromotePayload | null {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** What one run did. Recorded in each proposal's stats and logged as counts. */
export interface KgTopicsPromoteStats {
  meetings: number;
  strings: number;
  pairsSkippedKnown: number;
  pairsSkippedNoEvidence: number;
  proposals: number;
  linked: number;
  adjudicated: number;
  vectorArm: string;
  adjudication?: string;
}

interface Mention {
  /** `normalizeAlias(label)`. */
  key: string;
  /** The spelling shown, the one most meetings use. */
  label: string;
  variants: Map<string, number>;
  meetings: Set<string>;
}

/** The single-line form of a topic string, or null when it is unusable. */
export function cleanTopic(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  return clean.length > 0 ? clean : null;
}

/** The topics of a Meeting entity's `props`: strings only, cleaned, duplicates by normalized form dropped. */
export function topicsOf(props: unknown): Array<{ key: string; label: string }> {
  const list = (props as { topics?: unknown } | null)?.topics;
  if (!Array.isArray(list)) return [];
  const out = new Map<string, string>();
  for (const raw of list) {
    const label = cleanTopic(raw);
    if (!label) continue;
    try {
      const key = normalizeAlias(label);
      if (!out.has(key)) out.set(key, label);
    } catch {
      // Nothing matchable (no letters or digits).
    }
  }
  return [...out].map(([key, label]) => ({ key, label }));
}

function stem(token: string): string {
  return token.length > 4 ? token.replace(/(ing|ed|es|s|e)$/, '') : token;
}

/** Groups spellings of one NEW concept: word order and plural/-ing endings do not matter. */
export function conceptKey(normalized: string): string {
  return normalized
    .split(' ')
    .map(stem)
    .sort()
    .join(' ');
}

type Decision = ReturnType<typeof decide>;

/**
 * A Topic is its name: there is no second "Sarah" to tell apart by context. So a string that is
 * exactly an existing Topic's label or alias (after normalization) links to it even though the
 * generic score leaves an exact name alone in the middle band, UNLESS the adjudicator ruled it a
 * different thing, or the match is ambiguous between two Topics. Without this a topic already in
 * the graph would be proposed again as a duplicate whenever adjudication is off or unavailable.
 */
export function linkExactName(outcome: MentionOutcome, decision: Decision, verdict: AdjudicationResult | null): Decision {
  const top = outcome.candidates[0];
  if (decision.resolution.ref || !top || outcome.ambiguous || verdict?.verdict === 'different') return decision;
  if (!top.signals.includes('alias_exact') || outcome.band === 'new') return decision;
  return {
    resolution: { ...decision.resolution, ref: top.entityId, score: top.score, source: 'alias' },
    flags: decision.flags.filter((flag) => flag !== 'possible_duplicate'),
  };
}

/** A Meeting's own citation as proposal evidence; null when it cannot be anchored. */
export function evidenceDraftOf(row: {
  transcriptId: string | null;
  segmentId: string | null;
  segmentRev: number | null;
  startMs: number | null;
  endMs: number | null;
  noteId: string | null;
  noteVersion: number | null;
  charStart: number | null;
  charEnd: number | null;
  quote: string;
}): EvidenceDraft | null {
  if (row.transcriptId && row.segmentId && row.segmentRev !== null && row.startMs !== null && row.endMs !== null) {
    return {
      source: 'segment',
      transcriptId: row.transcriptId,
      segmentId: row.segmentId,
      segmentRev: row.segmentRev,
      startMs: row.startMs,
      endMs: row.endMs,
      charStart: row.charStart,
      charEnd: row.charEnd,
      quote: row.quote,
    };
  }
  if (row.noteId && row.noteVersion !== null) {
    return {
      source: 'note',
      noteId: row.noteId,
      noteVersion: row.noteVersion,
      charStart: row.charStart,
      charEnd: row.charEnd,
      quote: row.quote,
    };
  }
  return null;
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * KgTopicsPromoteHandler: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class KgTopicsPromoteHandler implements KvoxJobHandler, OnModuleInit {
  /** The handler spends the owner's own provider key (embedding, adjudication), so it can never be offered to a node. */
  readonly usesAi = true;

  private readonly logger = new Logger(KgTopicsPromoteHandler.name);

  readonly type = KG_TOPICS_PROMOTE_JOB_TYPE;

  readonly label = 'Find topics in past meetings';
  readonly profile: KvoxJobProfile = { maxRuntimeMs: KG_TOPICS_PROMOTE_MAX_RUNTIME_MS, maxAttempts: 3 };

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly preferences: GraphPreferencesService,
    private readonly resolution: ResolutionService,
    private readonly adjudication: AdjudicationService,
    private readonly writer: ProposalWriter,
  ) {}

  /**
   * On module init.
   */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: KvoxJob): Promise<void> {
    const payload = readKgTopicsPromotePayload(job.payload);
    if (!payload) {
      this.logger.warn(`${KG_TOPICS_PROMOTE_JOB_TYPE} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }
    const started = Date.now();
    const { userId } = payload;
    const stats: KgTopicsPromoteStats = {
      meetings: 0,
      strings: 0,
      pairsSkippedKnown: 0,
      pairsSkippedNoEvidence: 0,
      proposals: 0,
      linked: 0,
      adjudicated: 0,
      vectorArm: 'ok',
    };

    // --- 1. the meetings, in keyset batches ------------------------------------
    const mentions = new Map<string, Mention>();
    const titles = new Map<string, string>();
    let cursor: string | null = null;
    for (;;) {
      const batch: Array<{ id: string; label: string; props: unknown }> = await this.prisma.kgEntity.findMany({
        where: {
          ownerId: userId,
          type: 'Meeting',
          reviewStatus: { in: [...LIVE] },
          mergedIntoId: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, label: true, props: true },
        orderBy: { id: 'asc' },
        take: KG_TOPICS_PROMOTE_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const meeting of batch) {
        const topics = topicsOf(meeting.props);
        if (topics.length === 0) continue;
        stats.meetings += 1;
        titles.set(meeting.id, meeting.label);
        for (const topic of topics) {
          let m = mentions.get(topic.key);
          if (!m) {
            m = { key: topic.key, label: topic.label, variants: new Map(), meetings: new Set() };
            mentions.set(topic.key, m);
          }
          m.variants.set(topic.label, (m.variants.get(topic.label) ?? 0) + 1);
          m.meetings.add(meeting.id);
        }
      }
      cursor = batch[batch.length - 1].id;
      if (batch.length < KG_TOPICS_PROMOTE_BATCH_SIZE) break;
    }
    for (const m of mentions.values()) {
      m.label = [...m.variants].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    }

    // --- 2. what is already known ----------------------------------------------
    const known = await this.knownPairs(userId, [...titles.keys()]);
    for (const m of [...mentions.values()]) {
      for (const meetingId of [...m.meetings]) {
        if (known.has(`${meetingId}|${m.key}`)) {
          m.meetings.delete(meetingId);
          stats.pairsSkippedKnown += 1;
        }
      }
      if (m.meetings.size === 0) mentions.delete(m.key);
    }
    stats.strings = mentions.size;
    if (mentions.size === 0) {
      this.logger.log(
        `${KG_TOPICS_PROMOTE_JOB_TYPE} job ${job.id} user=${userId} meetings=${stats.meetings} nothing to propose ms=${Date.now() - started}`,
      );
      return;
    }

    // --- 3. resolve against the owner's Topic entities ---------------------------
    const thresholds = (await this.preferences.get(userId)).resolution;
    const decisions = new Map<string, { resolution: ProposalResolution; flags: ProposalItemFlag[] }>();
    for (const part of chunks([...mentions.values()], RESOLVE_CHUNK)) {
      const embedded = await this.resolution.embedMentions(
        userId,
        part.map((m) => m.label),
        KG_TOPICS_PROMOTE_JOB_TYPE,
        job.id,
      );
      stats.vectorArm = embedded.vectorArm;
      const outcomes = await this.resolution.rankMentions(
        userId,
        part.map((m, i) => ({
          key: m.key,
          type: 'Topic',
          label: m.label,
          aliases: [...m.variants.keys()].filter((v) => v !== m.label),
          vector: embedded.vectors[i],
          context: emptyContext(),
        })),
        thresholds,
      );

      const middle = part.filter((m) => outcomes.get(m.key)!.band === 'middle');
      let verdicts: Map<string, AdjudicationResult> | null = null;
      if (middle.length > 0 && thresholds.adjudication === 'llm') {
        const built = await this.buildPairs(userId, middle, outcomes, titles);
        const result = await this.resolution.adjudicateSafely(userId, built.pairs, KG_TOPICS_PROMOTE_JOB_TYPE, job.id);
        if (result.reason) stats.adjudication = `unavailable:${result.reason}`;
        if (result.verdicts) {
          verdicts = new Map();
          for (const [pairId, v] of result.verdicts) verdicts.set(built.mentionByPair.get(pairId)!, v);
          stats.adjudicated += result.verdicts.size;
        }
      } else if (middle.length > 0) {
        stats.adjudication = 'off';
      }
      for (const m of part) {
        const outcome = outcomes.get(m.key)!;
        decisions.set(m.key, linkExactName(outcome, decide(outcome, thresholds, verdicts?.get(m.key) ?? null), verdicts?.get(m.key) ?? null));
      }
    }

    // --- 4. one concept = one proposal -----------------------------------------
    interface Concept {
      linkedTo: string | null;
      mentions: Mention[];
    }
    const concepts = new Map<string, Concept>();
    for (const m of [...mentions.values()].sort((a, b) => a.key.localeCompare(b.key))) {
      const ref = decisions.get(m.key)!.resolution.ref;
      const id = ref ? `id:${ref}` : `new:${conceptKey(m.key)}`;
      const concept = concepts.get(id) ?? { linkedTo: ref, mentions: [] };
      concept.mentions.push(m);
      concepts.set(id, concept);
    }

    const linkedKnown = await this.knownLinkedPairs(userId, [...titles.keys()]);
    for (const concept of concepts.values()) {
      const meetingIds = new Set<string>();
      for (const m of concept.mentions) for (const id of m.meetings) meetingIds.add(id);
      if (concept.linkedTo) {
        for (const id of [...meetingIds]) {
          if (linkedKnown.has(`${id}|id:${concept.linkedTo}`)) {
            meetingIds.delete(id);
            stats.pairsSkippedKnown += 1;
          }
        }
      }
      if (meetingIds.size === 0) continue;

      const evidence = await this.meetingEvidence(userId, [...meetingIds].sort());
      const cited = [...meetingIds].sort().filter((id) => evidence.has(id));
      stats.pairsSkippedNoEvidence += meetingIds.size - cited.length;
      if (cited.length === 0) continue;

      // The representative mention: the one the most meetings use; its decision is the concept's.
      const lead = [...concept.mentions].sort((a, b) => b.meetings.size - a.meetings.size || a.key.localeCompare(b.key))[0];
      const decision = decisions.get(lead.key)!;
      const flags = [...new Set(concept.mentions.flatMap((m) => decisions.get(m.key)!.flags))];
      const aliases: string[] = [];
      for (const m of concept.mentions) {
        for (const v of m.variants.keys()) {
          if (normalizeAliasSafe(v) !== lead.key && !aliases.some((a) => normalizeAliasSafe(a) === normalizeAliasSafe(v))) aliases.push(v);
        }
      }

      const rows: ProposedRow[] = [
        {
          kind: 'entity',
          payload: { ref: 'topic', type: 'Topic', label: lead.label, aliases: aliases.slice(0, MAX_ALIASES), props: {}, occurredAt: null },
          resolution: decision.resolution,
          flags,
          evidence: cited.slice(0, TOPIC_ROW_CITATIONS).map((id) => evidence.get(id)!),
        },
        ...cited.map((id, i): ProposedRow => ({
          kind: 'relation',
          payload: {
            ref: `r${i + 1}`,
            type: 'DISCUSSED',
            from: { entityId: id },
            to: { ref: 'topic' },
            props: {},
            validFrom: null,
            validTo: null,
            precision: 'unknown',
          },
          resolution: null,
          flags: [],
          evidence: [evidence.get(id)!],
        })),
      ];
      await this.writer.createDraft(userId, 'import', rows, {
        phase: 'ready',
        source: KG_TOPICS_PROMOTE_SOURCE,
        sourceJobId: job.id,
        topic: lead.label,
        meetings: cited.length,
      });
      stats.proposals += 1;
      if (concept.linkedTo) stats.linked += 1;
    }

    this.logger.log(
      `${KG_TOPICS_PROMOTE_JOB_TYPE} job ${job.id} user=${userId} meetings=${stats.meetings} strings=${stats.strings} ` +
        `proposals=${stats.proposals} linked=${stats.linked} skippedKnown=${stats.pairsSkippedKnown} ` +
        `skippedNoEvidence=${stats.pairsSkippedNoEvidence} adjudicated=${stats.adjudicated} vectorArm=${stats.vectorArm} ms=${Date.now() - started}`,
    );
  }

  /**
   * `meetingId|normalizedTopic` for every pair that already has a live DISCUSSED edge to a Topic
   * (by the Topic's label or any alias) or sits in a pending topics-promote proposal.
   */
  private async knownPairs(ownerId: string, meetingIds: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const part of chunks(meetingIds, ID_CHUNK)) {
      const edges = await this.prisma.kgRelation.findMany({
        where: { ownerId, type: 'DISCUSSED', reviewStatus: { in: [...LIVE] }, fromId: { in: part } },
        select: { fromId: true, toId: true },
      });
      if (edges.length === 0) continue;
      const topicIds = [...new Set(edges.map((e) => e.toId))];
      const topics = await this.prisma.kgEntity.findMany({
        where: { id: { in: topicIds }, ownerId, type: 'Topic', reviewStatus: { in: [...LIVE] }, mergedIntoId: null },
        select: { id: true, label: true },
      });
      const aliases = await this.prisma.kgEntityAlias.findMany({
        where: { entityId: { in: topics.map((t) => t.id) } },
        select: { entityId: true, normalized: true },
      });
      const namesOf = new Map<string, Set<string>>(topics.map((t) => [t.id, new Set([normalizeAliasSafe(t.label)])]));
      for (const a of aliases) namesOf.get(a.entityId)?.add(a.normalized);
      for (const edge of edges) {
        for (const name of namesOf.get(edge.toId) ?? []) if (name) out.add(`${edge.fromId}|${name}`);
      }
    }
    for (const pair of (await this.pendingPairs(ownerId)).names) out.add(pair);
    return out;
  }

  /** `meetingId|id:<topicEntityId>` for live DISCUSSED edges and pending proposal rows that link an existing Topic. */
  private async knownLinkedPairs(ownerId: string, meetingIds: readonly string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const part of chunks(meetingIds, ID_CHUNK)) {
      const edges = await this.prisma.kgRelation.findMany({
        where: { ownerId, type: 'DISCUSSED', reviewStatus: { in: [...LIVE] }, fromId: { in: part } },
        select: { fromId: true, toId: true },
      });
      for (const e of edges) out.add(`${e.fromId}|id:${e.toId}`);
    }
    for (const pair of (await this.pendingPairs(ownerId)).ids) out.add(pair);
    return out;
  }

  /** Every pair a pending (draft) topics-promote proposal already carries: by name (`meeting|name`) and by linked Topic (`meeting|id:<entity>`). */
  private async pendingPairs(ownerId: string): Promise<{ names: Set<string>; ids: Set<string> }> {
    const out = { names: new Set<string>(), ids: new Set<string>() };
    const proposals = await this.prisma.kgProposal.findMany({
      where: { ownerId, kind: 'import', status: 'draft', stats: { path: ['source'], equals: KG_TOPICS_PROMOTE_SOURCE } },
      select: { id: true },
    });
    if (proposals.length === 0) return out;
    const items = await this.prisma.kgProposalItem.findMany({
      where: { proposalId: { in: proposals.map((p) => p.id) } },
      select: { proposalId: true, kind: true, payload: true, resolution: true },
    });
    for (const proposal of proposals) {
      const mine = items.filter((i) => i.proposalId === proposal.id);
      const topic = mine.find((i) => i.kind === 'entity');
      if (!topic) continue;
      const payload = topic.payload as { label?: unknown; aliases?: unknown };
      const names = new Set<string>();
      for (const raw of [payload.label, ...(Array.isArray(payload.aliases) ? payload.aliases : [])]) {
        const key = typeof raw === 'string' ? normalizeAliasSafe(raw) : '';
        if (key) names.add(key);
      }
      const ref = (topic.resolution as { ref?: unknown } | null)?.ref;
      for (const item of mine.filter((i) => i.kind === 'relation')) {
        const from = (item.payload as { from?: { entityId?: unknown } }).from?.entityId;
        if (typeof from !== 'string') continue;
        for (const name of names) out.names.add(`${from}|${name}`);
        if (typeof ref === 'string') out.ids.add(`${from}|id:${ref}`);
      }
    }
    return out;
  }

  /** Each meeting's first citation, as proposal evidence. A meeting with none is absent from the map. */
  private async meetingEvidence(ownerId: string, meetingIds: readonly string[]): Promise<Map<string, EvidenceDraft>> {
    const out = new Map<string, EvidenceDraft>();
    for (const part of chunks(meetingIds, ID_CHUNK)) {
      const rows = await this.prisma.kgEvidence.findMany({
        where: { ownerId, subjectKind: 'entity', subjectId: { in: part } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const row of rows) {
        if (out.has(row.subjectId)) continue;
        const draft = evidenceDraftOf(row);
        if (draft) out.set(row.subjectId, draft);
      }
    }
    return out;
  }

  /** Pairs for the middle band: the string against its best existing Topic, with that Topic's dossier. */
  private async buildPairs(
    ownerId: string,
    mentions: readonly Mention[],
    outcomes: ReadonlyMap<string, MentionOutcome>,
    titles: ReadonlyMap<string, string>,
  ): Promise<{ pairs: AdjudicationPair[]; mentionByPair: Map<string, string> }> {
    const topIds = mentions.map((m) => outcomes.get(m.key)!.candidates[0].entityId);
    const dossiers = await this.adjudication.buildCandidateDossiers(ownerId, topIds);
    const pairs: AdjudicationPair[] = [];
    const mentionByPair = new Map<string, string>();
    mentions.forEach((m, i) => {
      const candidate = dossiers.get(topIds[i]);
      if (!candidate) return;
      const pairId = `p${pairs.length + 1}`;
      mentionByPair.set(pairId, m.key);
      pairs.push({
        pairId,
        type: 'Topic',
        mention: {
          label: m.label,
          aliases: [...m.variants.keys()].filter((v) => v !== m.label),
          props: {},
          quotes: [...m.meetings]
            .slice(0, 2)
            .map((id) => titles.get(id))
            .filter((t): t is string => !!t)
            .map((t) => `Listed as a topic of the meeting "${t}"`),
        },
        candidate,
      });
    });
    return { pairs, mentionByPair };
  }
}

function normalizeAliasSafe(value: string): string {
  try {
    return normalizeAlias(value);
  } catch {
    return '';
  }
}
