/**
 * Context attachments — the pure half (#810).
 *
 * The files a user attaches to a note's Context: documents (their extracted text joins the
 * prompt) and images (sent to a vision-capable model). Everything here is free of React so
 * the type checks, the per-item state and the error sentences can be asserted by calling a
 * function. The hook (`hooks/useContextAttachments.ts`) and the field (`ui/components/
 * ContextAttachmentsField.tsx`) are built on it.
 *
 * ⚠ THE SERVER DECIDES. The checks below mirror the upload route so a user is told before a
 * byte is sent, but the route checks the type (and an image's leading bytes) again, and the
 * size ceiling is a deployment setting this client cannot read: a 413 is mapped to a sentence
 * rather than predicted.
 */

import {
  MAX_CONTEXT_ATTACHMENTS,
  NOTE_CONTEXT_ATTACHMENT_REASONS,
  NOTE_CONTEXT_IMAGE_MIME_TYPES,
} from '@marinoscar/kvox-contract/notes';

import { KvoxApiError } from '../../../core/headless/index.js';
import type { NoteContextAttachmentKind } from '../clients/notes.js';

export { MAX_CONTEXT_ATTACHMENTS };

/**
 * The `accept` attribute of the context file chooser: extensions as well as media types,
 * because a chooser that names only media types refuses a `.md` on most platforms.
 *
 * @stability experimental
 */
export const NOTE_CONTEXT_ATTACHMENT_ACCEPT =
  '.txt,.md,.markdown,.pdf,.docx,.pptx,image/png,image/jpeg,image/webp,image/gif';

/**
 * The accepted types as a sentence, for the helper text and the refusal.
 *
 * @stability experimental
 */
export const NOTE_CONTEXT_ATTACHMENT_ACCEPT_LABEL =
  'PDF, Word (.docx), PowerPoint (.pptx), Markdown, plain text, or PNG, JPEG, WebP and GIF images';

/** Document media types the route reads, by extension. */
const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Image media types the route reads, by extension. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const DOCUMENT_MIME_TYPES = new Set(Object.values(DOCUMENT_TYPES));
const IMAGE_MIME_TYPES = new Set<string>(NOTE_CONTEXT_IMAGE_MIME_TYPES);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function essence(type: string): string {
  return type.split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * The kind a file would be attached as, or `null` when the route would refuse its type.
 *
 * The extension wins over a missing or generic media type (most platforms report none for
 * `.md`, and some none for `.docx`); a specific media type the route reads is trusted.
 *
 * @param file - the file's name and media type.
 * @returns `document`, `image` or `null`.
 * @stability experimental
 */
export function noteContextAttachmentKind(file: Pick<File, 'name' | 'type'>): NoteContextAttachmentKind | null {
  const type = essence(file.type);
  if (IMAGE_MIME_TYPES.has(type)) return 'image';
  if (DOCUMENT_MIME_TYPES.has(type)) return 'document';
  const extension = extensionOf(file.name);
  if (extension in IMAGE_TYPES) return 'image';
  if (extension in DOCUMENT_TYPES) return 'document';
  return null;
}

/**
 * The file, with a media type when the browser gave it none (or a generic one).
 *
 * The upload route reads the part's media type, so the extension decides when the browser
 * could not.
 *
 * @param file - the chosen file.
 * @returns the same file, or a copy carrying the media type its extension names.
 * @stability experimental
 */
export function withContextAttachmentMediaType(file: File): File {
  const type = essence(file.type);
  if (type && type !== 'application/octet-stream') return file;
  const extension = extensionOf(file.name);
  const derived = DOCUMENT_TYPES[extension] ?? IMAGE_TYPES[extension];
  return derived ? new File([file], file.name, { type: derived, lastModified: file.lastModified }) : file;
}

/**
 * Why a file cannot be attached, before any byte is sent, or `null` when it may be.
 *
 * @param file - the chosen file.
 * @param maxBytes - the largest size accepted, when the caller knows it; `0` or absent leaves
 *   size to the server.
 * @returns a sentence for the user, or `null`.
 * @stability experimental
 */
export function checkContextAttachmentFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
  maxBytes = 0,
): string | null {
  if (noteContextAttachmentKind(file) === null) {
    return `This type of file cannot be attached. Attach ${NOTE_CONTEXT_ATTACHMENT_ACCEPT_LABEL}.`;
  }
  if (file.size === 0) return 'This file is empty.';
  if (maxBytes > 0 && file.size > maxBytes) {
    return `This file is ${formatMegabytes(file.size)}, over the ${formatMegabytes(maxBytes)} limit.`;
  }
  return null;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The sentence for refusing files over {@link MAX_CONTEXT_ATTACHMENTS}.
 *
 * @param refused - how many files were not added.
 * @returns the sentence.
 * @stability experimental
 */
export function contextAttachmentLimitMessage(refused: number): string {
  const files = refused === 1 ? '1 file was' : `${refused} files were`;
  return `A note can have at most ${MAX_CONTEXT_ATTACHMENTS} attached files; ${files} not added.`;
}

/** The `details.reason` of any API error, whatever its status. */
function errorReason(err: unknown): string | null {
  if (!(err instanceof KvoxApiError)) return null;
  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : null;
}

/**
 * A friendly sentence for an error the context-attachment checks raise — on the upload, or on
 * creating or regenerating a note — or `null` when the error is not one of them.
 *
 * @param err - what the call rejected with.
 * @returns the sentence, or `null`.
 * @stability experimental
 */
export function contextAttachmentErrorMessage(err: unknown): string | null {
  switch (errorReason(err)) {
    case NOTE_CONTEXT_ATTACHMENT_REASONS.NOT_READY:
      return 'An attached file is not ready yet, or no text could be read from it. Wait for it to finish, or remove it, and try again.';
    case NOTE_CONTEXT_ATTACHMENT_REASONS.UNSUPPORTED_TYPE:
      return `This type of file cannot be attached. Attach ${NOTE_CONTEXT_ATTACHMENT_ACCEPT_LABEL}.`;
    case NOTE_CONTEXT_ATTACHMENT_REASONS.LIMIT:
      return `A note can have at most ${MAX_CONTEXT_ATTACHMENTS} attached files. Remove some and try again.`;
    case NOTE_CONTEXT_ATTACHMENT_REASONS.MODEL_NO_VISION:
      return 'The chosen model cannot read images. Choose a model that can, or remove the attached images.';
    default:
      break;
  }
  if (err instanceof KvoxApiError && err.status === 413) {
    return 'This file is larger than this deployment accepts for a context file.';
  }
  return null;
}

/**
 * Where one attachment in the field stands.
 *
 * `uploading` and `extracting` block submit; `failed` blocks it too until the row is removed,
 * so a note is never generated without a file the user believes is attached.
 *
 * @stability experimental
 */
export type ContextAttachmentItemStatus = 'uploading' | 'extracting' | 'ready' | 'failed';

/**
 * One row of the context-attachments field.
 *
 * @stability experimental
 */
export interface ContextAttachmentItem {
  /** A key stable for the row's life (not the object id, which arrives after the upload). */
  key: string;
  /** The display name. */
  filename: string;
  /** `document`, `image`, or `null` for a file refused before upload. */
  kind: NoteContextAttachmentKind | null;
  /** The stored object, once uploaded. */
  objectId: string | null;
  /** Where it stands. */
  status: ContextAttachmentItemStatus;
  /** For `failed`, the sentence to show; otherwise `null`. */
  error: string | null;
  /** Characters of extracted text for a ready document, when known. */
  characters: number | null;
}

/**
 * The object ids of the ready rows, in order — what a create or regenerate body carries.
 *
 * @param items - the rows.
 * @returns the ids.
 * @stability experimental
 */
export function contextAttachmentIds(items: readonly ContextAttachmentItem[]): string[] {
  return items.flatMap((item) => (item.status === 'ready' && item.objectId ? [item.objectId] : []));
}

/**
 * Why the form cannot be submitted because of its attachments, or `null` when it can.
 *
 * @param items - the rows.
 * @returns a sentence, or `null`.
 * @stability experimental
 */
export function contextAttachmentsBlockingReason(items: readonly ContextAttachmentItem[]): string | null {
  if (items.some((item) => item.status === 'failed')) {
    return 'Remove the files that could not be attached to continue.';
  }
  if (items.some((item) => item.status === 'uploading' || item.status === 'extracting')) {
    return 'Wait for the attached files to finish before generating.';
  }
  return null;
}
