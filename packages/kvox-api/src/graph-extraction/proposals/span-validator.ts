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
//
// TWO PHASES, ONE CONNECTION (#615). Resolving the origin transcript is a
// root-client walk (`NoteOriginService`: notes, transcripts, and the
// `TranscriptSharing.sharedWhere` port, which may read the database). On a
// one-connection pool (PGlite: KVox Desktop, the bare host's pglite leg) a
// root-client read inside an interactive transaction waits forever for the
// connection the transaction holds. So `prepare` runs BEFORE the caller opens
// its transaction and resolves the origin (only when a segment span needs it);
// `validate` runs inside it and touches only `tx`. The note itself (its
// current version, its bodies, the segment rows) is still read on `tx`, in the
// snapshot the write commits against.
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';

import { NoteOriginService } from '../../notes/index.js';
import type { EvidenceInput } from '@marinoscar/kvox-contract/graph';
import type { KvoxGraphDb, KvoxGraphTx } from '../../graph/index.js';
import { KVOX_PRISMA } from '../../ports/index.js';
import { GRAPH_CONFLICT_REASONS } from '../../graph/index.js';
import { PROPOSAL_BAD_REQUEST_REASONS, type EvidenceSpanInput } from './dto/proposal.dto.js';

type Tx = KvoxGraphTx;

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

/**
 * What `SpanValidator.validate` needs that does not come from its transaction,
 * resolved by `SpanValidator.prepare` before the transaction opens (#615).
 *
 * @internal
 * @stability experimental
 */
export interface SpanContext {
  /** The source this context was prepared for; `validate` refuses any other. */
  readonly ownerId: string;
  readonly noteId: string | null;
  /**
   * The proposal note's origin transcript as the owner may follow it right now,
   * or `null` when there is none. Absent when the prepared spans held no segment
   * span, so nothing was resolved.
   */
  readonly originTranscriptId?: string | null;
}

/** The note predicate both phases apply: the owner's own, live note. */
function liveNoteWhere(source: SpanSource & { noteId: string }) {
  return { id: source.noteId, ownerId: source.ownerId, deletedAt: null, status: { not: 'deleting' as const } };
}

/**
 * SpanValidator: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class SpanValidator {
  constructor(
    private readonly origin: NoteOriginService,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
  ) {}

  /**
   * Resolve what `validate` needs outside its transaction, through the root client
   * and the ports. Call it BEFORE opening the transaction `validate` runs on, never
   * inside it: on a one-connection pool those reads would wait for the connection
   * the transaction holds (#615). Read-only. With no segment span among `spans` it
   * reads nothing.
   */
  async prepare(source: SpanSource, spans: readonly EvidenceSpanInput[]): Promise<SpanContext> {
    const base = { ownerId: source.ownerId, noteId: source.noteId };
    if (!spans.some((span) => span.source === 'segment')) return base;
    if (!source.noteId) return { ...base, originTranscriptId: null };

    const note = await this.prisma.note.findFirst({
      where: liveNoteWhere({ ...source, noteId: source.noteId }),
      select: { id: true, sourceType: true, sourceTranscriptId: true, sourceNoteId: true },
    });
    const origin = note ? await this.origin.resolve(note, source.ownerId) : null;
    return { ...base, originTranscriptId: origin?.id ?? null };
  }

  /**
   * Validate every span, in order; return the evidence rows to store. Reads only
   * `tx`; `context` comes from `prepare(source, spans)`, run before the transaction.
   */
  async validate(
    tx: Tx,
    source: SpanSource,
    spans: readonly EvidenceSpanInput[],
    context: SpanContext,
  ): Promise<EvidenceInput[]> {
    if (spans.length === 0) return [];
    if (context.ownerId !== source.ownerId || context.noteId !== source.noteId) {
      // A programming bug, never a client error: the context was prepared for another source.
      throw new Error('SpanValidator.validate: the span context was prepared for a different source');
    }

    const outside = (index: number) =>
      badSpan(
        PROPOSAL_BAD_REQUEST_REASONS.SPAN_OUTSIDE_SOURCE,
        index,
        "This selection is not in the note this proposal was made from, or in that note's transcript.",
      );

    const note = source.noteId
      ? await tx.note.findFirst({
          where: liveNoteWhere({ ...source, noteId: source.noteId }),
          select: { id: true, currentVersion: true },
        })
      : null;

    // The origin transcript was resolved by `prepare`, before the transaction (#615).
    const originTranscriptId = (): string | null => {
      if (context.originTranscriptId === undefined) {
        // A programming bug: `prepare` was handed spans without this segment span.
        throw new Error('SpanValidator.validate: a segment span needs a context prepared with it');
      }
      return context.originTranscriptId;
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

      const transcriptId = originTranscriptId();
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
