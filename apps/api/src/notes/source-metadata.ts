// =============================================================================
// What `note.source.extract` records, and where (issue #51, epic #45)
// =============================================================================
//
// ⚠ NO SIXTH TABLE — docs/specs/notes.md §4.7. The extracted plain text is a
// SECOND `storage_objects` row (managed by this module, like the upload it came
// from), and the link between them is a key in the FIRST object's own
// `metadata` JSONB. There is deliberately no `note_source_documents` table: the
// raw upload, the extracted text and the relationship between them are all
// things `storage_objects` and `PATCH /api/storage/objects/:id/metadata`
// already model, and a table whose only columns would be two object ids and a
// failure string earns nothing but a migration.
//
// TWO KEYS, AND THE SPLIT IS DELIBERATE:
//
//   • `extractedObjectId` is at the TOP LEVEL, because it is the contract
//     `note.generate` reads (`NoteSourceService.resolveDocument`) and it was
//     named by #49 before this issue existed. Moving it inside the block below
//     would break that agreement for one file's tidiness.
//
//   • everything else lives under ONE namespaced key. `metadata` is a shared
//     JSONB bag — the upload pipeline's processors write into it, the metadata
//     endpoint merges user-supplied keys into it, `example-checksum.handler.ts`
//     namespaces its own write for exactly this reason — so two writers that
//     both put a bare `status` at the top level silently overwrite each other.
//
// ⚠ PURE. No Nest, no Prisma. Both the handler (which writes it) and
// `NoteSourceService` (which reads it) import from here, which is what stops
// the two from spelling the key differently.
// =============================================================================

import type {
  ExtractionEncoding,
  ExtractionFailureReason,
} from './extraction/extraction-result';

/**
 * The metadata key holding the id of the extracted-text object.
 *
 * ⚠ PERMANENT. Already written down by #49's seam and read by
 * `NoteSourceService`; every source document extracted by any build carries it.
 */
export const EXTRACTED_OBJECT_ID_KEY = 'extractedObjectId';

/** The metadata key holding everything else this job recorded. */
export const EXTRACTION_METADATA_KEY = 'noteSourceExtraction';

/** What `note.source.extract` records about one attempt, permanently. */
export interface NoteSourceExtractionMetadata {
  /** `extracted` means `extractedObjectId` is set and points at real bytes. */
  status: 'extracted' | 'unextractable';
  /** Present only for `unextractable`. See `describeExtractionFailure`. */
  reason?: ExtractionFailureReason;
  /**
   * The sentence to show the user.
   *
   * STORED RATHER THAN RE-DERIVED AT READ TIME, even though
   * `describeExtractionFailure(reason)` would produce it. A stored sentence is
   * what a client that does not know this application's reason vocabulary can
   * render, and it is what an operator reading the row sees without consulting
   * a switch statement in another repository. `reason` remains the machine
   * value; this is the human one.
   */
  message?: string;
  /** Pages, or `null` for a format that has none. */
  pageCount: number | null;
  /** Present only for `extracted`. */
  encoding?: ExtractionEncoding;
  /** Characters of extracted text. Present only for `extracted`. */
  characters?: number;
  /** ISO 8601 — when the result was recorded, not when the bytes were read. */
  extractedAt: string;
  /** Which executor produced it. Useful when a fleet result looks wrong. */
  extractedBy: 'server' | 'node';
}

/**
 * `metadata` as a plain object, or `null` for anything that is not one.
 *
 * TOTAL OVER GARBAGE: the column is JSONB written by other modules and possibly
 * earlier builds, so it can be `null`, a string, or an array.
 */
export function asMetadataObject(metadata: unknown): Record<string, unknown> | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return null;
  }

  return metadata as Record<string, unknown>;
}

/**
 * `{ extractedObjectId }` out of a storage object's metadata, or `null`.
 *
 * TOTAL OVER GARBAGE, for the reason above — every malformed shape means the
 * same thing here: "no extracted text".
 */
export function readExtractedObjectId(metadata: unknown): string | null {
  const object = asMetadataObject(metadata);

  if (!object) return null;

  const value = object[EXTRACTED_OBJECT_ID_KEY];

  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The recorded extraction block, or `null`.
 *
 * Narrowed only as far as it is actually used — `status` and `message` — rather
 * than parsed against a schema. This value was written by this application into
 * its own row; the risk being defended against is a shape from an OLDER build,
 * not a hostile one, and a strict parse would turn "an older build wrote fewer
 * fields" into "no reason to show the user at all".
 */
export function readExtractionMetadata(
  metadata: unknown,
): Partial<NoteSourceExtractionMetadata> | null {
  const object = asMetadataObject(metadata);

  if (!object) return null;

  const block = asMetadataObject(object[EXTRACTION_METADATA_KEY]);

  return block ? (block as Partial<NoteSourceExtractionMetadata>) : null;
}

/**
 * Where a job's extracted text is stored.
 *
 * `notes/sources/<sourceObjectId>/extracted-<jobId>.txt`, exactly as
 * docs/specs/notes.md §4.7 specifies, and IDEMPOTENT PER JOB by construction:
 * both inputs are fixed on the job row before this can be called, so a node
 * asking again after a timed-out transfer gets the same key rather than
 * orphaning its first upload.
 *
 * The prefix states what the file is and whose it is, following
 * `media.audio.transcode`'s rendition-key precedent for the same reason: the
 * extracted text is a durable, externally-referenced artifact (the source
 * object's metadata names it), not scratch output nothing will ever name again.
 */
export function extractedTextStorageKey(sourceObjectId: string, jobId: string): string {
  return `notes/sources/${sourceObjectId}/extracted-${jobId}.txt`;
}

/**
 * Where an uploaded source document is stored.
 *
 * ⚠ KEYED BY A FRESH UUID, NOT BY THE OBJECT'S ROW ID, and the asymmetry with
 * `extractedTextStorageKey` above is forced rather than sloppy: bytes go to
 * storage BEFORE the row exists (see `NoteObjectsService.put`'s header for why
 * that order is the safe one), so at the moment this key is needed there is no
 * row id to key it by. The extracted text has no such problem — by then the
 * source row has existed for as long as the job has.
 *
 * The extension comes from the CANONICAL MIME TYPE the endpoint validated, not
 * from the uploaded filename: a name is attacker-controlled text that ends up
 * in a storage key, and `..%2f` in a filename is the whole reason storage keys
 * are not built from user input anywhere else in this repository either.
 */
export function sourceDocumentStorageKey(uploadId: string, extension: string): string {
  return `notes/sources/uploads/${uploadId}/source${extension}`;
}

/** The file extension this application stores one accepted document type as. */
export function documentExtension(
  mimeType: 'application/pdf' | 'text/plain' | 'text/markdown',
): string {
  switch (mimeType) {
    case 'application/pdf':
      return '.pdf';
    case 'text/markdown':
      return '.md';
    default:
      return '.txt';
  }
}
