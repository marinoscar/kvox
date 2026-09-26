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
import { KG_SUBJECT_TRANSCRIPT } from '../job-types';
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

export interface PersonCandidate {
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

/**
 * The Person a name resolves to among `candidates` (all matching, live, the
 * owner's). One: it. Several: the one with the most `IDENTIFIED_AS` edges, then
 * the most recently updated, then the lowest id — deterministic, so two runs
 * over the same graph pick the same Person. `null` when there is none.
 */
export function pickPerson(
  candidates: readonly PersonCandidate[],
): { person: PersonCandidate; ambiguous: boolean; candidateIds: string[] } | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort(
    (a, b) =>
      b.identifiedCount - a.identifiedCount ||
      b.updatedAt.getTime() - a.updatedAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return {
    person: sorted[0],
    ambiguous: sorted.length > 1,
    candidateIds: sorted.map((c) => c.id),
  };
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
    const orphaned: string[] = []; // Persons whose edge was removed — cleanup candidates
    for (const [speakerId, name] of named) {
      const edge = edgeBySpeaker.get(speakerId);

      // 5.1 Already linked to a live Person carrying this name: nothing to do.
      if (edge && edge.personLive && edge.personNames.some((n) => safeNormalize(n) === name.normalized)) continue;

      const evidence = await this.evidenceFor(tx, transcriptId, speakerId);
      if (evidence.length === 0) {
        // No citable segment, so nothing may enter the graph (§3.3). A stale
        // edge still goes: it names somebody this speaker no longer is.
        this.logger.debug(`kg.speaker_link ${transcriptId}: speaker ${speakerId} has no citable segment`);
        if (edge) {
          await this.unlink(tx, ownerId, transcriptId, edge, orphaned);
          summary.unlinked += 1;
        }
        continue;
      }

      // 5.2 Find the Person.
      const candidates = await this.findPersons(tx, ownerId, name.displayName, name.normalized);
      const pick = pickPerson(candidates);
      let personId: string;
      let createdPerson = false;

      if (pick) {
        personId = pick.person.id;
        // 5.4 Matched through an alias spelled differently: record this spelling
        // too. (`addAliases` skips a normalized form the entity already carries.)
        const spelledAlike =
          pick.person.label === name.displayName || pick.person.aliases.some((a) => a.alias === name.displayName);
        if (!spelledAlike) {
          await this.write.addAliases(tx, ownerId, personId, [{ alias: name.displayName, source: 'speaker_naming' }]);
        }
      } else {
        // 5.3 Create it. The label is stored as its own `speaker_naming` alias (#355).
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
        createdPerson = true;
        summary.created += 1;
        summary.createdPersonIds.push(person.id);
      }

      // 5.5 The edge: the stale one first (its old Person is a cleanup
      // candidate, step 6), then the new one. At most one edge per speaker is
      // `kg_relations_speaker_link_uniq_idx`'s guarantee.
      if (edge) await this.deleteEdge(tx, edge.id);
      if (edge && edge.personId !== personId) orphaned.push(edge.personId);

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

      // 7. Audit — ids only, never the name.
      await this.audit(tx, ownerId, SPEAKER_LINKED_ACTION, transcriptId, {
        transcriptId,
        speakerId,
        personId,
        createdPerson,
        ...(pick?.ambiguous ? { ambiguous: true, candidateIds: pick.candidateIds } : {}),
      });
    }

    // 6. Edges whose speaker no longer has a name.
    for (const edge of edges) {
      if (named.has(edge.speakerId)) continue;
      await this.unlink(tx, ownerId, transcriptId, edge, orphaned);
      summary.unlinked += 1;
    }

    // 6. Cleanup: a Person that existed only because of speaker naming here.
    for (const personId of new Set(orphaned)) {
      if (await this.isSpeakerNamingOnly(tx, ownerId, personId, transcriptId)) {
        await this.deletePerson(tx, personId);
      }
    }

    return summary;
  }

  // ===========================================================================
  // Writes that GraphWriteService has no path for (deletions)
  // ===========================================================================

  /** Delete an edge and its evidence, audit it, and queue its Person for cleanup. */
  private async unlink(
    tx: Tx,
    ownerId: string,
    transcriptId: string,
    edge: ExistingEdge,
    orphaned: string[],
  ): Promise<void> {
    await this.deleteEdge(tx, edge.id);
    orphaned.push(edge.personId);
    await this.audit(tx, ownerId, SPEAKER_UNLINKED_ACTION, transcriptId, {
      transcriptId,
      speakerId: edge.speakerId,
      removedPersonId: edge.personId,
    });
  }

  /**
   * Evidence TOGETHER WITH its subject, on one transaction: the deferred
   * no-orphans trigger re-reads the relation at COMMIT, finds no row, passes.
   */
  private async deleteEdge(tx: Tx, relationId: string): Promise<void> {
    await tx.kgEvidence.deleteMany({ where: { subjectKind: 'relation', subjectId: relationId } });
    await tx.kgRelation.delete({ where: { id: relationId } });
  }

  /** A speaker-naming-only Person, with its aliases and evidence. */
  private async deletePerson(tx: Tx, personId: string): Promise<void> {
    await tx.kgEvidence.deleteMany({ where: { subjectKind: 'entity', subjectId: personId } });
    await tx.kgEntityAlias.deleteMany({ where: { entityId: personId } });
    await tx.kgEntity.delete({ where: { id: personId } });
  }

  /**
   * Whether a Person exists ONLY because this transcript's speaker naming made
   * it — and so may go with its last edge. All of:
   *   - every alias is `speaker_naming`;
   *   - no remaining relation (either end), item, mention, merge or digest;
   *   - every evidence row cites a segment of THIS transcript.
   * Anything else means it has become knowledge in its own right: kept.
   */
  private async isSpeakerNamingOnly(tx: Tx, ownerId: string, personId: string, transcriptId: string): Promise<boolean> {
    const person = await tx.kgEntity.findFirst({ where: { id: personId, ownerId, type: PERSON }, select: { id: true } });
    if (!person) return false;

    const [
      otherAliases,
      relations,
      items,
      mentions,
      merges,
      mergedFrom,
      digests,
      foreignEvidence,
    ] = await Promise.all([
      tx.kgEntityAlias.count({ where: { entityId: personId, source: { not: 'speaker_naming' } } }),
      tx.kgRelation.count({ where: { OR: [{ fromId: personId }, { toId: personId }] } }),
      tx.kgItem.count({
        where: {
          OR: [{ subjectId: personId }, { meetingId: personId }, { ownerPersonId: personId }, { counterpartyId: personId }],
        },
      }),
      tx.kgMention.count({ where: { entityId: personId } }),
      tx.kgMerge.count({ where: { OR: [{ survivorId: personId }, { mergedId: personId }] } }),
      tx.kgEntity.count({ where: { mergedIntoId: personId } }),
      tx.kgEntityDigest.count({ where: { entityId: personId } }),
      tx.kgEvidence.count({
        where: {
          subjectKind: 'entity',
          subjectId: personId,
          OR: [{ transcriptId: null }, { transcriptId: { not: transcriptId } }, { segmentId: null }],
        },
      }),
    ]);

    return (
      otherAliases === 0 &&
      relations === 0 &&
      items === 0 &&
      mentions === 0 &&
      merges === 0 &&
      mergedFrom === 0 &&
      digests === 0 &&
      foreignEvidence === 0
    );
  }

  private async audit(
    tx: Tx,
    ownerId: string,
    action: string,
    transcriptId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        actorUserId: ownerId,
        action,
        targetType: KG_SUBJECT_TRANSCRIPT,
        targetId: transcriptId,
        meta: meta as Prisma.InputJsonValue,
      },
    });
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
