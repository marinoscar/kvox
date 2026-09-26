// =============================================================================
// GraphEvidenceService (#370, epic #347; docs/specs/ontology.md §5.3, §10, §12)
// =============================================================================
//
// Turns `kg_evidence` rows into citation links a client can open: a playable
// deep link into a transcript segment, or a link to the exact note version a
// span was drawn from.
//
// THE QUOTE ALWAYS COMES BACK. It is the owner's own graph data, and §10 is
// explicit that `quote` is what keeps a citation readable after the source is
// gone. What can disappear is the LINK: `available: false` — with the title,
// the current revision and the `href` nulled — when
//
//   - `SetNull` cleared the pointer (the transcript/segment/note was deleted),
//   - the transcript or note is soft-deleted, or
//   - the caller can no longer VIEW it: a transcript share was revoked.
//
// Access is decided by `TranscriptAccessService.roleFor` and
// `NoteAccessService.roleFor` — the one definition of "who may read this" each
// module owns — never re-derived here. Nothing about a source the caller can
// no longer see (its title, its current revision) is returned.
//
// Bounded: one query per source table for a whole batch, plus at most one
// share lookup per distinct transcript the caller does not own.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { KgEvidence } from '@prisma/client';

import { NoteAccessService } from '../../notes/access/note-access.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptAccessService } from '../../transcripts/transcript-access.service';
import { GraphAccessService } from '../access/graph-access.service';
import type { EvidenceLink } from './dto/graph-read.dto';

export type EvidenceSourceKind = 'segment' | 'note' | 'import';

/** The subjects `listForSubject` accepts — the three kinds of curated graph row. */
export type EvidenceSubjectKind = 'entity' | 'relation' | 'item';

/** One citation of a subject, with the date of the source it quotes. */
export interface SubjectEvidence {
  link: EvidenceLink;
  /**
   * The cited source's date — a transcript's `recorded_at`, a note's
   * `created_at` — or null when unknown or when the source is no longer
   * available to the caller (its date is then not theirs to see either).
   */
  occurredAt: Date | null;
}

/** The most citations `listForSubject` returns. */
export const SUBJECT_EVIDENCE_MAX = 50;

/** Which anchor a row cites. `note_version`/`segment_rev` survive `SetNull`, so the kind does too. */
export function evidenceSourceKind(
  row: Pick<
    KgEvidence,
    'importObjectId' | 'sourceIri' | 'noteId' | 'noteVersion' | 'charStart' | 'transcriptId' | 'segmentId'
  > & { subjectKind: string },
): EvidenceSourceKind {
  if (row.subjectKind === 'import' || row.importObjectId !== null || row.sourceIri !== null) return 'import';
  if (row.noteId !== null || row.noteVersion !== null) return 'note';
  return 'segment';
}

/** `/transcripts/<id>?segment=<segmentId>&t=<startMs>`, omitting what is unknown. */
export function segmentHref(transcriptId: string, segmentId: string | null, startMs: number | null): string {
  const params = new URLSearchParams();
  if (segmentId) params.set('segment', segmentId);
  if (startMs !== null) params.set('t', String(startMs));
  const query = params.toString();
  return `/transcripts/${transcriptId}${query ? `?${query}` : ''}`;
}

/** `/notes/<id>?v=<version>`. */
export function noteHref(noteId: string, noteVersion: number | null): string {
  return noteVersion === null ? `/notes/${noteId}` : `/notes/${noteId}?v=${noteVersion}`;
}

@Injectable()
export class GraphEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GraphAccessService,
    private readonly transcriptAccess: TranscriptAccessService,
    private readonly noteAccess: NoteAccessService,
  ) {}

  /** One citation. Not the caller's → the shared evidence 404. */
  async getOne(userId: string, id: string): Promise<EvidenceLink> {
    const row = await this.access.require(userId, 'evidence', id, 'view');
    const [link] = await this.resolve(userId, [row]);
    return link;
  }

  /** Up to 50 citations, in request order. Unknown or foreign ids are silently omitted. */
  async getMany(userId: string, ids: readonly string[]): Promise<EvidenceLink[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const rows = await this.prisma.kgEvidence.findMany({ where: { id: { in: unique }, ownerId: userId } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return this.resolve(
      userId,
      unique.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    );
  }

  /**
   * The caller's citations of one subject, NEWEST SOURCE FIRST (a transcript's
   * `recorded_at`, a note's `created_at`, then the citation's own
   * `created_at`), resolved to links (#377's `evidence` tool).
   *
   * Owner-scoped in the statement itself: another owner's subject id yields an
   * empty list, never their rows. Does not check that the subject is readable
   * — callers that must (the Ask tool) check first.
   */
  async listForSubject(
    ownerId: string,
    subjectKind: EvidenceSubjectKind,
    subjectId: string,
    limit: number,
  ): Promise<SubjectEvidence[]> {
    const take = Math.max(1, Math.min(SUBJECT_EVIDENCE_MAX, Math.floor(limit)));
    const ordered = await this.prisma.$queryRaw<{ id: string; at: Date | null }[]>`
      SELECT ev.id::text AS id, coalesce(t.recorded_at, n.created_at) AS at
      FROM kg_evidence ev
      LEFT JOIN transcripts t ON t.id = ev.transcript_id
      LEFT JOIN notes n ON n.id = ev.note_id
      WHERE ev.owner_id = ${ownerId}::uuid
        AND ev.subject_kind = ${subjectKind}::kg_evidence_subject_kind
        AND ev.subject_id = ${subjectId}::uuid
      ORDER BY coalesce(t.recorded_at, n.created_at) DESC NULLS LAST, ev.created_at DESC, ev.id DESC
      LIMIT ${take}`;
    if (ordered.length === 0) return [];
    const rows = await this.prisma.kgEvidence.findMany({ where: { id: { in: ordered.map((r) => r.id) }, ownerId } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const present = ordered.filter((r) => byId.has(r.id));
    const links = await this.resolve(ownerId, present.map((r) => byId.get(r.id)!));
    return links.map((link, i) => ({ link, occurredAt: link.source.available ? present[i].at : null }));
  }

  /**
   * Resolve rows the caller already owns (callers: #372's brief, #377's agent).
   * ⚠ Does not check ownership of `rows` itself — pass only the caller's rows.
   */
  async resolve(userId: string, rows: readonly KgEvidence[]): Promise<EvidenceLink[]> {
    if (rows.length === 0) return [];

    const distinct = (pick: (r: KgEvidence) => string | null) => [
      ...new Set(rows.map(pick).filter((v): v is string => v !== null)),
    ];
    const transcriptIds = distinct((r) => r.transcriptId);
    const segmentIds = distinct((r) => r.segmentId);
    const noteIds = distinct((r) => r.noteId);
    const objectIds = distinct((r) => r.importObjectId);

    const [transcripts, segments, notes, objects] = await Promise.all([
      transcriptIds.length ? this.prisma.transcript.findMany({ where: { id: { in: transcriptIds } } }) : [],
      segmentIds.length
        ? this.prisma.transcriptSegment.findMany({
            where: { id: { in: segmentIds } },
            select: { id: true, transcriptId: true, rev: true },
          })
        : [],
      noteIds.length ? this.prisma.note.findMany({ where: { id: { in: noteIds } } }) : [],
      objectIds.length
        ? this.prisma.storageObject.findMany({
            where: { id: { in: objectIds } },
            select: { id: true, uploadedById: true },
          })
        : [],
    ]);

    // Which transcripts the caller may VIEW right now — the module's own rule.
    const viewableTranscripts = new Map<string, { title: string }>();
    for (const t of transcripts) {
      if (t.deletedAt !== null) continue;
      if ((await this.transcriptAccess.roleFor(userId, t)) !== null) viewableTranscripts.set(t.id, { title: t.title });
    }
    const segmentById = new Map(segments.map((s) => [s.id, s]));
    const viewableNotes = new Map<string, { title: string; currentVersion: number }>();
    for (const n of notes) {
      if (n.deletedAt !== null) continue;
      if (this.noteAccess.roleFor(userId, n) !== null) {
        viewableNotes.set(n.id, { title: n.title, currentVersion: n.currentVersion });
      }
    }
    const ownedObjects = new Set(objects.filter((o) => o.uploadedById === userId).map((o) => o.id));

    return rows.map((row) => {
      const base = {
        id: row.id,
        subjectKind: row.subjectKind,
        subjectId: row.subjectId,
        quote: row.quote,
        createdAt: row.createdAt.toISOString(),
      };

      switch (evidenceSourceKind(row)) {
        case 'import': {
          return {
            ...base,
            source: {
              kind: 'import' as const,
              importObjectId: row.importObjectId,
              sourceIri: row.sourceIri,
              available: row.importObjectId !== null && ownedObjects.has(row.importObjectId),
              href: null,
            },
          };
        }
        case 'note': {
          const note = row.noteId ? viewableNotes.get(row.noteId) : undefined;
          const available = note !== undefined;
          return {
            ...base,
            source: {
              kind: 'note' as const,
              noteId: row.noteId,
              noteTitle: note?.title ?? null,
              noteVersion: row.noteVersion,
              currentNoteVersion: note?.currentVersion ?? null,
              charStart: row.charStart,
              charEnd: row.charEnd,
              versionChanged: available && note.currentVersion !== row.noteVersion,
              available,
              href: available && row.noteId ? noteHref(row.noteId, row.noteVersion) : null,
            },
          };
        }
        case 'segment': {
          const transcript = row.transcriptId ? viewableTranscripts.get(row.transcriptId) : undefined;
          const available = transcript !== undefined;
          const segment = row.segmentId ? segmentById.get(row.segmentId) : undefined;
          // Only a segment of THIS transcript counts, and only while the caller can see it.
          const currentSegmentRev =
            available && segment && segment.transcriptId === row.transcriptId ? segment.rev : null;
          return {
            ...base,
            source: {
              kind: 'segment' as const,
              transcriptId: row.transcriptId,
              transcriptTitle: transcript?.title ?? null,
              segmentId: row.segmentId,
              segmentRev: row.segmentRev,
              currentSegmentRev,
              startMs: row.startMs,
              endMs: row.endMs,
              // Not "changed" when we cannot look: an unavailable source reports nothing about itself.
              textChanged: available && currentSegmentRev !== row.segmentRev,
              available,
              href: available && row.transcriptId ? segmentHref(row.transcriptId, row.segmentId, row.startMs) : null,
            },
          };
        }
      }
    });
  }
}
