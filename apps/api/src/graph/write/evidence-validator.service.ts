// =============================================================================
// EvidenceValidator (#355, epic #344; docs/specs/ontology.md §5.3, §12)
// =============================================================================
//
// A CITATION MUST NEVER BECOME A SIDE CHANNEL. Evidence is authored by the
// graph's owner, and it may anchor only to sources that owner can read:
//
//   - a NOTE the owner owns, not being deleted, at a VERSION that exists;
//   - a TRANSCRIPT the owner can VIEW — owned, or shared with them at either
//     role — not soft-deleted, and a SEGMENT that belongs to that transcript;
//   - an IMPORT OBJECT the owner uploaded.
//
// The transcript rule mirrors `TranscriptAccessService` exactly (owner, or a
// `transcript_shares` row for the owner; `deleted_at IS NULL`), but as ONE
// `findMany` over the whole batch rather than N `require` calls: a proposal
// commit can carry hundreds of citations.
//
// BOUNDED QUERIES: at most one query per source table (notes, note_versions,
// transcripts, transcript_segments, storage_objects), whatever the batch size,
// and none for a table the batch does not cite.
//
// A failure is a 400 naming the indexes of every invalid row
// (`details.invalidEvidence`) — never a 404: the caller is the owner authoring
// evidence, not a stranger probing for ids, and the answer is the same whether
// the cited row is missing or somebody else's, so nothing leaks.
//
// Runs on the CALLER'S transaction client: a note or transcript read here is
// read in the same snapshot the write commits against.
// =============================================================================

import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { evidenceInputSchema, type EvidenceInput } from '../dto/graph-evidence.dto';

export const INVALID_EVIDENCE_MESSAGE =
  'Some evidence cites a source you cannot read, or a segment or version that does not exist.';

@Injectable()
export class EvidenceValidator {
  /**
   * Parse every row (applying the DTO's defaults) and prove each anchor is
   * readable by `ownerId`. Returns the parsed rows, in order.
   */
  async assertReadable(
    ownerId: string,
    evidence: readonly EvidenceInput[],
    tx: Prisma.TransactionClient,
  ): Promise<EvidenceInput[]> {
    const invalid = new Set<number>();
    const parsed: EvidenceInput[] = evidence.map((row, index) => {
      const result = evidenceInputSchema.safeParse(row);
      if (!result.success) {
        invalid.add(index);
        return row;
      }
      return result.data;
    });

    // Anchor-shape rules the schema's refine does not force: an anchor that is
    // half present is invalid, whichever branch the row otherwise satisfied.
    parsed.forEach((row, index) => {
      if (invalid.has(index)) return;
      if (row.segmentId && !row.transcriptId) invalid.add(index);
      if (row.noteId && row.noteVersion === null) invalid.add(index);
      if (!row.noteId && row.noteVersion !== null) invalid.add(index);
    });

    const live = (index: number) => !invalid.has(index);
    const collect = (pick: (row: EvidenceInput) => string | null) => [
      ...new Set(
        parsed.flatMap((row, i) => {
          const value = live(i) ? pick(row) : null;
          return value ? [value] : [];
        }),
      ),
    ];

    const noteIds = collect((r) => r.noteId);
    const transcriptIds = collect((r) => r.transcriptId);
    const segmentIds = collect((r) => r.segmentId);
    const importObjectIds = collect((r) => r.importObjectId);

    const [notes, versions, transcripts, segments, objects] = await Promise.all([
      noteIds.length === 0
        ? Promise.resolve([] as { id: string }[])
        : tx.note.findMany({
            where: { id: { in: noteIds }, ownerId, status: { not: 'deleting' }, deletedAt: null },
            select: { id: true },
          }),
      noteIds.length === 0
        ? Promise.resolve([] as { noteId: string; version: number }[])
        : tx.noteVersion.findMany({
            where: {
              OR: parsed.flatMap((r, i) =>
                live(i) && r.noteId && r.noteVersion !== null
                  ? [{ noteId: r.noteId, version: r.noteVersion }]
                  : [],
              ),
            },
            select: { noteId: true, version: true },
          }),
      transcriptIds.length === 0
        ? Promise.resolve([] as { id: string }[])
        : tx.transcript.findMany({
            where: {
              id: { in: transcriptIds },
              deletedAt: null,
              OR: [{ ownerId }, { shares: { some: { userId: ownerId } } }],
            },
            select: { id: true },
          }),
      segmentIds.length === 0
        ? Promise.resolve([] as { id: string; transcriptId: string }[])
        : tx.transcriptSegment.findMany({
            where: { id: { in: segmentIds } },
            select: { id: true, transcriptId: true },
          }),
      importObjectIds.length === 0
        ? Promise.resolve([] as { id: string }[])
        : tx.storageObject.findMany({
            where: { id: { in: importObjectIds }, uploadedById: ownerId },
            select: { id: true },
          }),
    ]);

    const readableNotes = new Set(notes.map((n) => n.id));
    const existingVersions = new Set(versions.map((v) => `${v.noteId}:${v.version}`));
    const viewableTranscripts = new Set(transcripts.map((t) => t.id));
    const segmentTranscript = new Map(segments.map((s) => [s.id, s.transcriptId]));
    const ownedObjects = new Set(objects.map((o) => o.id));

    parsed.forEach((row, index) => {
      if (!live(index)) return;
      if (row.noteId) {
        if (!readableNotes.has(row.noteId) || !existingVersions.has(`${row.noteId}:${row.noteVersion}`)) {
          invalid.add(index);
        }
      }
      if (row.transcriptId && !viewableTranscripts.has(row.transcriptId)) invalid.add(index);
      if (row.segmentId && segmentTranscript.get(row.segmentId) !== row.transcriptId) invalid.add(index);
      if (row.importObjectId && !ownedObjects.has(row.importObjectId)) invalid.add(index);
    });

    if (invalid.size > 0) {
      throw new BadRequestException({
        message: INVALID_EVIDENCE_MESSAGE,
        details: { invalidEvidence: [...invalid].sort((a, b) => a - b) },
      });
    }

    return parsed;
  }
}
