/**
 * Turn a pick or a drop into an import manifest, before any byte is uploaded (issue #813,
 * epic #811): ZIP archives are unpacked in the browser (`expandZipArchive`), every file is
 * checked like `checkNoteImportFiles` checks a loose one, paths are made unique within the
 * batch (`uniqueNoteImportPaths`), and the 500-files-per-batch cap is applied.
 *
 * The manifest is what the pre-flight dialog shows (counts by type, total size, what is
 * skipped and why) and what `BatchUploadProvider.start` or `importFilesAdHoc` uploads.
 * These checks are for the person; the server still validates every file.
 */

import { isZipFile, expandZipArchive, NoteArchiveError } from './archiveExpand.js';
import type { ArchiveEntryRejectReason, ExpandZipArchiveOptions } from './archiveExpand.js';
import { NOTE_IMPORT_DEFAULT_MAX_BYTES, checkNoteImportFiles, uniqueNoteImportPaths } from './librarySync.js';

// =============================================================================
// Shapes
// =============================================================================

/**
 * The kind of an importable file, for the counts.
 *
 * @stability experimental
 */
export type NoteImportKind = 'pdf' | 'docx' | 'pptx' | 'md' | 'txt';

/**
 * Every {@link NoteImportKind}, in display order.
 *
 * @stability experimental
 */
export const NOTE_IMPORT_KINDS: readonly NoteImportKind[] = ['pdf', 'docx', 'pptx', 'md', 'txt'];

/**
 * Why a file (loose, an archive, or an archive entry) will not be imported.
 *
 * - `unsupported`, `empty`, `too_large`: a loose file, as `checkNoteImportFiles` says.
 * - the {@link ArchiveEntryRejectReason}s: an entry of an archive.
 * - `archive_unreadable`: an archive that could not be opened.
 *
 * @stability experimental
 */
export type NoteImportRejectionReason =
  | 'unsupported'
  | 'empty'
  | 'too_large'
  | ArchiveEntryRejectReason
  | 'archive_unreadable';

/**
 * A file that will be imported.
 *
 * @stability experimental
 */
export interface NoteImportManifestFile {
  /** The bytes. */
  file: File;
  /** The path to upload it under, unique within the batch. */
  path: string;
  /** Its kind, for the counts. */
  kind: NoteImportKind;
  /** Its size in bytes. */
  size: number;
}

/**
 * A file that will not be imported, and why.
 *
 * @stability experimental
 */
export interface NoteImportManifestRejection {
  /** The file name. */
  name: string;
  /** Its path: the name, a folder path, or `<archive>/<path inside it>`. */
  path: string;
  /** Why. */
  reason: NoteImportRejectionReason;
  /** Its size in bytes, when known. */
  size?: number;
}

/**
 * Why a whole import cannot start.
 *
 * @stability experimental
 */
export interface NoteImportRefusal {
  /** `batch_too_large`: more importable files than one batch takes. */
  reason: 'batch_too_large';
  /** A sentence for a person. */
  message: string;
  /** Importable files found. */
  found: number;
  /** The most one batch takes. */
  limit: number;
}

/**
 * What a pick or a drop would import.
 *
 * @stability experimental
 */
export interface NoteImportManifest {
  /** The files to upload, in order, each with a unique path. */
  accepted: NoteImportManifestFile[];
  /** The files left out, with the reason. */
  rejected: NoteImportManifestRejection[];
  /** Accepted files by kind. */
  counts: Record<NoteImportKind, number>;
  /** The accepted files' total size in bytes. */
  totalBytes: number;
  /** Archives unpacked. */
  archives: number;
  /** Set when the import cannot start as it is (too many files). */
  refusal: NoteImportRefusal | null;
}

/**
 * Where {@link prepareNoteImport} stands while it unpacks archives.
 *
 * @stability experimental
 */
export interface NoteImportPrepareProgress {
  /** The archive being read. */
  archive: string;
  /** 1-based position of that archive among the archives picked. */
  archiveIndex: number;
  /** How many archives were picked. */
  archiveCount: number;
  /** Bytes of that archive read so far. */
  bytesRead: number;
  /** That archive's size. */
  totalBytes: number;
}

/**
 * Options of {@link prepareNoteImport}.
 *
 * @stability experimental
 */
export interface PrepareNoteImportOptions {
  /** The largest file accepted. Default {@link NOTE_IMPORT_DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /** The most files one batch takes. Default {@link NOTE_IMPORT_MAX_BATCH_FILES}. */
  maxFiles?: number;
  /** Limits passed to `expandZipArchive` (its `maxEntryBytes` defaults to `maxBytes`). */
  archive?: Omit<ExpandZipArchiveOptions, 'signal' | 'onProgress'>;
  /** Stops the preparation; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Called while archives are read. */
  onProgress?: (progress: NoteImportPrepareProgress) => void;
}

/**
 * The most files one import batch takes.
 *
 * @stability experimental
 */
export const NOTE_IMPORT_MAX_BATCH_FILES = 500;

// =============================================================================
// Helpers
// =============================================================================

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at < 0 ? '' : name.slice(at + 1).toLowerCase();
}

/**
 * The kind of an importable file name, or `null`.
 *
 * @param name - A file name or path.
 * @returns Its kind.
 *
 * @stability experimental
 */
export function noteImportKindOf(name: string): NoteImportKind | null {
  switch (extensionOf(name)) {
    case 'pdf':
      return 'pdf';
    case 'docx':
      return 'docx';
    case 'pptx':
      return 'pptx';
    case 'md':
    case 'markdown':
      return 'md';
    case 'txt':
    case 'text':
      return 'txt';
    default:
      return null;
  }
}

function loosePath(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative && relative.length > 0 ? relative : file.name;
}

function emptyCounts(): Record<NoteImportKind, number> {
  return { pdf: 0, docx: 0, pptx: 0, md: 0, txt: 0 };
}

// =============================================================================
// prepareNoteImport
// =============================================================================

/**
 * Builds the manifest of a pick or a drop: unpacks archives, checks every file, makes the
 * paths unique and applies the batch cap. See the file header.
 *
 * @param files - The files picked or dropped (loose files and ZIP archives, mixed).
 * @param options - Limits, signal and progress.
 * @returns The manifest. With `refusal` set, the import should not start.
 * @throws The signal's reason when aborted.
 *
 * @stability experimental
 */
export async function prepareNoteImport(
  files: Iterable<File>,
  options: PrepareNoteImportOptions = {},
): Promise<NoteImportManifest> {
  const maxBytes = options.maxBytes ?? NOTE_IMPORT_DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? NOTE_IMPORT_MAX_BATCH_FILES;
  const { signal, onProgress } = options;

  const loose: File[] = [];
  const archives: File[] = [];
  for (const file of files) {
    if (await isZipFile(file)) archives.push(file);
    else loose.push(file);
  }

  const picked: Array<{ file: File; path: string }> = [];
  const rejected: NoteImportManifestRejection[] = [];
  // Importable files beyond what an archive kept (its own entry limit).
  let overflow = 0;

  const check = checkNoteImportFiles(loose, maxBytes);
  for (const file of check.accepted) picked.push({ file, path: loosePath(file) });
  for (const { file, reason } of check.rejected) {
    rejected.push({ name: file.name, path: loosePath(file), reason, size: file.size });
  }

  for (const [index, archive] of archives.entries()) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    try {
      const result = await expandZipArchive(archive, {
        maxEntryBytes: maxBytes,
        maxEntries: maxFiles,
        ...options.archive,
        ...(signal ? { signal } : {}),
        onProgress: (bytesRead, totalBytes) =>
          onProgress?.({
            archive: archive.name,
            archiveIndex: index + 1,
            archiveCount: archives.length,
            bytesRead,
            totalBytes,
          }),
      });
      picked.push(...result.files);
      overflow += result.totals.importable - result.totals.accepted;
      for (const entry of result.rejected) {
        rejected.push({
          name: entry.name,
          path: entry.path,
          reason: entry.reason,
          ...(entry.size !== undefined ? { size: entry.size } : {}),
        });
      }
    } catch (error) {
      if (!(error instanceof NoteArchiveError)) throw error;
      rejected.push({
        name: archive.name,
        path: loosePath(archive),
        reason: error.reason === 'archive_limit' ? 'archive_limit' : 'archive_unreadable',
        size: archive.size,
      });
    }
  }

  const paths = uniqueNoteImportPaths(picked.map((entry) => entry.path));
  const counts = emptyCounts();
  let totalBytes = 0;
  const accepted: NoteImportManifestFile[] = picked.map((entry, at) => {
    const kind = noteImportKindOf(entry.file.name) ?? 'txt';
    counts[kind] += 1;
    totalBytes += entry.file.size;
    return { file: entry.file, path: paths[at]!, kind, size: entry.file.size };
  });

  // An archive that hit its entry limit dropped the rest; they count toward what the
  // batch would hold, so the refusal names the real number.
  const found = accepted.length + overflow;
  const refusal: NoteImportRefusal | null =
    found > maxFiles
      ? {
          reason: 'batch_too_large',
          found,
          limit: maxFiles,
          message: `This is ${found.toLocaleString()} files; one import takes at most ${maxFiles.toLocaleString()}. Split it into smaller imports.`,
        }
      : null;

  return { accepted, rejected, counts, totalBytes, archives: archives.length, refusal };
}
