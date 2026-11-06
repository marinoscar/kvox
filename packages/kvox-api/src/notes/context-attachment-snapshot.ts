// =============================================================================
// The attachment snapshot on a generation (issue #810)
// =============================================================================
//
// `note_generations.context_attachments` is a JSONB array written when a generation is requested:
// `[{ objectId, kind, filename, mimeType }]`, in the order the model sees them. It is what makes a
// regeneration and `GET /notes/:id/context` reproducible when the note's live attachments change.
//
// ⚠ PURE AND TOTAL OVER GARBAGE (no Nest, no Prisma): the column is JSONB, a row from an older
// build has none, and a malformed entry is dropped rather than turned into a crash.
// =============================================================================

import type { NoteContextAttachment } from '@marinoscar/kvox-contract/notes';

/**
 * The attachments a snapshot records, or `[]` for `null`, a non-array or entries of the wrong shape.
 *
 * @param value - the stored JSON.
 * @returns the attachments, in stored order.
 * @stability experimental
 */
export function readContextAttachmentsSnapshot(value: unknown): NoteContextAttachment[] {
  if (!Array.isArray(value)) return [];

  const out: NoteContextAttachment[] = [];

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;

    const { objectId, kind, filename, mimeType } = entry as Record<string, unknown>;

    if (
      typeof objectId !== 'string' ||
      (kind !== 'document' && kind !== 'image') ||
      typeof filename !== 'string' ||
      typeof mimeType !== 'string'
    ) {
      continue;
    }

    out.push({ objectId, kind, filename, mimeType });
  }

  return out;
}
