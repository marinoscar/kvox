// =============================================================================
// What an upload's content type may be (issue #21, kept by #469)
// =============================================================================
//
// The platform's `ObjectsService.initUpload` stores the content type the client
// DECLARED and checks it against the deployment's `storage.allowedMimeTypes`. It
// does not know that a browser reports `application/octet-stream` (or nothing)
// for an `.m4a` or an `.amr`, which for a recording app is the ORDINARY case, so
// `KvoxManagedObjects.initManagedUpload` resolves the type here first and then
// hands the platform a type it will accept. Pure: no Nest, no Prisma.
//
// ⚠ THE MAPPED VALUE IS WHAT GETS STORED AND SENT TO THE PROVIDER, not the
// `application/octet-stream` the browser claimed: an object stored with a
// generic content type is one a browser refuses to play from `<audio src=...>`.
//
// (The adaptive part size that used to live beside this was dropped by #469: the
// platform uses one deployment-wide `storage.partSize`; see
// docs/platform-adoption/local-exceptions.md.)
// =============================================================================

import { extname } from 'node:path';

/**
 * MIME types a browser hands over when it has no idea what the file is.
 *
 * An empty string counts too and is normalised to `''` before the lookup —
 * `<input type="file">` genuinely yields `""` for `.amr` and for `.m4a` on
 * several Android builds.
 */
const GENERIC_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
]);

/**
 * Audio file extensions that rescue a generic MIME type, mapped to the type
 * they are treated as.
 *
 * ⚠ THE MAPPED VALUE IS WHAT GETS STORED AND SENT TO THE PROVIDER, not the
 * `application/octet-stream` the browser claimed. That is the point: an object
 * stored with a generic content type is one a browser will refuse to play from
 * `<audio src=…>`, so the upload would succeed and playback would silently
 * fail later, in a different part of the system, with nothing pointing back
 * here. Resolving at the door keeps the stored type honest.
 *
 * `.mp4` and `.3gp` are containers that may hold video. They resolve to the
 * audio type because the only way to reach this table is to have declared NO
 * type at all — a caller that knows it has video says `video/mp4`, which the
 * default allowlist accepts on its own and which never gets rewritten.
 */
const AUDIO_EXTENSION_MIME_TYPES: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.aac': 'audio/aac',
  '.amr': 'audio/amr',
  '.webm': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
  '.3gp': 'audio/3gpp',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.caf': 'audio/x-caf',
  '.wv': 'audio/x-wavpack',
};

/** The audio extensions {@link resolveMimeType} recognises, for messages. */
export const AUDIO_EXTENSIONS = Object.keys(AUDIO_EXTENSION_MIME_TYPES);

/**
 * Does `mimeType` satisfy one of the allowlist's patterns?
 *
 * A pattern is either an exact type (`application/pdf`), a family wildcard
 * (`audio/*`), or the bare `*`. Comparison is case-insensitive and ignores any
 * `; charset=…` parameter, because a browser is entitled to send one and an
 * allowlist written as `audio/ogg` should not be defeated by it.
 */
export function isMimeTypeAllowed(mimeType: string, allowed: string[]): boolean {
  const type = normaliseMimeType(mimeType);

  return allowed.some((rawPattern) => {
    const pattern = rawPattern.trim().toLowerCase();

    if (pattern === '' ) return false;
    if (pattern === '*' || pattern === '*/*') return true;

    if (pattern.endsWith('/*')) {
      return type.startsWith(pattern.slice(0, -1));
    }

    return type === pattern;
  });
}

/** Lowercase, parameter-free form of a declared MIME type. */
export function normaliseMimeType(mimeType: string | null | undefined): string {
  return (mimeType ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * The MIME type an upload should actually be stored with.
 *
 * Returns the declared type unchanged unless it is generic/absent AND the
 * filename carries a known audio extension, in which case the extension wins.
 * Returns `null` when nothing can be resolved — the caller turns that into the
 * 400, because only it knows the allowlist it is enforcing.
 */
export function resolveMimeType(
  fileName: string,
  declaredMimeType: string | null | undefined,
): string | null {
  const declared = normaliseMimeType(declaredMimeType);

  if (!GENERIC_MIME_TYPES.has(declared)) {
    return declared === '' ? null : declared;
  }

  const extension = extname(fileName).toLowerCase();
  const resolved = AUDIO_EXTENSION_MIME_TYPES[extension];

  if (resolved) {
    return resolved;
  }

  // A genuinely generic type with no audio extension to rescue it. Hand the
  // declared type back when there was one so the caller's 400 can name it;
  // `null` only when the caller was told nothing at all.
  return declared === '' ? null : declared;
}
