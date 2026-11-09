// =============================================================================
// Context-attachment images: what is accepted, and how it is verified (issue #810)
// =============================================================================
//
// ⚠ PURE. No Nest, no I/O. An image is sent to a model, so the declared type is never trusted:
// the file's leading bytes must agree with it. A `.png` that is really an HTML page is refused
// at the door, not forwarded to a provider.
// =============================================================================

import { NOTE_CONTEXT_IMAGE_MIME_TYPES, type NoteContextImageMimeType } from '@marinoscar/kvox-contract/notes';

/** The spellings of an image type this slice folds onto the four it stores. */
const IMAGE_ALIASES: Readonly<Record<string, NoteContextImageMimeType>> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
};

/**
 * The canonical image type a declared `Content-Type` names, or `null` when it is not one of the
 * accepted images. Parameters (`; charset=...`) and case are ignored.
 *
 * @param declared - the part's declared type.
 * @returns the canonical type, or `null`.
 * @stability experimental
 */
export function normalizeImageMimeType(declared: string): NoteContextImageMimeType | null {
  const base = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  return IMAGE_ALIASES[base] ?? null;
}

/**
 * The image type the first bytes of `body` prove, or `null` when they are none of the four.
 *
 * @param body - the file.
 * @returns the type its magic bytes name.
 * @stability experimental
 */
export function sniffImageType(body: Uint8Array): NoteContextImageMimeType | null {
  const at = (offset: number, ...bytes: number[]): boolean => bytes.every((byte, i) => body[offset + i] === byte);
  const ascii = (offset: number, text: string): boolean =>
    [...text].every((char, i) => body[offset + i] === char.charCodeAt(0));

  if (body.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (body.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (body.length >= 6 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) return 'image/gif';
  if (body.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';

  return null;
}

/** The file extension an accepted image is stored under. */
export function imageExtension(mimeType: NoteContextImageMimeType): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    default:
      return '.gif';
  }
}

/** The accepted image types as a sentence, for a refusal. */
export function acceptedImageTypesSentence(): string {
  return NOTE_CONTEXT_IMAGE_MIME_TYPES.join(', ');
}

/** Where an uploaded context image is stored. A fresh id and a canonical extension, never the filename. */
export function contextImageStorageKey(uploadId: string, extension: string): string {
  return `notes/context/${uploadId}/image${extension}`;
}
