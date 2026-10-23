/**
 * Fakes shared by the note library suites (#720): a file-access port over an
 * in-memory folder, and scan and batch answers.
 */

import { vi } from 'vitest';

import type { KvoxFileAccessPort, KvoxFileEntry, KvoxFolderRef } from '../../src/core/headless/index.js';

export const REF: KvoxFolderRef = { id: 'folder-1', name: 'Notes' };

/** A fake port over an in-memory folder. */
export function fakePort(
  files: Record<string, string>,
  overrides: Partial<KvoxFileAccessPort> = {},
): KvoxFileAccessPort & { hashed: string[]; read: ReturnType<typeof vi.fn> } {
  const hashed: string[] = [];
  const entries: KvoxFileEntry[] = Object.entries(files).map(([path, text]) => ({ path, size: text.length, mtime: 1000 }));
  const port = {
    capabilities: { persistentFolders: true, watch: false, hashInHost: false },
    pickFolder: vi.fn(async () => REF),
    listFolders: vi.fn(async () => [REF]),
    forgetFolder: vi.fn(async () => undefined),
    async *enumerate() {
      for (const entry of entries) yield entry;
    },
    hash: vi.fn(async (_ref: KvoxFolderRef, path: string) => {
      hashed.push(path);
      return 'a'.repeat(64);
    }),
    read: vi.fn(async (_ref: KvoxFolderRef, path: string) => new Blob([files[path] ?? ''])),
    getLibraryFolder: vi.fn(async () => REF),
    setLibraryFolder: vi.fn(async () => undefined),
    hashed,
    ...overrides,
  };
  return port as unknown as KvoxFileAccessPort & { hashed: string[]; read: ReturnType<typeof vi.fn> };
}

/** A scan answer with defaults. */
export function scanAnswer(
  partial: Partial<{ batchId: string | null; upload: string[]; hashNeeded: string[]; missing: string[]; unchanged: number }>,
) {
  const upload = partial.upload ?? [];
  return {
    batchId: partial.batchId ?? null,
    upload,
    hashNeeded: partial.hashNeeded ?? [],
    missing: partial.missing ?? [],
    unchanged: partial.unchanged ?? 0,
    estimate: { files: upload.length, bytes: upload.length * 10, approxInputTokens: upload.length * 3 },
  };
}

const ITEM_STATUSES = ['queued', 'importing', 'imported', 'failed', 'missing', 'skipped'] as const;
const STAGES = ['uploaded', 'parsed', 'indexed', 'extracting', 'extracted', 'in_graph', 'failed'] as const;

/** A batch with zeroed counts, overridden where given. */
export function batchOf(
  overrides: {
    id?: string;
    libraryId?: string | null;
    status?: string;
    counts?: Partial<Record<(typeof ITEM_STATUSES)[number], number>>;
    stageCounts?: Partial<Record<(typeof STAGES)[number], number>>;
  } = {},
) {
  return {
    id: overrides.id ?? 'batch-1',
    libraryId: overrides.libraryId ?? null,
    status: overrides.status ?? 'running',
    createdAt: '2026-10-23T10:00:00.000Z',
    finishedAt: null,
    counts: { ...Object.fromEntries(ITEM_STATUSES.map((k) => [k, 0])), ...overrides.counts },
    stageCounts: { ...Object.fromEntries(STAGES.map((k) => [k, 0])), ...overrides.stageCounts },
  };
}

/** A library with zeroed counts. */
export function libraryOf(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lib-1',
    name: 'Work notes',
    autoExtract: true,
    autoCommit: false,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    lastScanAt: null,
    counts: { total: 0, imported: 0, failed: 0, missing: 0, diverged: 0, unsupported: 0, pending: 0 },
    ...overrides,
  };
}
