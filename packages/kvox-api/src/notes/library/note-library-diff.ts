import { normalizeLibraryPath, type NoteLibraryFileStatus } from '@marinoscar/kvox-contract/notes';

// =============================================================================
// The library scan diff (issue #714, epic #708; docs/specs/notes.md §8.8)
// =============================================================================
//
// PURE: a manifest in, a plan out. No database, no clock. The service loads the rows,
// calls this, and applies the plan.
// =============================================================================

/** What the server already knows about one library file. @stability experimental */
export interface ExistingLibraryFile {
  /** The normalised library-relative path. */
  relativePath: string;
  /** The size in bytes. */
  size: number;
  /** The modification time, milliseconds since the epoch. */
  mtimeMs: number;
  /** Lower-case hex SHA-256 of the last imported or scanned bytes, if any. */
  contentHash: string | null;
  /** The file's status. */
  status: NoteLibraryFileStatus;
}

/** One manifest entry as the client sent it. @stability experimental */
export interface ManifestEntryInput {
  /** The path as the host reports it. */
  path: string;
  /** The size in bytes. */
  size: number;
  /** The modification time, milliseconds since the epoch. */
  mtime: number;
  /** Hex SHA-256, when the client computed it. */
  sha256?: string | undefined;
}

/** A file whose bytes are unchanged but whose stored size or mtime must move. @stability experimental */
export interface TouchedFile {
  /** The normalised path. */
  path: string;
  /** The size now. */
  size: number;
  /** The mtime now. */
  mtimeMs: number;
}

/** The plan a scan produces. @stability experimental */
export interface LibraryDiff {
  /** Paths to upload: new or changed. */
  upload: string[];
  /** Paths whose hash the client must send before the server can decide. */
  hashNeeded: string[];
  /** Known files whose content is the same; only size or mtime is stored again. */
  touched: TouchedFile[];
  /** How many known files are untouched. */
  unchanged: number;
  /** Known files absent from a complete manifest. */
  missing: string[];
  /** Raw paths refused by `normalizeLibraryPath`. */
  rejected: string[];
  /** Normalised paths of the unchanged files (the service bumps `lastSeenAt` on them). */
  unchangedPaths: string[];
}

/**
 * Classifies a manifest against the files a library already holds.
 *
 * - Paths are normalised; an invalid one is dropped and reported in `rejected`; when two
 *   entries share a normalised path the last wins.
 * - Unknown path: `upload`.
 * - Known, same size and mtime: `unchanged`, whatever its status (a failed file is retried
 *   explicitly, never by a rescan).
 * - Known, size or mtime moved: a given sha256 equal to the stored hash is `touched`, a
 *   different one is `upload`, none is `hashNeeded`.
 * - Known, absent from the manifest, `complete` and not already `missing`: `missing`.
 *
 * @param existing - the library's file rows.
 * @param entries - the manifest.
 * @param options - `complete: false` for a partial manifest, which never marks `missing`.
 * @returns the plan.
 * @stability experimental
 */
export function diffLibraryManifest(
  existing: readonly ExistingLibraryFile[],
  entries: readonly ManifestEntryInput[],
  options: { complete: boolean }
): LibraryDiff {
  const known = new Map(existing.map((file) => [file.relativePath, file]));
  const rejected: string[] = [];
  const byPath = new Map<string, ManifestEntryInput>();

  for (const entry of entries) {
    const path = normalizeLibraryPath(entry.path);
    if (path === null) {
      rejected.push(entry.path);
      continue;
    }
    // Delete first so the Map keeps the position of the LAST occurrence.
    byPath.delete(path);
    byPath.set(path, entry);
  }

  const diff: LibraryDiff = {
    upload: [],
    hashNeeded: [],
    touched: [],
    unchanged: 0,
    missing: [],
    rejected,
    unchangedPaths: [],
  };

  for (const [path, entry] of byPath) {
    const file = known.get(path);

    if (!file) {
      diff.upload.push(path);
      continue;
    }

    if (file.size === entry.size && file.mtimeMs === entry.mtime) {
      diff.unchanged += 1;
      diff.unchangedPaths.push(path);
      continue;
    }

    if (entry.sha256 === undefined) {
      diff.hashNeeded.push(path);
    } else if (file.contentHash !== null && entry.sha256 === file.contentHash) {
      diff.touched.push({ path, size: entry.size, mtimeMs: entry.mtime });
    } else {
      diff.upload.push(path);
    }
  }

  if (options.complete) {
    for (const file of existing) {
      if (!byPath.has(file.relativePath) && file.status !== 'missing')
        diff.missing.push(file.relativePath);
    }
  }

  return diff;
}
