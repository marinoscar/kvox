/**
 * `runLibrarySync` and `importFilesAdHoc` (#720): the orchestration both hosts share,
 * driven with a fake file port and the fake host.
 */

import { describe, expect, it, vi } from 'vitest';

import { REF, fakePort, scanAnswer } from './libraryFakes.js';
import { createFakeKvoxWebHost, fakeApiError } from '../../src/core/testing/index.js';
import type { FakeRouteRequest } from '../../src/core/testing/index.js';
import {
  checkNoteImportFiles,
  importFilesAdHoc,
  runLibrarySync,
  uniqueNoteImportPaths,
} from '../../src/notes/headless/index.js';
import type { LibrarySyncProgress } from '../../src/notes/headless/index.js';

function formPath(request: FakeRouteRequest): string {
  return String((request.body as FormData).get('path'));
}

describe('runLibrarySync', () => {
  it('hashes what the server asks for, rescans only those, and uploads each file into the batch that listed it', async () => {
    const port = fakePort({ 'a.md': 'aaaa', 'b.md': 'bbbb', 'c.pdf': 'cccc' });
    const scans: Array<{ entries: Array<{ path: string; sha256?: string }>; complete: boolean }> = [];
    const uploads: Array<{ batch: string; path: string; mtime: string | null }> = [];
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/libraries/:id/scan': (request) => {
          const body = request.body as (typeof scans)[number];
          scans.push(body);
          return scans.length === 1
            ? scanAnswer({ batchId: 'batch-new', upload: ['a.md'], hashNeeded: ['b.md', 'c.pdf'], missing: ['gone.md'], unchanged: 0 })
            : scanAnswer({ batchId: 'batch-changed', upload: ['b.md'] });
        },
        'POST /notes/import-batches/:id/files': (request) => {
          const form = request.body as FormData;
          uploads.push({ batch: request.params.id!, path: formPath(request), mtime: form.get('mtime') as string | null });
          return { itemId: `item-${uploads.length}`, action: 'new', skipped: false };
        },
        'POST /notes/import-batches/:id/close': { id: 'x' },
      },
    });
    const confirm = vi.fn(async () => true);
    const phases: string[] = [];

    const result = await runLibrarySync({
      host,
      port,
      library: { id: 'lib-1' },
      ref: REF,
      confirm,
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(scans[0]!.complete).toBe(true);
    expect(scans[0]!.entries.map((e) => e.path)).toEqual(['a.md', 'b.md', 'c.pdf']);
    expect(scans[0]!.entries.every((e) => e.sha256 === undefined)).toBe(true);
    // The follow-up scan carries ONLY the hashed entries, as a partial manifest.
    expect(scans[1]!.complete).toBe(false);
    expect(scans[1]!.entries.map((e) => [e.path, e.sha256])).toEqual([
      ['b.md', 'a'.repeat(64)],
      ['c.pdf', 'a'.repeat(64)],
    ]);
    expect(port.hashed.sort()).toEqual(['b.md', 'c.pdf']);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ newCount: 1, changedCount: 1, missingCount: 1, unchangedCount: 1, uploadPaths: ['a.md', 'b.md'] }),
    );
    expect(uploads).toEqual(
      expect.arrayContaining([
        { batch: 'batch-new', path: 'a.md', mtime: '1000' },
        { batch: 'batch-changed', path: 'b.md', mtime: '1000' },
      ]),
    );
    expect(result).toMatchObject({ batchId: 'batch-new', batchIds: ['batch-new', 'batch-changed'], uploaded: 2, cancelled: false });
    expect(host.callsTo('POST /notes/import-batches/batch-new/close')).toHaveLength(1);
    expect(host.callsTo('POST /notes/import-batches/batch-changed/close')).toHaveLength(1);
    expect(phases).toEqual(expect.arrayContaining(['enumerating', 'hashing', 'uploading', 'done']));
    expect(phases.at(-1)).toBe('done');
  });

  it('uploads nothing when confirm says no', async () => {
    const port = fakePort({ 'a.md': 'a' });
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/libraries/:id/scan': scanAnswer({ batchId: 'b1', upload: ['a.md'] }),
        'POST /notes/import-batches/:id/close': { id: 'b1' },
      },
    });

    const result = await runLibrarySync({ host, port, library: { id: 'lib' }, ref: REF, confirm: () => false });
    expect(host.callsTo('POST /notes/import-batches/b1/close')).toHaveLength(1);

    expect(result.cancelled).toBe(true);
    expect(result.uploaded).toBe(0);
    expect(host.callsTo('POST /notes/import-batches/b1/files')).toHaveLength(0);
    expect(port.read).not.toHaveBeenCalled();
  });

  it('skips confirm when there is nothing to upload', async () => {
    const port = fakePort({ 'a.md': 'a' });
    const host = createFakeKvoxWebHost({
      routes: { 'POST /notes/libraries/:id/scan': scanAnswer({ unchanged: 1 }) },
    });
    const confirm = vi.fn(() => true);

    const result = await runLibrarySync({ host, port, library: { id: 'lib' }, ref: REF, confirm });

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toMatchObject({ batchId: null, uploaded: 0, cancelled: false });
    expect(result.plan.unchangedCount).toBe(1);
  });

  it('collects failed uploads with a friendly message and keeps going', async () => {
    const port = fakePort({ 'ok.md': 'x', 'big.pdf': 'y', 'old.docx': 'z' });
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/libraries/:id/scan': scanAnswer({ batchId: 'b1', upload: ['ok.md', 'big.pdf', 'old.docx'] }),
        'POST /notes/import-batches/:id/files': (request) => {
          const path = formPath(request);
          if (path === 'big.pdf') throw fakeApiError(413, 'Payload Too Large');
          if (path === 'old.docx') throw fakeApiError(400, 'Unsupported', { reason: 'unsupported_office_format' });
          return { itemId: 'i', action: 'new', skipped: false };
        },
      },
    });

    const result = await runLibrarySync({ host, port, library: { id: 'lib' }, ref: REF });

    expect(result.uploaded).toBe(1);
    expect(result.failed).toHaveLength(2);
    expect(result.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'big.pdf', reason: 'too_large', message: expect.stringMatching(/larger than/i) }),
        expect.objectContaining({ path: 'old.docx', reason: 'unsupported_office_format', message: expect.stringMatching(/\.docx/) }),
      ]),
    );
  });

  async function peakConcurrency(sequential: boolean): Promise<number> {
    const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}.md`, 'x']));
    const port = fakePort(files);
    let inFlight = 0;
    let peak = 0;
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/libraries/:id/scan': scanAnswer({ batchId: 'b1', upload: Object.keys(files) }),
        'POST /notes/import-batches/:id/files': async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { itemId: 'i', action: 'new', skipped: false };
        },
      },
    });
    const result = await runLibrarySync({ host, port, library: { id: 'lib' }, ref: REF, sequential });
    expect(result.uploaded).toBe(8);
    return peak;
  }

  it('uploads three at a time by default, and one at a time when sequential', async () => {
    expect(await peakConcurrency(false)).toBe(3);
    expect(await peakConcurrency(true)).toBe(1);
  });

  it('counts skipped files apart from uploaded ones', async () => {
    const port = fakePort({ 'a.md': 'a', 'b.md': 'b' });
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/libraries/:id/scan': scanAnswer({ batchId: 'b1', upload: ['a.md', 'b.md'] }),
        'POST /notes/import-batches/:id/files': (request) => ({
          itemId: 'i',
          action: 'new',
          skipped: formPath(request) === 'b.md',
        }),
      },
    });
    const result = await runLibrarySync({ host, port, library: { id: 'lib' }, ref: REF });
    expect(result).toMatchObject({ uploaded: 1, skipped: 1 });
  });

  it('carries the batch id in progress as soon as the scan answers', async () => {
    const port = fakePort({ 'a.md': 'a', 'b.md': 'b' });
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/libraries/:id/scan': (request) =>
          (request.body as { complete: boolean }).complete
            ? scanAnswer({ batchId: 'b-missing', missing: ['gone.md'], hashNeeded: ['b.md'] })
            : scanAnswer({ batchId: 'b-changed', upload: ['b.md'] }),
        'POST /notes/import-batches/:id/files': { itemId: 'i', action: 'changed', skipped: false },
      },
    });
    const progress: LibrarySyncProgress[] = [];
    const result = await runLibrarySync({ host, port, library: { id: 'lib' }, ref: REF, onProgress: (p) => progress.push(p) });

    expect(progress[0]!.batchId).toBeUndefined();
    // Right after the first scan, before hashing: the batch it opened.
    const firstWithBatch = progress.findIndex((p) => p.batchId !== undefined);
    expect(progress[firstWithBatch]).toMatchObject({ phase: 'enumerating', batchId: 'b-missing', done: 2, total: 2 });
    expect(progress.slice(firstWithBatch).some((p) => p.phase === 'hashing')).toBe(true);
    // Once the follow-up scan lists uploads, the batch to show is the one receiving them.
    expect(progress.filter((p) => p.phase === 'uploading' || p.phase === 'done').every((p) => p.batchId === 'b-changed')).toBe(true);
    expect(result.batchId).toBe('b-changed');
  });

  it('stops while confirm is still unanswered when the signal aborts', async () => {
    const port = fakePort({ 'a.md': 'a' });
    const controller = new AbortController();
    const host = createFakeKvoxWebHost({
      routes: { 'POST /notes/libraries/:id/scan': scanAnswer({ batchId: 'b1', upload: ['a.md'] }) },
    });
    const pending = runLibrarySync({
      host,
      port,
      library: { id: 'lib' },
      ref: REF,
      signal: controller.signal,
      confirm: () => {
        controller.abort();
        return new Promise<boolean>(() => undefined);
      },
    });
    await expect(pending).rejects.toBeDefined();
    expect(host.callsTo('POST /notes/import-batches/b1/close')).toHaveLength(1);
  });

  it('stops when the signal aborts', async () => {
    const port = fakePort({ 'a.md': 'a' });
    const controller = new AbortController();
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/libraries/:id/scan': () => {
          controller.abort();
          return scanAnswer({ batchId: 'b1', upload: ['a.md'] });
        },
      },
    });
    await expect(
      runLibrarySync({ host, port, library: { id: 'lib' }, ref: REF, signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(host.callsTo('POST /notes/import-batches/b1/files')).toHaveLength(0);
  });
});

describe('importFilesAdHoc', () => {
  it('opens an ad-hoc batch and uploads every file into it, reporting progress', async () => {
    const seen: string[] = [];
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/import-batches': { batchId: 'adhoc-1' },
        'POST /notes/import-batches/:id/files': (request) => {
          seen.push(`${request.params.id}:${formPath(request)}`);
          const file = (request.body as FormData).get('file') as File;
          expect(file.type).toBe(file.name.endsWith('.pdf') ? 'application/pdf' : 'text/markdown');
          return { itemId: 'i', action: 'new', skipped: false };
        },
      },
    });
    const progress: LibrarySyncProgress[] = [];
    const files = [new File(['# hi'], 'one.md'), new File(['%PDF'], 'two.pdf')];

    const result = await importFilesAdHoc({ host, files, onProgress: (p) => progress.push(p) });

    expect(result).toMatchObject({ batchId: 'adhoc-1', uploaded: 2, skipped: 0, failed: [] });
    expect(seen.sort()).toEqual(['adhoc-1:one.md', 'adhoc-1:two.pdf']);
    expect(progress.at(-1)).toMatchObject({ phase: 'done', done: 2, total: 2 });
  });

  it('gives two files of the same name distinct paths in one batch, and reports the batch id', async () => {
    const paths: string[] = [];
    const names: string[] = [];
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/import-batches': { batchId: 'adhoc-1' },
        'POST /notes/import-batches/:id/files': (request) => {
          paths.push(formPath(request));
          names.push(((request.body as FormData).get('file') as File).name);
          return { itemId: 'i', action: 'new', skipped: false };
        },
      },
    });
    const progress: LibrarySyncProgress[] = [];
    const files = [new File(['a'], 'notes.md'), new File(['b'], 'notes.md')];
    const result = await importFilesAdHoc({ host, files, concurrency: 1, onProgress: (p) => progress.push(p) });
    expect(result).toMatchObject({ uploaded: 2, failed: [] });
    expect(paths).toEqual(['notes.md', 'notes (2).md']);
    // The file keeps its own name; only the batch path is told apart.
    expect(names).toEqual(['notes.md', 'notes.md']);
    expect(progress.every((p) => p.batchId === 'adhoc-1')).toBe(true);
  });

  it('collects a refused file and keeps the others', async () => {
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /notes/import-batches': { batchId: 'adhoc-1' },
        'POST /notes/import-batches/:id/close': { id: 'adhoc-1' },
        'POST /notes/import-batches/:id/files': (request) => {
          if (formPath(request) === 'bad.pdf') throw fakeApiError(400, 'x', { reason: 'unsupported_document' });
          return { itemId: 'i', action: 'new', skipped: false };
        },
      },
    });
    const result = await importFilesAdHoc({ host, files: [new File(['a'], 'good.md'), new File(['b'], 'bad.pdf')] });
    expect(result.uploaded).toBe(1);
    expect(result.failed).toEqual([expect.objectContaining({ path: 'bad.pdf', reason: 'unsupported_document' })]);
    expect(host.callsTo('POST /notes/import-batches/adhoc-1/close')).toHaveLength(1);
  });
});

describe('uniqueNoteImportPaths', () => {
  it('keeps the first path and numbers later copies before the extension', () => {
    expect(uniqueNoteImportPaths(['notes.md', 'notes.md', 'notes.md', 'other.md'])).toEqual([
      'notes.md',
      'notes (2).md',
      'notes (3).md',
      'other.md',
    ]);
  });

  it('numbers names without an extension, dotfiles and folder paths on their last segment', () => {
    expect(uniqueNoteImportPaths(['README', 'README', '.notes', '.notes', 'a.b/c.md', 'a.b/c.md'])).toEqual([
      'README',
      'README (2)',
      '.notes',
      '.notes (2)',
      'a.b/c.md',
      'a.b/c (2).md',
    ]);
  });

  it('skips a number another path of the batch already uses, and counts on from an existing "(n)"', () => {
    expect(uniqueNoteImportPaths(['a.md', 'a.md', 'a (2).md'])).toEqual(['a.md', 'a (3).md', 'a (2).md']);
    expect(uniqueNoteImportPaths(['a (2).md', 'a (2).md'])).toEqual(['a (2).md', 'a (3).md']);
    expect(uniqueNoteImportPaths(['x (2).tar.gz', 'x (2).tar.gz'])).toEqual(['x (2).tar.gz', 'x (2).tar (2).gz']);
  });

  it('compares paths as the server normalises them', () => {
    expect(uniqueNoteImportPaths(['dir\\a.md', 'dir/a.md', './dir/a.md'])).toEqual(['dir/a.md', 'dir/a (2).md', 'dir/a (3).md']);
  });

  it('leaves distinct paths alone', () => {
    expect(uniqueNoteImportPaths(['a/x.md', 'b/x.md', 'x.md'])).toEqual(['a/x.md', 'b/x.md', 'x.md']);
  });
});

describe('checkNoteImportFiles', () => {
  it('refuses unsupported, empty and oversize files before upload', () => {
    const ok = new File(['x'], 'ok.md');
    const exe = new File(['x'], 'run.exe');
    const empty = new File([], 'empty.txt');
    const big = new File(['123456'], 'big.pdf');
    const { accepted, rejected } = checkNoteImportFiles([ok, exe, empty, big], 5);
    expect(accepted).toEqual([ok]);
    expect(rejected.map((r) => [r.file.name, r.reason])).toEqual([
      ['run.exe', 'unsupported'],
      ['empty.txt', 'empty'],
      ['big.pdf', 'too_large'],
    ]);
  });
});
