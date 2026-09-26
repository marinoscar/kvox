// =============================================================================
// SpanValidator (#366; docs/specs/ontology.md §5.3, §19.2, §19.3)
// =============================================================================
//
// A reviewer adds evidence by SELECTING TEXT — in the note, or in a line of
// the note's source transcript. What the client sends is a span (offsets plus
// the text it saw); what gets stored is a `kg_evidence` row. Between the two,
// this proves the span is real:
//
//   note span     the proposal's own note; `noteVersion` must be the note's
//                 CURRENT version (409 `stale_note_version` otherwise — the
//                 reviewer selected text in a body that has moved on) and must
//                 exist; `0 ≤ charStart < charEnd ≤ body.length`; the slice
//                 equals `quote` after NFC + whitespace collapse on both
//                 sides (400 `span_mismatch` otherwise).
//   segment span  the segment must belong to the proposal note's ORIGIN
//                 transcript (`NoteOriginService.resolve`, which follows a
//                 chain of notes and applies the caller's own visibility) —
//                 400 `span_outside_source` otherwise; `segment.rev ===
//                 segmentRev` (409 `stale_segment_rev`); bounds and quote as
//                 above. The stored row carries the segment's `start_ms/end_ms`.
//
// A citation must never become a side channel (§12): a segment of some other
// transcript — even one the caller can read — is outside this proposal's
// source, so it is refused here rather than admitted by the looser
// `EvidenceValidator` rule.
// =============================================================================

import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { NoteOriginService } from '../../notes/note-origin.service';
import type { EvidenceInput } from '../dto/graph-evidence.dto';
import { GRAPH_CONFLICT_REASONS } from '../graph-conflict-reasons';
import { PROPOSAL_BAD_REQUEST_REASONS, type EvidenceSpanInput } from './dto/proposal.dto';

type Tx = Prisma.TransactionClient;

/** NFC, every whitespace run collapsed to one space, trimmed. Case is significant. */
export function normalizeSpanText(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Whether `text.slice(charStart, charEnd)` is `quote`, after normalization. PURE. */
export function spanMatches(text: string, charStart: number, charEnd: number, quote: string): boolean {
  if (!(charStart >= 0 && charStart < charEnd && charEnd <= text.length)) return false;
  const slice = normalizeSpanText(text.slice(charStart, charEnd));
  return slice !== '' && slice === normalizeSpanText(quote);
}

function badSpan(reason: string, index: number, message: string): BadRequestException {
  return new BadRequestException({ message, details: { reason, index } });
}

export interface SpanSource {
  ownerId: string;
  /** The proposal's note; null for a proposal with no note (resolution/import). */
  noteId: string | null;
}

@Injectable()
export class SpanValidator {
  constructor(private readonly origin: NoteOriginService) {}

  /** Validate every span, in order; return the evidence rows to store. */
  async validate(tx: Tx, source: SpanSource, spans: readonly EvidenceSpanInput[]): Promise<EvidenceInput[]> {
    if (spans.length === 0) return [];

    const outside = (index: number) =>
      badSpan(
        PROPOSAL_BAD_REQUEST_REASONS.SPAN_OUTSIDE_SOURCE,
        index,
        "This selection is not in the note this proposal was made from, or in that note's transcript.",
      );

    const note = source.noteId
      ? await tx.note.findFirst({
          where: { id: source.noteId, ownerId: source.ownerId, deletedAt: null, status: { not: 'deleting' } },
          select: { id: true, currentVersion: true, sourceType: true, sourceTranscriptId: true, sourceNoteId: true },
        })
      : null;

    // The origin transcript is resolved once, and only when a segment span needs it.
    let originId: string | null | undefined;
    const originTranscriptId = async (): Promise<string | null> => {
      if (originId === undefined) {
        originId = note ? ((await this.origin.resolve(note, source.ownerId))?.id ?? null) : null;
      }
      return originId;
    };

    const out: EvidenceInput[] = [];
    for (const [index, span] of spans.entries()) {
      if (!note) throw outside(index);
      if (span.source === 'note') {
        if (span.noteVersion !== note.currentVersion) {
          throw new ConflictException({
            message: 'The note has changed since you selected this text. Reload it and select again.',
            details: { reason: GRAPH_CONFLICT_REASONS.STALE_NOTE_VERSION, index, currentVersion: note.currentVersion },
          });
        }
        const version = await tx.noteVersion.findUnique({
          where: { noteId_version: { noteId: note.id, version: span.noteVersion } },
          select: { body: true },
        });
        if (!version || !spanMatches(version.body, span.charStart, span.charEnd, span.quote)) {
          throw badSpan(PROPOSAL_BAD_REQUEST_REASONS.SPAN_MISMATCH, index, 'The selected text does not match the note at those positions.');
        }
        out.push({
          transcriptId: null,
          segmentId: null,
          segmentRev: null,
          startMs: null,
          endMs: null,
          noteId: note.id,
          noteVersion: span.noteVersion,
          charStart: span.charStart,
          charEnd: span.charEnd,
          quote: normalizeSpanText(version.body.slice(span.charStart, span.charEnd)),
          importObjectId: null,
          sourceIri: null,
        });
        continue;
      }

      const transcriptId = await originTranscriptId();
      const segment = transcriptId
        ? await tx.transcriptSegment.findFirst({
            where: { id: span.segmentId, transcriptId },
            select: { id: true, transcriptId: true, rev: true, text: true, startMs: true, endMs: true },
          })
        : null;
      if (!segment) throw outside(index);
      if (segment.rev !== span.segmentRev) {
        throw new ConflictException({
          message: 'That transcript line has been corrected since you selected it. Reload it and select again.',
          details: { reason: GRAPH_CONFLICT_REASONS.STALE_SEGMENT_REV, index, currentRev: segment.rev },
        });
      }
      if (!spanMatches(segment.text, span.charStart, span.charEnd, span.quote)) {
        throw badSpan(PROPOSAL_BAD_REQUEST_REASONS.SPAN_MISMATCH, index, 'The selected text does not match the transcript line at those positions.');
      }
      out.push({
        transcriptId: segment.transcriptId,
        segmentId: segment.id,
        segmentRev: segment.rev,
        startMs: segment.startMs,
        endMs: segment.endMs,
        noteId: null,
        noteVersion: null,
        charStart: span.charStart,
        charEnd: span.charEnd,
        quote: normalizeSpanText(segment.text.slice(span.charStart, span.charEnd)),
        importObjectId: null,
        sourceIri: null,
      });
    }
    return out;
  }
}
