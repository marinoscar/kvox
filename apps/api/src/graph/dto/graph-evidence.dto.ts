import { z } from 'zod';

// =============================================================================
// Evidence input (#355, epic #344; docs/specs/ontology.md §5.3)
// =============================================================================
//
// What a writer hands `GraphWriteService` for one citation. Reused verbatim by
// the proposal commit (#366). A citation anchors to a transcript segment, a
// note span, or an import source — the refine below admits exactly those three
// shapes. WHETHER the caller may cite that source is not a shape question:
// `EvidenceValidator.assertReadable` answers it against the database.
//
// `charStart`/`charEnd` are offsets into the cited NOTE VERSION BODY when
// `noteId` is set, or into the cited SEGMENT'S TEXT when `segmentId` is set
// (NULL = the whole segment) — the `kg_evidence` convention #351 documents.
// =============================================================================

export const evidenceInputSchema = z
  .object({
    transcriptId: z.uuid().nullable().default(null),
    segmentId: z.uuid().nullable().default(null),
    segmentRev: z.number().int().min(0).nullable().default(null),
    startMs: z.number().int().min(0).nullable().default(null),
    endMs: z.number().int().min(0).nullable().default(null),
    noteId: z.uuid().nullable().default(null),
    noteVersion: z.number().int().min(1).nullable().default(null),
    charStart: z.number().int().min(0).nullable().default(null),
    charEnd: z.number().int().min(0).nullable().default(null),
    quote: z.string().trim().min(1).max(2000),
    importObjectId: z.uuid().nullable().default(null),
    sourceIri: z.string().url().max(2048).nullable().default(null),
  })
  .refine(
    (e) =>
      (e.segmentId && e.transcriptId) ||
      (e.noteId && e.noteVersion && e.charStart !== null && e.charEnd !== null) ||
      e.importObjectId ||
      e.sourceIri,
    { message: 'Evidence needs a segment, a note span, or an import source.' },
  );

export type EvidenceInput = z.infer<typeof evidenceInputSchema>;
