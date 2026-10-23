
/**
 * The Word (.docx) MIME type. Office Open XML: a ZIP of XML parts, never the legacy
 * binary `.doc` (an OLE/CFB container, refused as `unsupported_office_format`).
 *
 * @stability experimental
 */
export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * The PowerPoint (.pptx) MIME type. Office Open XML, as {@link DOCX_MIME_TYPE}.
 *
 * @stability experimental
 */
export const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * Every MIME type a note source document may be uploaded as.
 *
 * @stability experimental
 */
export const NOTE_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  DOCX_MIME_TYPE,
  PPTX_MIME_TYPE,
] as const;

/**
 * One accepted document MIME type.
 *
 * @stability experimental
 */
export type NoteDocumentMimeType = (typeof NOTE_DOCUMENT_MIME_TYPES)[number];
