// =============================================================================
// Opening an Office Open XML package safely (epic #708, issue #711)
// =============================================================================
//
// A .docx or .pptx is a ZIP. A ZIP read from an upload is untrusted input, and
// the classic attack is the zip bomb: a few kilobytes that inflate to gigabytes.
// THE GUARD IS ONE-SIDED BY DESIGN: this module decides what to inflate BEFORE
// inflating anything, from the central directory's own numbers, and refuses the
// archive (`archive_too_large`) rather than inflate "as much as fits".
//
//   - entry count            <= 5000   (counted over EVERY entry, wanted or not)
//   - one inflated entry     <= 32 MiB
//   - all inflated entries   <= 64 MiB (only the entries this extractor wants)
//   - one entry's ratio      <= 200:1  (checked from 1 MiB up: a 300-byte entry
//                                       that inflates to 60 KB of repeated XML
//                                       is ordinary; a megabyte at 200:1 is not)
//
// Only the wanted parts are ever inflated: fflate's `filter` runs on the central
// directory and an entry it rejects is never touched, so a 2 GB `word/media/`
// video in the package costs nothing. And `unzipSync` allocates the output
// buffer at the DECLARED size and cannot write past it, so a header that lies
// about a small size cannot inflate more than it declares; the actual lengths
// are still re-verified after inflation.
//
// Two refusals are decided on the bytes alone, before the ZIP is parsed:
//   - the CFB magic (`D0 CF 11 E0 A1 B1 1A E1`) is the legacy .doc/.ppt AND the
//     container of a password-protected modern Office file -> `unsupported_office_format`.
//   - anything that does not parse as a ZIP -> `corrupt_file`.
//
// ⚠ PURE. No Nest, no I/O.
// =============================================================================

import { unzipSync } from 'fflate';

import type { ExtractionFailureReason } from './extraction-result.js';

/** Limits on an Office package. Exported so a test (or a host doc) can name them. */
export const OOXML_LIMITS = {
  maxEntries: 5000,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxRatio: 200,
  /** The ratio check applies to entries at least this large (inflated). */
  ratioFloorBytes: 1024 * 1024,
} as const;

/**
 * The result of opening a package: the wanted parts, or the permanent reason not.
 *
 * @stability experimental
 */
export type OoxmlPackage =
  | { ok: true; files: Readonly<Record<string, Uint8Array>> }
  | { ok: false; reason: Extract<ExtractionFailureReason, 'archive_too_large' | 'corrupt_file' | 'unsupported_office_format'> };

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

class ArchiveTooLarge extends Error {}

/**
 * Inflates only the entries `wanted` accepts, under the limits above.
 *
 * @param bytes - the uploaded file.
 * @param wanted - true for an entry name this extractor reads.
 * @stability experimental
 */
export function openOoxmlPackage(bytes: Uint8Array, wanted: (name: string) => boolean): OoxmlPackage {
  if (bytes.length >= CFB_MAGIC.length && CFB_MAGIC.every((b, index) => bytes[index] === b)) {
    return { ok: false, reason: 'unsupported_office_format' };
  }

  let entries = 0;
  let total = 0;

  try {
    const files = unzipSync(bytes, {
      filter: (file) => {
        entries += 1;
        if (entries > OOXML_LIMITS.maxEntries) throw new ArchiveTooLarge();
        if (!wanted(file.name)) return false;

        const { originalSize, size } = file;
        if (originalSize > OOXML_LIMITS.maxEntryBytes) throw new ArchiveTooLarge();
        total += originalSize;
        if (total > OOXML_LIMITS.maxTotalBytes) throw new ArchiveTooLarge();
        if (originalSize >= OOXML_LIMITS.ratioFloorBytes && originalSize > Math.max(size, 1) * OOXML_LIMITS.maxRatio) {
          throw new ArchiveTooLarge();
        }
        return true;
      },
    });

    let actual = 0;
    for (const data of Object.values(files)) {
      if (data.length > OOXML_LIMITS.maxEntryBytes) return { ok: false, reason: 'archive_too_large' };
      actual += data.length;
    }
    if (actual > OOXML_LIMITS.maxTotalBytes) return { ok: false, reason: 'archive_too_large' };

    return { ok: true, files };
  } catch (error) {
    if (error instanceof ArchiveTooLarge) return { ok: false, reason: 'archive_too_large' };
    return { ok: false, reason: 'corrupt_file' };
  }
}

/** Decodes one inflated part as UTF-8. */
export function partText(files: Readonly<Record<string, Uint8Array>>, name: string): string | undefined {
  const data = files[name];
  return data === undefined ? undefined : new TextDecoder('utf-8').decode(data);
}
