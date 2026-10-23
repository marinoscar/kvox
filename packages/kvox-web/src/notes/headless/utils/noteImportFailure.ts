/**
 * Friendly sentences for why an imported file did not become a note (issue #720).
 *
 * A batch item's `failureMessage` is always `null` on the wire: the server stores
 * a machine-readable `failureReason` code and the words are the client's, so they
 * can be phrased for the person reading them (and translated later) without a
 * migration. An upload refused outright (400 with `details.reason`, 413) is
 * worded by {@link noteImportUploadErrorMessage} with the same table.
 */

import { isKvoxApiError } from '../../../core/headless/index.js';

const FAILURE_SENTENCES: Readonly<Record<string, string>> = {
  encrypted_pdf: 'This PDF is password-protected, so its text cannot be read. Remove the password and import it again.',
  no_text_layer:
    'This PDF has no text layer (it is probably a scan or a picture). Run it through OCR, then import it again.',
  corrupt_file: 'This file is damaged or is not really the format its name says, so it could not be read.',
  empty_document: 'This document has no text in it.',
  unsupported_office_format:
    'This is an older Word or PowerPoint file (.doc or .ppt) or a password-protected one. Save it as .docx or .pptx and import it again.',
  archive_too_large: 'This Word or PowerPoint file is too large or too complex to unpack safely.',
  not_text: 'This file does not look like text, so it could not be imported as a note.',
  invalid_front_matter: 'The block of settings at the top of this Markdown file could not be read. Fix or remove it and import it again.',
  unsupported_note_format: 'This note was exported in a format this version of KVox does not read.',
  empty_note: 'This file is empty, so there is nothing to make a note from.',
  unsupported_document: 'This kind of file cannot be imported. Use Markdown, text, PDF, Word (.docx) or PowerPoint (.pptx).',
  invalid_path: 'This file’s name or folder path cannot be used.',
  too_large: 'This file is larger than the import limit.',
  batch_cancelled: 'This import was cancelled.',
  internal_error: 'Something went wrong on the server while importing this file. Try again.',
};

/**
 * The sentence for a failure reason code.
 *
 * @param reason - A batch item's `failureReason`, or an upload refusal's `details.reason`.
 * @returns A sentence for a person, a generic one for a code this build does not know,
 *   or `null` when there is no reason.
 *
 * @stability experimental
 */
export function describeNoteImportFailure(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return Object.hasOwn(FAILURE_SENTENCES, reason)
    ? FAILURE_SENTENCES[reason]!
    : 'This file could not be imported. Try again, or check that it opens on your computer.';
}

/**
 * The sentence for a failed upload (`POST /notes/import-batches/:id/files`).
 *
 * @param error - What the upload rejected with.
 * @returns A sentence for a person.
 *
 * @stability experimental
 */
export function noteImportUploadErrorMessage(error: unknown): string {
  if (isKvoxApiError(error)) {
    if (error.status === 413) return FAILURE_SENTENCES.too_large!;
    if (error.reason) return describeNoteImportFailure(error.reason)!;
    if (error.status === 404) return 'This import no longer exists.';
    if (error.status === 0) return 'The upload could not reach the server. Check your connection and try again.';
    if (error.message) return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'The upload failed.';
}
