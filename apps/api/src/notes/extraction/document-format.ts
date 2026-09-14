// =============================================================================
// What this application accepts as a document source (issue #51, epic #45)
// =============================================================================
//
// THREE TYPES, AND THE LIST IS THE ERROR MESSAGE. `POST /api/notes/sources/
// documents` refuses anything else AT THE DOOR — before a storage object row
// exists, before a job is enqueued — and the refusal names every type that
// would have worked. The alternative the issue rejects is accepting the upload
// and discovering the problem inside `note.source.extract` minutes later, which
// leaves an orphan object the user cannot delete (it is `managed_by: 'notes'`)
// and a failed job to explain.
//
// ⚠ THIS FILE IS PURE. No Nest decorators, no injection, no I/O — the same
// discipline `transcripts/editing/` lives under, and for the same practical
// reason: every function here is unit-testable against a fixture buffer without
// standing up a container.
// =============================================================================

/** Every MIME type a note source document may be uploaded as. */
export const NOTE_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
] as const;

/** One accepted document MIME type. */
export type NoteDocumentMimeType = (typeof NOTE_DOCUMENT_MIME_TYPES)[number];

/**
 * Aliases browsers and operating systems send for the three accepted types.
 *
 * A CANONICALISATION TABLE RATHER THAN A WIDER ALLOW-LIST. A `.md` file is sent
 * as `text/markdown` by Chrome on Linux, as `text/x-markdown` by some older
 * tooling, and as `application/octet-stream` by a Windows machine with no
 * registry entry for the extension at all. Mapping the spellings we recognise
 * onto one canonical value means the rest of this module — the extractor
 * dispatch, the stored `mime_type`, the job payload — only ever sees three
 * strings, while a user is not told their Markdown file is "not a Markdown
 * file" because of a registry entry they have never heard of.
 *
 * `application/octet-stream` is deliberately ABSENT: it means "I have no idea
 * what this is", and guessing from a filename extension is how an executable
 * gets stored as `text/plain`. Such an upload is refused with the list.
 */
const MIME_ALIASES: Readonly<Record<string, NoteDocumentMimeType>> = {
  'application/pdf': 'application/pdf',
  'application/x-pdf': 'application/pdf',
  'text/plain': 'text/plain',
  'text/markdown': 'text/markdown',
  'text/x-markdown': 'text/markdown',
  'text/md': 'text/markdown',
};

/**
 * The canonical accepted type for `raw`, or `null` if this is not one.
 *
 * TOTAL OVER GARBAGE. `raw` comes off a multipart part header written by
 * whatever client made the request, so it can carry parameters
 * (`text/plain; charset=utf-8`), odd casing (`Application/PDF`), or surrounding
 * whitespace. All three describe an accepted type and all three would fail a
 * naive `includes()` check.
 */
export function normalizeDocumentMimeType(
  raw: string | null | undefined,
): NoteDocumentMimeType | null {
  if (typeof raw !== 'string') return null;

  // Everything after the first `;` is a parameter list (`charset`, `boundary`),
  // never part of the type itself.
  const essence = raw.split(';')[0]?.trim().toLowerCase() ?? '';

  return MIME_ALIASES[essence] ?? null;
}

/** The accepted list, spelled the way an error message should spell it. */
export function acceptedDocumentTypesSentence(): string {
  return NOTE_DOCUMENT_MIME_TYPES.join(', ');
}
