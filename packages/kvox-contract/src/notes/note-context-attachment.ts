import { z } from 'zod';

// =============================================================================
// Note context attachments (issue #810)
// =============================================================================
//
// Files a user attaches to a note's Context: documents (their extracted text
// joins the prompt) and images (sent to a vision-capable model). The upload is
// `multipart/form-data` (no request schema, see `note-source.ts`); the note
// create and regenerate bodies carry the resulting object ids.
// =============================================================================

/**
 * Attachments one note may carry as context.
 *
 * @stability experimental
 */
export const MAX_CONTEXT_ATTACHMENTS = 10;

/**
 * The kinds of context attachment. A `document` is read as text by extraction; an
 * `image` is sent to the model as vision input.
 *
 * @stability experimental
 */
export const NOTE_CONTEXT_ATTACHMENT_KINDS = ['document', 'image'] as const;

/**
 * The kind of a context attachment.
 *
 * @stability experimental
 */
export type NoteContextAttachmentKind = (typeof NOTE_CONTEXT_ATTACHMENT_KINDS)[number];

/**
 * The image types a context attachment may be (verified against the file's leading bytes).
 *
 * @stability experimental
 */
export const NOTE_CONTEXT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/**
 * An accepted context image type.
 *
 * @stability experimental
 */
export type NoteContextImageMimeType = (typeof NOTE_CONTEXT_IMAGE_MIME_TYPES)[number];

/**
 * The `details.reason` values the context-attachment checks answer with.
 *
 * ⚠ They travel under `details.reason`, never in the top-level `code`
 * (see `NOTE_CONFLICT_REASONS`). Each is also in `KVOX_ERROR_CODES`.
 *
 * @stability experimental
 */
export const NOTE_CONTEXT_ATTACHMENT_REASONS = {
  /** 409: an attachment is still extracting, or its extraction found no text. */
  NOT_READY: 'context_attachment_not_ready',
  /** 400: the file type is not one a context attachment can be. */
  UNSUPPORTED_TYPE: 'context_attachment_unsupported_type',
  /** 400: more than {@link MAX_CONTEXT_ATTACHMENTS} attachments. */
  LIMIT: 'context_attachment_limit',
  /** 409: an image is attached but the resolved model cannot read images. */
  MODEL_NO_VISION: 'ai_model_no_vision',
} as const;

/**
 * A context-attachment `details.reason`.
 *
 * @stability experimental
 */
export type NoteContextAttachmentReason =
  (typeof NOTE_CONTEXT_ATTACHMENT_REASONS)[keyof typeof NOTE_CONTEXT_ATTACHMENT_REASONS];

/**
 * Zod schema for the `contextAttachmentIds` request field: uploaded attachment object ids,
 * in the order they are shown to the model.
 *
 * @stability experimental
 */
export const contextAttachmentIdsSchema = z
  .array(z.string().uuid())
  .max(MAX_CONTEXT_ATTACHMENTS)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Attachment ids must be unique.' })
  .describe(
    `Object ids returned by \`POST /api/notes/context/attachments\`, at most ${MAX_CONTEXT_ATTACHMENTS}, ` +
      'no duplicates. Each must be yours and ready (an image, or a document whose text was extracted).',
  );

/**
 * Zod schema for one attachment as a note or a generation context reports it.
 *
 * @stability experimental
 */
export const noteContextAttachmentSchema = z.object({
  objectId: z.string().describe('The attachment\'s object id.'),
  kind: z.enum(NOTE_CONTEXT_ATTACHMENT_KINDS).describe('`document` (text is extracted) or `image` (vision input).'),
  filename: z.string().describe('The display name the file was uploaded with.'),
  mimeType: z.string().describe('The canonical type the file was stored as.'),
});

/**
 * The parsed shape of {@link noteContextAttachmentSchema}.
 *
 * @stability experimental
 */
export type NoteContextAttachment = z.infer<typeof noteContextAttachmentSchema>;

/**
 * The states of an attachment: `extracting` (a document's text is not recorded yet), `ready`
 * (usable in a note: every image, and a document whose text exists) and `unextractable`
 * (a document with no readable text; it cannot be used).
 *
 * @stability experimental
 */
export const NOTE_CONTEXT_ATTACHMENT_STATUSES = ['extracting', 'ready', 'unextractable'] as const;

/**
 * Zod schema for `POST /api/notes/context/attachments` (201).
 *
 * @stability experimental
 */
export const noteContextAttachmentUploadResponseSchema = noteContextAttachmentSchema.extend({
  size: z.number().describe('Bytes accepted, as measured by this server.'),
  status: z
    .enum(['extracting', 'ready'])
    .describe('`ready` at once for an image; `extracting` for a document until `note.source.extract` finishes.'),
  jobId: z
    .string()
    .nullable()
    .describe('The `note.source.extract` job for a document; `null` for an image (nothing to extract).'),
});

/**
 * The parsed shape of {@link noteContextAttachmentUploadResponseSchema}.
 *
 * @stability experimental
 */
export type NoteContextAttachmentUploadResponse = z.infer<typeof noteContextAttachmentUploadResponseSchema>;

/**
 * Zod schema for `GET /api/notes/context/attachments/{objectId}`: poll a document until it
 * leaves `extracting`.
 *
 * @stability experimental
 */
export const noteContextAttachmentStatusResponseSchema = z.object({
  objectId: z.string().describe('The attachment\'s object id.'),
  kind: z.enum(NOTE_CONTEXT_ATTACHMENT_KINDS).describe('`document` or `image`.'),
  status: z.enum(NOTE_CONTEXT_ATTACHMENT_STATUSES).describe('See the status vocabulary. Terminal states never change back.'),
  message: z.string().nullable().describe('For `unextractable`, the sentence to show the user; otherwise `null`.'),
  characters: z.number().nullable().describe('Characters of extracted text for a ready document; otherwise `null`.'),
});

/**
 * The parsed shape of {@link noteContextAttachmentStatusResponseSchema}.
 *
 * @stability experimental
 */
export type NoteContextAttachmentStatusResponse = z.infer<typeof noteContextAttachmentStatusResponseSchema>;
