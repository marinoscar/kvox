// =============================================================================
// The stored text of a note's source document (#789, epic #773)
// =============================================================================
//
// A note GENERATED FROM A DOCUMENT keeps the document's full text as a second
// `storage_objects` row (`note.source.extract`, docs/specs/notes.md §4.7): the
// uploaded object's own metadata records `{ extractedObjectId }`. `kg.extract`
// reads that text as its input (chunked, #777) and cites it with offsets, and the
// span validator re-reads the same text to prove a reviewer's selection of it.
// Both go through here, so "which text counts" has one definition.
//
// Which notes qualify, and why:
//
//   - `sourceType === 'document'` with a `sourceObjectId`: a transcript or note
//     source has no document;
//   - `provider !== null`: the note was AI-GENERATED from the document. An IMPORTED
//     note (no provider) has the document as its body, so the body already is the
//     text and a second copy would only double every citation.
//
// The text object must be the owner's own module-managed object: a citation can
// never name somebody else's file. Every way of not finding a usable text is
// `null`, never an error, so a purged source or an oversized one falls back to the
// note instead of failing an extraction or a review.
// =============================================================================

import { readExtractedObjectId } from '../../notes/index.js';
import type { KvoxObjectStorePort } from '../../ports/index.js';

/**
 * The longest source text (characters) an extraction reads. A longer one is not
 * offered: the run reads the note instead. The chunker bounds the number of calls
 * (`MAX_CHUNKS`), so beyond this a chunk would not fit a model's window anyway.
 */
export const MAX_SOURCE_TEXT_CHARS = 1_500_000;

/** What decides whether a note has a source text. A full note row satisfies it. */
export interface NoteSourceFields {
  sourceType: string;
  sourceObjectId: string | null;
  provider: string | null;
}

/** The stored extracted text of a note's source document. */
export interface NoteSourceText {
  /** The `storage_objects` row holding the text; a citation anchors to it. */
  objectId: string;
  text: string;
}

/** Why a text was not offered; the caller logs it (never the text or an error message). */
export type SourceTextSkip = 'too_large' | 'unreadable';

/**
 * The text extracted from the document `note` was generated from, or null.
 *
 * @param onSkip - called with the reason when a text exists but is not offered.
 */
export async function readNoteSourceText(
  store: Pick<KvoxObjectStorePort, 'describe' | 'openRead'>,
  note: NoteSourceFields,
  ownerId: string,
  onSkip?: (reason: SourceTextSkip) => void,
): Promise<NoteSourceText | null> {
  if (note.sourceType !== 'document' || !note.sourceObjectId || note.provider === null) return null;
  try {
    const source = (await store.describe([note.sourceObjectId])).get(note.sourceObjectId);
    const extractedId = readExtractedObjectId(source?.metadata ?? null);
    if (!extractedId) return null;
    const extracted = (await store.describe([extractedId])).get(extractedId);
    if (!extracted || extracted.ownerId !== ownerId || extracted.managedBy == null) return null;
    // UTF-8 is at most 4 bytes a character: a file this large cannot fit under the cap.
    if (extracted.size > MAX_SOURCE_TEXT_CHARS * 4) {
      onSkip?.('too_large');
      return null;
    }
    const parts: Buffer[] = [];
    for await (const part of await store.openRead(extractedId)) {
      parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part as string));
    }
    const text = Buffer.concat(parts).toString('utf8');
    if (text.trim().length === 0) return null;
    if (text.length > MAX_SOURCE_TEXT_CHARS) {
      onSkip?.('too_large');
      return null;
    }
    return { objectId: extractedId, text };
  } catch {
    onSkip?.('unreadable');
    return null;
  }
}
