
/**
 * Every MIME type a note source document may be uploaded as.
 *
 * @stability experimental
 */
export const NOTE_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
] as const;

/**
 * One accepted document MIME type.
 *
 * @stability experimental
 */
export type NoteDocumentMimeType = (typeof NOTE_DOCUMENT_MIME_TYPES)[number];
