/**
 * The batch page at volume (#814): every item loaded in full pages and kept current with
 * `updatedSince`, the virtualized list (bounded DOM at 500 rows), search, sort, the
 * failures CSV, throughput, and the merge with this tab's uploads (with the upload
 * controls). Invented file names only.
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';
import type { FakeKvoxWebHost, FakeRouteRequest } from '../../src/core/testing/index.js';
import { BatchUploadProvider, useAllImportBatchItems, useBatchUploads } from '../../src/notes/headless/index.js';
import type { BatchUpload, NoteImportBatchItem } from '../../src/notes/headless/index.js';
import {
  buildImportBatchRows,
  filterImportBatchRows,
  formatEta,
  importBatchFailuresCsv,
  importThroughput,
  sortImportBatchRows,
} from '../../src/notes/ui/library/importBatchRows.js';
import { NoteImportBatchPage } from '../../src/notes/ui/pages/NoteImportBatchPage.js';
import { mockUser, render, renderHook } from '../transcripts/helpers.js';
import { batchOf } from './libraryFakes.js';

const WRITER = { ...mockUser, permissions: ['notes:read', 'notes:write', 'graph:read'] };

function item(i: number, overrides: Partial<NoteImportBatchItem> = {}): NoteImportBatchItem {
  const name = `note-${String(i).padStart(4, '0')}.md`;
  return {
    id: `item-${i}`,
    filename: name,
    path: `Pack/${name}`,
    action: 'new',
    status: 'imported',
    stage: 'parsed',
    failureReason: null,
    failureMessage: null,
    noteId: `note-${i}`,
    noteVersion: 1,
    proposalId: null,
    proposalStatus: null,
    diverged: false,
    updatedAt: new Date(Date.UTC(2026, 9, 23, 10, 0, i % 60, i)).toISOString(),
    ...overrides,
  };
}

function hostFor(routes: Record<string, unknown>): FakeKvoxWebHost {
  return createFakeKvoxWebHost({
    viewer: { userId: WRITER.id, permissions: WRITER.permissions },
    routes: routes as never,
  });
}

// jsdom has no layout: give the scroll box 480px and every row 48px (see SegmentList.test.tsx).
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset?.testid === 'import-batch-scroll' ? 480 : 48;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 960 });
});

afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
});

describe('importBatchRows helpers', () => {
  const upload: BatchUpload = {
    batchId: 'b',
    status: 'uploading',
    files: [
      { path: 'Pack/note-0001.md', name: 'note-0001.md', size: 2048, state: 'uploaded', itemId: 'item-1' },
      { path: 'Pack/new.pdf', name: 'new.pdf', size: 4096, state: 'uploading' },
      { path: 'Pack/bad.docx', name: 'bad.docx', size: 10, state: 'failed', message: 'Too big, "really"', reason: 'too_large' },
    ],
    counts: { queued: 0, uploading: 1, uploaded: 1, skipped: 0, failed: 1, cancelled: 0 },
    totalBytes: 6154,
    uploadedBytes: 2048,
    startedAt: 0,
    finishedAt: null,
  };

  it('merges server items with uploads by path', () => {
    const rows = buildImportBatchRows([item(1), item(2, { status: 'failed', stage: 'failed', failureReason: 'corrupt_file' })], upload);
    expect(rows.map((row) => [row.path, row.stageLabel, row.size])).toEqual([
      ['Pack/note-0001.md', 'Imported as a note', 2048],
      ['Pack/note-0002.md', 'Failed', null],
      ['Pack/new.pdf', 'Uploading', 4096],
      ['Pack/bad.docx', 'Upload failed', 10],
    ]);
    expect(rows[0]).toMatchObject({ folder: 'Pack/', name: 'note-0001.md', kind: 'md' });
    expect(filterImportBatchRows(rows, 'upload_failed', '')).toHaveLength(1);
    expect(filterImportBatchRows(rows, undefined, 'NEW')).toHaveLength(1);
    expect(sortImportBatchRows(rows, 'stage').map((row) => row.name)).toEqual([
      'new.pdf',
      'note-0001.md',
      'bad.docx',
      'note-0002.md',
    ]);

    const csv = importBatchFailuresCsv(rows)!;
    expect(csv.split('\r\n')[0]).toBe('path,stage,reason,message');
    expect(csv).toContain('Pack/bad.docx,Upload failed,too_large,"Too big, ""really"""');
    expect(csv).toContain('Pack/note-0002.md,Failed,corrupt_file,');
  });

  it('computes files per minute and the time left', () => {
    expect(importThroughput([{ at: 0, finished: 0 }], 10)).toEqual({ perMinute: null, etaMs: null });
    const result = importThroughput(
      [
        { at: 0, finished: 0 },
        { at: 30_000, finished: 10 },
        { at: 60_000, finished: 20 },
      ],
      40,
    );
    expect(result.perMinute).toBeCloseTo(20);
    expect(result.etaMs).toBeCloseTo(120_000);
    expect(formatEta(120_000)).toBe('about 2 min');
    expect(formatEta(10_000)).toBe('under a minute');
    expect(formatEta(80 * 60_000)).toBe('about 1 h 20 min');
  });
});

describe('useAllImportBatchItems', () => {
  it('loads every page, then polls only what changed since the newest item', async () => {
    const all = Array.from({ length: 700 }, (_, i) => item(i));
    const host = hostFor({
      'GET /notes/import-batches/:id/items': (request: FakeRouteRequest) => {
        if (request.query.get('updatedSince')) {
          return { items: [item(3, { stage: 'in_graph', updatedAt: '2026-10-24T00:00:00.000Z' })], nextCursor: null };
        }
        const start = Number(request.query.get('cursor') ?? 0);
        const limit = Number(request.query.get('limit'));
        const page = all.slice(start, start + limit);
        return { items: page, nextCursor: start + limit < all.length ? String(start + limit) : null };
      },
    });
    const { result } = renderHook(() => useAllImportBatchItems('b1'), { host });

    await waitFor(() => expect(result.current.items).toHaveLength(700));
    expect(result.current.complete).toBe(true);
    const reads = host.callsTo('GET /notes/import-batches/b1/items');
    expect(reads).toHaveLength(2);
    expect(new URLSearchParams(reads[0]!.path.split('?')[1]).get('limit')).toBe('500');

    await act(async () => {
      await result.current.poll();
    });
    const poll = host.callsTo('GET /notes/import-batches/b1/items')[2]!;
    expect(new URLSearchParams(poll.path.split('?')[1]).get('updatedSince')).toBe(
      all.reduce((newest, entry) => (Date.parse(entry.updatedAt) > Date.parse(newest) ? entry.updatedAt : newest), all[0]!.updatedAt),
    );
    expect(result.current.items).toHaveLength(700);
    expect(result.current.items[3]!.stage).toBe('in_graph');
  });
});

describe('NoteImportBatchPage at volume', () => {
  const fiveHundred = Array.from({ length: 500 }, (_, i) =>
    item(i, i === 7 ? { status: 'failed', stage: 'failed', failureReason: 'corrupt_file', noteId: null } : {}),
  );

  function pageHost() {
    return hostFor({
      'GET /notes/import-batches/:id': batchOf({ status: 'completed_with_errors', counts: { imported: 499, failed: 1 } }),
      'GET /notes/import-batches/:id/items': { items: fiveHundred, nextCursor: null },
    });
  }

  it('draws a bounded window of 500 rows, searches and sorts them', async () => {
    render(<NoteImportBatchPage batchId="batch-1" pollMs={0} />, { host: pageHost() });

    const table = await screen.findByRole('table', { name: 'Imported files' });
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(5));
    expect(table).toHaveAttribute('aria-rowcount', '501');
    // Header + a window, never all 500.
    expect(within(table).getAllByRole('row').length).toBeLessThan(60);
    expect(within(table).getByRole('link', { name: 'Pack/note-0000.md' })).toHaveAttribute('href', '/notes/note-0');

    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'note-0420' } });
    await waitFor(() => expect(table).toHaveAttribute('aria-rowcount', '2'));
    expect(within(table).getByRole('link', { name: 'Pack/note-0420.md' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: '' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Sort' }));
    fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'Stage' }));
    // Failures sort last: the first data row is an imported note, and the failure is out of the window.
    await waitFor(() => expect(within(table).queryByText('note-0007.md')).not.toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Export failures (CSV)' })).toBeInTheDocument();
  });

  it('shows the files this tab is still uploading, with the upload controls', async () => {
    const gate: Array<() => void> = [];
    const host = hostFor({
      'POST /notes/import-batches': { batchId: 'batch-1' },
      'POST /notes/import-batches/:id/files': (request: FakeRouteRequest) => {
        const path = String((request.body as FormData).get('path'));
        if (path.endsWith('broken.md')) return Promise.reject(new Error('Network down'));
        return new Promise((resolve) => gate.push(() => resolve({ itemId: 'x', action: 'new', skipped: false })));
      },
      'POST /notes/import-batches/:id/close': {},
      'GET /notes/import-batches/:id': batchOf({ status: 'running', counts: {} }),
      'GET /notes/import-batches/:id/items': { items: [], nextCursor: null },
    });
    let uploads: ReturnType<typeof useBatchUploads> | null = null;
    function Starter() {
      uploads = useBatchUploads();
      return null;
    }
    render(
      <BatchUploadProvider concurrency={1}>
        <Starter />
        <NoteImportBatchPage batchId="batch-1" pollMs={0} />
      </BatchUploadProvider>,
      { host },
    );
    await act(async () => {
      await uploads!.start([
        { file: new File(['# a'], 'a.md'), path: 'Pack/a.md' },
        { file: new File(['# b'], 'broken.md'), path: 'Pack/broken.md' },
        { file: new File(['# c'], 'c.md'), path: 'Pack/c.md' },
      ]);
    });

    // One at a time: a.md goes up, the other two wait; every file shows from the start.
    expect(await screen.findByText('Uploading')).toBeInTheDocument();
    expect(screen.getAllByText('Waiting to upload')).toHaveLength(2);
    expect(screen.getByText(/Uploading 0 of 3 files/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Pause upload' }));
    await act(async () => {
      for (const release of gate.splice(0)) release();
    });
    // Paused: the file in flight finished, nothing new started.
    expect(await screen.findByRole('button', { name: 'Resume upload' })).toBeInTheDocument();
    expect(screen.getAllByText('Waiting to upload')).toHaveLength(2);
    expect(gate).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Resume upload' }));
    expect(await screen.findByText('Upload failed')).toBeInTheDocument();
    await waitFor(() => expect(gate).toHaveLength(1));
    await act(async () => {
      for (const release of gate.splice(0)) release();
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Pause upload' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry uploads (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry upload broken.md' })).toBeInTheDocument();
  });
});
