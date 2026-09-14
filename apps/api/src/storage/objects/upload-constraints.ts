// =============================================================================
// What an upload is ALLOWED to be, and how it is sliced (issue #21)
// =============================================================================
//
// Pure functions, deliberately free of Nest, Prisma and the provider, so the
// arithmetic that decides whether a 5 GB file is uploadable at all can be
// tested directly rather than through six mocks.
//
// Three separate concerns live here because all three were previously either
// absent or wrong:
//
//   1. THE ALLOWLIST WAS NEVER READ. `storage.maxFileSize` and
//      `storage.allowedMimeTypes` existed in `config/configuration.ts` and
//      were referenced by nothing, so every deployment accepted every type at
//      every size regardless of what its operator had configured.
//   2. GENERIC MIME TYPES. Browsers routinely report `application/octet-stream`
//      or an empty string for `.m4a` and `.amr` — a phone recording arrives
//      typeless. Rejecting those is rejecting the ordinary case.
//   3. A FIXED PART SIZE CAPS FILE SIZE. S3 allows at most 10,000 parts, so a
//      10 MiB part size caps an object at ~97.6 GB and, worse, the old code
//      THREW past that instead of using bigger parts.
// =============================================================================

import { extname } from 'node:path';

/** S3's floor for every part but the last. A smaller part is rejected on PUT. */
export const MIN_PART_SIZE = 5 * 1024 * 1024;

/** S3's ceiling on the number of parts in one multipart upload. */
export const MAX_PARTS = 10_000;

/** One mebibyte. Part sizes are rounded to whole MiB so they read as sizes. */
const MIB = 1024 * 1024;

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

/**
 * The part size an upload of `size` bytes must use, given what the deployment
 * configured.
 *
 * ⚠ ADAPTIVE, AND THAT IS WHY LARGE FILES WORK AT ALL. S3 allows 10,000 parts,
 * so a fixed 10 MiB part size is a hard ~97.6 GB ceiling and the old code
 * THREW at it. Taking `max(configured, ceil(size / 10000))` and rounding up to
 * a whole MiB makes the part count fall under the limit by construction for
 * any size a `BigInt` column can hold: a 1 TB object simply uses 105 MiB parts.
 *
 * Rounded UP, never down — rounding down could put the size back under
 * `size / 10000` and reintroduce the ceiling it exists to remove.
 */
export function computePartSize(size: number, configuredPartSize: number): number {
  const required = Math.ceil(size / MAX_PARTS);
  const raw = Math.max(configuredPartSize, required, MIN_PART_SIZE);

  return Math.ceil(raw / MIB) * MIB;
}

/** How many parts `size` bytes split into at `partSize`. At least one. */
export function computeTotalParts(size: number, partSize: number): number {
  return Math.max(1, Math.ceil(size / partSize));
}

/** Human-readable byte count for an error message a user will actually read. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const rendered = unit === 0 ? String(value) : value.toFixed(value < 10 ? 2 : 1);

  return `${rendered} ${units[unit]}`;
}
