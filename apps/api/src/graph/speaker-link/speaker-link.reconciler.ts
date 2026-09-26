// =============================================================================
// SpeakerLinkReconciler (#356, epic #344; docs/specs/ontology.md §4, §5.1, §7,
// §8, §12)
// =============================================================================
//
// Naming a speaker is the highest-confidence resolution act the product sees,
// and §8's FIRST NAMED EXCEPTION to "nothing enters the graph without a
// reviewed proposal": the user's naming IS the review. This file turns one
// transcript's `speaker_identities` into `Person` entities and `IDENTIFIED_AS`
// edges in the transcript OWNER's graph.
//
// A FULL RECONCILE, NOT A DELTA. Every run reads the transcript's CURRENT
// identities and makes the owner's edges for that transcript's speakers agree
// with them — so two queued runs (`kg.speaker_link` is enqueued with
// `skipDedup`) converge on the same end state, and a retry after a partial
// failure is harmless. The advisory lock serialises runs for one transcript.
// §5.1's "do not duplicate the naming" holds because the edge is DERIVED from
// `speaker_identities` on every run; nothing here keeps its own copy.
//
// OWNER-ONLY (§12). Only the owner's own naming writes into the owner's graph:
// an editor's act on somebody else's recording curates nobody's graph, and a
// share never propagates graph rows.
//
// EVERY kg_* CREATE GOES THROUGH `GraphWriteService` (#355). There is no
// delete path there, so the edge/Person deletions below run on the same
// transaction, deleting evidence TOGETHER WITH its subject: the deferred
// no-orphans trigger re-reads the subject at COMMIT, finds no row, and passes.
//
// ⚠ Never log or audit a name. Ids and counts only.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import type { EffectiveSchema } from '@app/shared/ontology';
import { Prisma } from '@prisma/client';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import { parseSpeakerIdentities } from '../../transcripts/editing/speaker-identity';
import type { EvidenceInput } from '../dto/graph-evidence.dto';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import { normalizeAlias } from '../write/normalize';
import { GraphWriteService } from '../write/graph-write.service';

type Tx = Prisma.TransactionClient;

export const SPEAKER_LINKED_ACTION = 'graph.speaker_linked';
export const SPEAKER_UNLINKED_ACTION = 'graph.speaker_unlinked';

const IDENTIFIED_AS = 'IDENTIFIED_AS';
const PERSON = 'Person';
const LIVE_STATUSES = ['accepted', 'edited'] as const;

/** The first ≤ 3 segments of a speaker are its citations. */
const MAX_EVIDENCE = 3;
/** Evidence quotes are capped well under `evidenceInputSchema`'s 2000. */
const MAX_QUOTE = 500;

export interface SpeakerLinkInput {
  transcriptId: string;
  actorUserId: string;
}

export type SpeakerLinkSkip = 'missing' | 'not_owner' | 'no_permission';

export interface SpeakerLinkSummary {
  /** Set when the run wrote nothing by design. */
  skipped: SpeakerLinkSkip | null;
  ownerId: string | null;
  linked: number;
  created: number;
  unlinked: number;
  /** Persons this run created — the handler enqueues `kg.embed` for them. */
  createdPersonIds: string[];
}

interface ExistingEdge {
  id: string;
  speakerId: string;
  personId: string;
  personLive: boolean;
  personNames: string[];
}

interface PersonCandidate {
  id: string;
  label: string;
  aliases: { alias: string; normalized: string }[];
  identifiedCount: number;
  updatedAt: Date;
}

/** `normalizeAlias`, or `null` for a name with nothing comparable left in it. */
export function safeNormalize(name: string): string | null {
  try {
    return normalizeAlias(name);
  } catch {
    return null;
  }
}

function emptySummary(skipped: SpeakerLinkSkip | null, ownerId: string | null): SpeakerLinkSummary {
  return { skipped, ownerId, linked: 0, created: 0, unlinked: 0, createdPersonIds: [] };
}

@Injectable()
export class SpeakerLinkReconciler {
  private readonly logger = new Logger(SpeakerLinkReconciler.name);

  constructor(
    private readonly write: GraphWriteService,
    private readonly ontology: GraphOntologyService,
  ) {}

  async reconcile(tx: Tx, input: SpeakerLinkInput): Promise<SpeakerLinkSummary> {
    const { transcriptId, actorUserId } = input;

    // 1. One run per transcript at a time; released at COMMIT/ROLLBACK.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kg.speaker_link:${transcriptId}`}))`;

    // 2. The transcript, and the three reasons to write nothing.
    const transcript = await tx.transcript.findUnique({
      where: { id: transcriptId },
      select: { ownerId: true, speakerIdentities: true, deletedAt: true },
    });
    if (!transcript || transcript.deletedAt) return emptySummary('missing', null);

    const ownerId = transcript.ownerId;
    if (actorUserId !== ownerId) {
      this.logger.debug(`kg.speaker_link ${transcriptId}: named by a non-owner; the owner's graph is untouched`);
      return emptySummary('not_owner', ownerId);
    }

    const canWrite = await tx.user.findFirst({
      where: {
        id: ownerId,
        isActive: true,
        userRoles: {
          some: { role: { rolePermissions: { some: { permission: { name: PERMISSIONS.GRAPH_WRITE } } } } },
        },
      },
      select: { id: true },
    });
    if (!canWrite) return emptySummary('no_permission', ownerId);

    // 3. speakerId → the name's comparable form, for speakers still in the transcript.
    const speakers = await tx.transcriptSpeaker.findMany({ where: { transcriptId }, select: { id: true } });
    const speakerIds = speakers.map((s) => s.id);
    const identities = parseSpeakerIdentities(transcript.speakerIdentities);
    const named = new Map<string, { displayName: string; normalized: string }>();
    for (const id of speakerIds) {
      const displayName = identities[id]?.trim();
      const normalized = displayName ? safeNormalize(displayName) : null;
      if (displayName && normalized) named.set(id, { displayName, normalized });
    }

    // 4. The owner's existing edges for those speakers.
    const edges = await this.loadEdges(tx, ownerId, speakerIds);
    const edgeBySpeaker = new Map(edges.map((e) => [e.speakerId, e]));

    const summary = emptySummary(null, ownerId);
    let schema: EffectiveSchema | null = null;
    const schemaFor = async () => (schema ??= await this.ontology.effectiveSchemaFor(ownerId));

    // 5. Every named speaker.
    for (const [speakerId, name] of named) {
      const edge = edgeBySpeaker.get(speakerId);

      // 5.1 Already linked to a live Person carrying this name.
      if (edge && edge.personLive && edge.personNames.some((n) => safeNormalize(n) === name.normalized)) continue;
      if (edge) continue; // re-pointing lands with the cleanup rules

      const evidence = await this.evidenceFor(tx, transcriptId, speakerId);
      if (evidence.length === 0) {
        this.logger.debug(`kg.speaker_link ${transcriptId}: speaker ${speakerId} has no citable segment`);
        continue;
      }

      // 5.2 Find the Person, or 5.3 create one.
      const candidates = await this.findPersons(tx, ownerId, name.displayName, name.normalized);
      let personId: string;
      if (candidates.length > 0) {
        personId = candidates[0].id;
      } else {
        const person = await this.write.createEntity(
          tx,
          {
            ownerId,
            type: PERSON,
            label: name.displayName,
            reviewStatus: 'accepted',
            labelSource: 'speaker_naming',
            evidence,
          },
          await schemaFor(),
        );
        personId = person.id;
        summary.created += 1;
        summary.createdPersonIds.push(person.id);
      }

      // 5.5 The edge.
      await this.write.createRelation(
        tx,
        {
          ownerId,
          type: IDENTIFIED_AS,
          fromSpeakerId: speakerId,
          toId: personId,
          props: { transcriptId, speakerId },
          valid: null,
          reviewStatus: 'accepted',
          evidence,
        },
        await schemaFor(),
      );
      summary.linked += 1;
    }

    return summary;
  }

  // ===========================================================================
  // Reads
  // ===========================================================================

  private async loadEdges(tx: Tx, ownerId: string, speakerIds: string[]): Promise<ExistingEdge[]> {
    if (speakerIds.length === 0) return [];
    const rows = await tx.kgRelation.findMany({
      where: { ownerId, type: IDENTIFIED_AS, fromSpeakerId: { in: speakerIds } },
      select: {
        id: true,
        fromSpeakerId: true,
        toId: true,
        toEntity: { select: { label: true, reviewStatus: true, aliases: { select: { alias: true } } } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      speakerId: r.fromSpeakerId as string,
      personId: r.toId,
      personLive: (LIVE_STATUSES as readonly string[]).includes(r.toEntity.reviewStatus),
      personNames: [r.toEntity.label, ...r.toEntity.aliases.map((a) => a.alias)],
    }));
  }

  /**
   * The owner's live Persons whose label or any alias normalizes to `normalized`.
   * Candidate rows are narrowed in SQL (an alias's stored `normalized`, or a
   * case-insensitive label) and confirmed with `normalizeAlias` itself.
   */
  private async findPersons(
    tx: Tx,
    ownerId: string,
    displayName: string,
    normalized: string,
  ): Promise<PersonCandidate[]> {
    const rows = await tx.kgEntity.findMany({
      where: {
        ownerId,
        type: PERSON,
        reviewStatus: { in: [...LIVE_STATUSES] },
        OR: [
          { aliases: { some: { normalized } } },
          { label: { equals: displayName, mode: 'insensitive' } },
          { label: { equals: normalized, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        label: true,
        updatedAt: true,
        aliases: { select: { alias: true, normalized: true } },
        _count: { select: { relationsTo: { where: { type: IDENTIFIED_AS } } } },
      },
    });
    return rows
      .filter((r) => safeNormalize(r.label) === normalized || r.aliases.some((a) => a.normalized === normalized))
      .map((r) => ({
        id: r.id,
        label: r.label,
        aliases: r.aliases,
        identifiedCount: r._count.relationsTo,
        updatedAt: r.updatedAt,
      }));
  }

  /** A speaker's first ≤ 3 non-empty segments by `ordinal`, as citations. */
  private async evidenceFor(tx: Tx, transcriptId: string, speakerId: string): Promise<EvidenceInput[]> {
    const segments = await tx.transcriptSegment.findMany({
      where: { transcriptId, speakerId },
      orderBy: [{ ordinal: 'asc' }, { id: 'asc' }],
      take: MAX_EVIDENCE * 4,
      select: { id: true, rev: true, startMs: true, endMs: true, text: true },
    });
    return segments
      .filter((s) => s.text.trim().length > 0)
      .slice(0, MAX_EVIDENCE)
      .map((s) => ({
        transcriptId,
        segmentId: s.id,
        segmentRev: s.rev,
        startMs: s.startMs,
        endMs: s.endMs,
        noteId: null,
        noteVersion: null,
        charStart: null,
        charEnd: null,
        quote: s.text.slice(0, MAX_QUOTE),
        importObjectId: null,
        sourceIri: null,
      }));
  }
}
