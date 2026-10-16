// =============================================================================
// ExtractionInputLoader (#363; docs/specs/ontology.md §6)
// =============================================================================
//
// THE ONLY DATABASE READER of an extraction. It loads everything a run needs
// ONCE into a plain `ExtractionInput`, and nothing re-reads mid-run — the
// "assemble once, act on that snapshot" posture `assemblePrompt` takes for
// note generation. Every query is scoped to the note's owner.
//
// ⚠ Never logs anything it reads: note text, names and transcripts are the
// user's private content.
// =============================================================================

import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { defaultSpeakerName, parseSpeakerIdentities } from '../../transcripts/editing/speaker-identity';
import { NOTE_NOT_FOUND_MESSAGE } from '../../notes/access/note-access.service';
import { NoteOriginService } from '../../notes/note-origin.service';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import type { UserGuidance } from './dto/extraction.dto';
import { MAX_KNOWN_ENTITIES, type ExtractionInput, type KnownEntityRow } from './extraction-context';

/** How far back "recently mentioned" looks (§6). */
export const RECENT_MENTION_DAYS = 90;
/** Entities the Context text is matched against, most recently updated first. */
export const CONTEXT_POOL_LIMIT = 2000;

const LIVE = { reviewStatus: { in: ['accepted', 'edited'] as ('accepted' | 'edited')[] }, mergedIntoId: null };

export interface LoadExtractionInput {
  userId: string;
  noteId: string;
  /** The version to extract from. Defaults to the note's current version. */
  noteVersion?: number;
  guidance: UserGuidance | null;
}

@Injectable()
export class ExtractionInputLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly origin: NoteOriginService,
    private readonly ontology: GraphOntologyService,
  ) {}

  async load(args: LoadExtractionInput): Promise<ExtractionInput> {
    const { userId, noteId } = args;
    const note = await this.prisma.note.findUnique({ where: { id: noteId } });
    if (!note || note.ownerId !== userId || note.deletedAt !== null || note.status === 'deleting') {
      throw new NotFoundException(NOTE_NOT_FOUND_MESSAGE);
    }
    const version = args.noteVersion ?? note.currentVersion;
    const versionRow = await this.prisma.noteVersion.findUnique({
      where: { noteId_version: { noteId, version } },
      select: { body: true },
    });
    // A note always has a version row once it is ready; the live body is the
    // copy of the current one, so it is a faithful fallback for exactly that.
    const bodyAtVersion = versionRow?.body ?? (version === note.currentVersion ? note.body : '');

    const origin = await this.origin.resolve(note, userId);
    const transcript = origin
      ? await this.prisma.transcript.findUnique({
          where: { id: origin.id },
          select: { id: true, title: true, recordedAt: true, createdAt: true, speakerIdentities: true },
        })
      : null;

    const [segments, speakerRows] = transcript
      ? await Promise.all([
          this.prisma.transcriptSegment.findMany({
            where: { transcriptId: transcript.id },
            orderBy: { ordinal: 'asc' },
            select: { id: true, rev: true, startMs: true, endMs: true, speakerId: true, text: true },
          }),
          this.prisma.transcriptSpeaker.findMany({
            where: { transcriptId: transcript.id },
            orderBy: [{ label: 'asc' }, { id: 'asc' }],
            select: { id: true, label: true, displayName: true },
          }),
        ])
      : [[], []];

    // Speaker names: the live row with the `speaker_identities` overlay, as
    // `materialize()` shows it; a placeholder name is "unidentified".
    const identities = parseSpeakerIdentities(transcript?.speakerIdentities ?? {});
    const speakerIds = speakerRows.map((s) => s.id);
    const links = speakerIds.length
      ? await this.prisma.kgRelation.findMany({
          where: { ownerId: userId, type: 'IDENTIFIED_AS', fromSpeakerId: { in: speakerIds } },
          select: { fromSpeakerId: true, toId: true },
        })
      : [];
    const personBySpeaker = new Map(links.map((l) => [l.fromSpeakerId as string, l.toId]));
    const speakers = speakerRows.map((s) => {
      const placeholder = s.label !== null && s.displayName === defaultSpeakerName(s.label);
      const overlaid = placeholder ? (identities[s.id] ?? null) : s.displayName;
      const name = overlaid && overlaid.trim().length > 0 ? overlaid : null;
      return { id: s.id, label: s.label, displayName: name, personEntityId: personBySpeaker.get(s.id) ?? null };
    });

    const effectiveSchema = await this.ontology.effectiveSchemaFor(userId);

    // Known-entity candidates, per priority bucket (the pure builder merges).
    const pinnedIds = args.guidance?.pinnedEntityIds ?? [];
    const speakerPersonIds = [...new Set(links.map((l) => l.toId))];
    const worksFor = speakerPersonIds.length
      ? await this.prisma.kgRelation.findMany({
          where: { ownerId: userId, type: 'WORKS_FOR', fromId: { in: speakerPersonIds }, reviewStatus: { in: ['accepted', 'edited'] } },
          select: { fromId: true, toId: true },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const orgIds = [...new Set(worksFor.map((w) => w.toId))];

    const since = new Date(Date.now() - RECENT_MENTION_DAYS * 24 * 60 * 60 * 1000);
    const recent = await this.prisma.kgMention.groupBy({
      by: ['entityId'],
      where: { ownerId: userId, createdAt: { gte: since } },
      _count: { entityId: true },
      orderBy: { _count: { entityId: 'desc' } },
      take: MAX_KNOWN_ENTITIES,
    });
    const recentIds = recent.map((r) => r.entityId);

    const contextPool =
      note.contextText && note.contextText.trim().length > 0
        ? await this.rows({ ownerId: userId, ...LIVE }, CONTEXT_POOL_LIMIT)
        : [];

    const byIds = await this.rows({
      ownerId: userId,
      id: { in: [...new Set([...pinnedIds, ...speakerPersonIds, ...orgIds, ...recentIds])] },
    });
    const byId = new Map(byIds.map((r) => [r.id, r]));
    const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((r): r is KnownEntityRow => r !== undefined);

    // A Person's organization label, for the known-entity line.
    for (const w of worksFor) {
      const person = byId.get(w.fromId as string);
      const org = byId.get(w.toId);
      if (person && org && !person.orgLabel) person.orgLabel = org.label;
    }

    const existingMeeting = await this.prisma.kgEntity.findFirst({
      where: {
        ownerId: userId,
        type: 'Meeting',
        mergedIntoId: null,
        OR: [
          ...(transcript ? [{ props: { path: ['transcriptId'], equals: transcript.id } }] : []),
          { props: { path: ['noteId'], equals: note.id } },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    return {
      note: {
        id: note.id,
        title: note.title,
        bodyAtVersion,
        version,
        contextText: note.contextText,
        createdAt: note.createdAt,
      },
      transcript: transcript
        ? { id: transcript.id, title: transcript.title, recordedAt: transcript.recordedAt, createdAt: transcript.createdAt }
        : null,
      segments,
      speakers,
      effectiveSchema,
      guidance: args.guidance,
      knownEntityCandidates: {
        pinned: pick(pinnedIds),
        speakerPersons: pick(speakerPersonIds),
        organizations: pick(orgIds),
        contextPool,
        recentlyMentioned: pick(recentIds),
      },
      existingMeeting,
    };
  }

  /** Entities with their alias strings, as `KnownEntityRow`s. */
  private async rows(where: Prisma.KgEntityWhereInput, take?: number): Promise<KnownEntityRow[]> {
    const entities = await this.prisma.kgEntity.findMany({
      where,
      take,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        type: true,
        label: true,
        reviewStatus: true,
        mergedIntoId: true,
        aliases: { select: { alias: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    return entities.map((e) => ({
      id: e.id,
      type: e.type,
      label: e.label,
      aliases: e.aliases.map((a) => a.alias),
      reviewStatus: e.reviewStatus,
      mergedIntoId: e.mergedIntoId,
      orgLabel: null,
    }));
  }
}
