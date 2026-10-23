/**
 * The note library UI (#720): the scan confirmation, the "Import notes" button's
 * pre-checks, the libraries page (empty state, add-folder flow) and the live batch page.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createFakeKvoxWebHost, fakeApiError } from '../../src/core/testing/index.js';
import type { FakeKvoxWebHost } from '../../src/core/testing/index.js';
import { ImportNotesButton } from '../../src/notes/ui/components/ImportNotesButton.js';
import { NotesDropZone } from '../../src/notes/ui/components/NotesDropZone.js';
import { NotesPage } from '../../src/notes/ui/pages/NotesPage.js';
import { ScanConfirmDialog } from '../../src/notes/ui/components/ScanConfirmDialog.js';
import { NoteImportBatchPage, importCompletionSentence } from '../../src/notes/ui/pages/NoteImportBatchPage.js';
import { NoteLibrariesPage } from '../../src/notes/ui/pages/NoteLibrariesPage.js';
import { mockUser, render } from '../transcripts/helpers.js';
import { REF, batchOf, fakePort, libraryOf, scanAnswer } from './libraryFakes.js';

const WRITER = { ...mockUser, permissions: ['notes:read', 'notes:write', 'graph:read'] };
const READER = { ...mockUser, permissions: ['notes:read'] };

function hostFor(user: typeof WRITER, routes: Record<string, unknown> = {}): FakeKvoxWebHost {
  return createFakeKvoxWebHost({
    viewer: { userId: user.id, permissions: user.permissions },
    routes: routes as never,
  });
}

/** Renders `ui` at `route` with a stand-in for the batch page, so navigation is visible. */
function renderAt(ui: React.ReactElement, host: FakeKvoxWebHost, path: string, route = path) {
  return render(
    <Routes>
      <Route path={path} element={ui} />
      <Route path="/notes/import-batches/:batchId" element={<p>Batch page</p>} />
    </Routes>,
    { host, wrapperOptions: { route } },
  );
}

const PLAN = {
  newCount: 42,
  changedCount: 3,
  missingCount: 1,
  unchangedCount: 10,
  uploadPaths: [],
  estimate: { files: 45, bytes: 3 * 1024 * 1024, approxInputTokens: 120_000 },
};

describe('ScanConfirmDialog', () => {
  it('states new, changed and missing, the size and the token estimate; Start and Cancel answer', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ScanConfirmDialog open plan={PLAN} libraryName="Work" onConfirm={onConfirm} onCancel={onCancel} />);

    const dialog = screen.getByRole('dialog', { name: /import from “work”/i });
    expect(within(dialog).getByText('42 new, 3 changed, 1 missing')).toBeInTheDocument();
    expect(within(dialog).getByText(/45 files to upload, 3\.0 MB/)).toBeInTheDocument();
    expect(within(dialog).getByText(/~120k tokens/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /start import/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('ImportNotesButton', () => {
  it('is hidden without notes:write', () => {
    render(<ImportNotesButton />, { host: hostFor(READER) });
    expect(screen.queryByRole('button', { name: /import notes/i })).not.toBeInTheDocument();
  });

  it('refuses oversize, empty and unsupported files before any upload', async () => {
    const host = hostFor(WRITER);
    render(<ImportNotesButton maxBytes={4} />, { host });

    const input = screen.getByLabelText('Choose notes to import');
    fireEvent.change(input, {
      target: { files: [new File(['123456'], 'big.md'), new File([], 'empty.txt'), new File(['x'], 'a.exe')] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/3 files could not be imported/);
    expect(host.callsTo('POST /notes/import-batches')).toHaveLength(0);
  });

  it('uploads accepted files into an ad-hoc batch and opens its page', async () => {
    const host = hostFor(WRITER, {
      'POST /notes/import-batches': { batchId: 'adhoc-9' },
      'POST /notes/import-batches/:id/files': { itemId: 'i', action: 'new', skipped: false },
    });
    renderAt(<ImportNotesButton />, host, '/notes');

    fireEvent.change(screen.getByLabelText('Choose notes to import'), {
      target: { files: [new File(['# a'], 'a.md'), new File(['b'], 'b.txt')] },
    });

    expect(await screen.findByText('Batch page')).toBeInTheDocument();
    expect(host.callsTo('POST /notes/import-batches/adhoc-9/files')).toHaveLength(2);
  });
});

describe('NoteLibrariesPage', () => {
  it('explains the feature with one big button when there is no library', async () => {
    const host = hostFor(WRITER, { 'GET /notes/libraries': { items: [] } });
    host.files = fakePort({});
    render(<NoteLibrariesPage />, { host, wrapperOptions: { route: '/notes/libraries' } });

    expect(await screen.findByRole('heading', { name: /bring in the notes you already have/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add your notes folder/i })).toBeInTheDocument();
    expect(screen.getByText(/Markdown \(\.md\), text \(\.txt\), PDF, Word \(\.docx\) and PowerPoint \(\.pptx\)/)).toBeInTheDocument();
  });

  it('adds a folder: creates the library, binds it, scans, confirms, uploads and opens the batch', async () => {
    let libraries: unknown[] = [];
    const host = hostFor(WRITER, {
      'GET /notes/libraries': () => ({ items: libraries }),
      'POST /notes/libraries': (request: { body: unknown }) => {
        const created = libraryOf({ id: 'lib-new', name: (request.body as { name: string }).name });
        libraries = [created];
        return created;
      },
      'POST /notes/libraries/:id/scan': scanAnswer({ batchId: 'batch-7', upload: ['a.md', 'b.md'] }),
      'POST /notes/import-batches/:id/files': { itemId: 'i', action: 'new', skipped: false },
    });
    const port = fakePort({ 'a.md': 'aa', 'b.md': 'bb' });
    host.files = port;
    renderAt(<NoteLibrariesPage />, host, '/notes/libraries');

    fireEvent.click(await screen.findByRole('button', { name: /add your notes folder/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('2 new, 0 changed')).toBeInTheDocument();
    expect(host.callsTo('POST /notes/libraries')[0]!.body).toEqual({ name: REF.name });
    expect(port.setLibraryFolder).toHaveBeenCalledWith('lib-new', REF);
    expect(host.callsTo('POST /notes/import-batches/batch-7/files')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: /start import/i }));

    expect(await screen.findByText('Batch page')).toBeInTheDocument();
    expect(host.callsTo('POST /notes/import-batches/batch-7/files')).toHaveLength(2);
  });

  it('cancelling the confirmation uploads nothing and stays on the page', async () => {
    const host = hostFor(WRITER, {
      'GET /notes/libraries': { items: [libraryOf()] },
      'POST /notes/libraries/:id/scan': scanAnswer({ batchId: 'b', upload: ['a.md'] }),
    });
    host.files = fakePort({ 'a.md': 'a' });
    renderAt(<NoteLibrariesPage />, host, '/notes/libraries');

    const rescan = await screen.findByRole('button', { name: /rescan work notes/i });
    // Disabled until the device's folder binding has been looked up.
    await waitFor(() => expect(rescan).toBeEnabled());
    fireEvent.click(rescan);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(await screen.findByText('Nothing was uploaded.')).toBeInTheDocument();
    expect(host.callsTo('POST /notes/import-batches/b/files')).toHaveLength(0);
  });

  it('offers Connect folder for a library with no folder on this device', async () => {
    const host = hostFor(WRITER, { 'GET /notes/libraries': { items: [libraryOf()] } });
    host.files = fakePort({}, { getLibraryFolder: vi.fn(async () => null) });
    render(<NoteLibrariesPage />, { host, wrapperOptions: { route: '/notes/libraries' } });

    expect(await screen.findByText('Folder not connected on this device')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect folder/i })).toBeInTheDocument();
  });

  it('shows no write controls to a reader', async () => {
    const host = hostFor(READER, { 'GET /notes/libraries': { items: [libraryOf()] } });
    host.files = fakePort({});
    render(<NoteLibrariesPage />, { host, wrapperOptions: { route: '/notes/libraries' } });

    expect(await screen.findByRole('link', { name: 'Work notes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rescan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add folder/i })).not.toBeInTheDocument();
  });
});

describe('NoteImportBatchPage', () => {
  const item = (overrides: Record<string, unknown>) => ({
    id: 'item-1',
    filename: 'a.md',
    path: 'docs/a.md',
    action: 'new',
    status: 'imported',
    stage: 'parsed',
    failureReason: null,
    failureMessage: null,
    noteId: 'note-1',
    noteVersion: 1,
    proposalId: null,
    proposalStatus: null,
    diverged: false,
    updatedAt: '2026-10-23T10:00:00.000Z',
    ...overrides,
  });

  it('shows overall progress and the funnel while running', async () => {
    const host = hostFor(WRITER, {
      'GET /notes/import-batches/:id': batchOf({
        counts: { imported: 3, queued: 1 },
        stageCounts: { uploaded: 1, parsed: 1, extracting: 1, in_graph: 1 },
      }),
      'GET /notes/import-batches/:id/items': { items: [item({})], nextCursor: null },
    });
    render(<NoteImportBatchPage batchId="batch-1" pollMs={0} />, { host });

    expect(await screen.findByRole('heading', { name: 'Importing notes' })).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Files imported' });
    expect(bar).toHaveAttribute('aria-valuenow', '75');
    const funnel = screen.getByRole('list', { name: 'Import pipeline' });
    expect(within(funnel).getByLabelText('Uploaded: 4')).toBeInTheDocument();
    expect(within(funnel).getByLabelText('Parsed: 3')).toBeInTheDocument();
    expect(within(funnel).getByLabelText('In graph: 1')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'docs/a.md' })).toHaveAttribute('href', '/notes/note-1');
  });

  it('says what happened once complete, and links to the Review Queue', async () => {
    const batch = batchOf({
      status: 'completed',
      counts: { imported: 128 },
      stageCounts: { in_graph: 120, extracted: 8 },
    });
    const host = hostFor(WRITER, {
      'GET /notes/import-batches/:id': batch,
      'GET /notes/import-batches/:id/items': { items: [], nextCursor: null },
    });
    render(<NoteImportBatchPage batchId="batch-1" pollMs={0} />, { host });

    expect(await screen.findByText('All 128 notes imported. 120 are in the graph; 8 wait for review.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open review queue/i })).toHaveAttribute(
      'href',
      '/graph/review-queue?batchId=batch-1',
    );
    expect(importCompletionSentence(batch as never)).toBe('All 128 notes imported. 120 are in the graph; 8 wait for review.');
  });

  it('retries failed items and shows the friendly failure sentence', async () => {
    let retried = false;
    const host = hostFor(WRITER, {
      'GET /notes/import-batches/:id': () =>
        batchOf({ status: retried ? 'running' : 'completed_with_errors', counts: retried ? { queued: 1, imported: 1 } : { failed: 1, imported: 1 } }),
      'GET /notes/import-batches/:id/items': {
        items: [item({ id: 'bad', path: 'scan.pdf', status: 'failed', stage: 'failed', failureReason: 'no_text_layer', noteId: null })],
        nextCursor: null,
      },
      'POST /notes/import-batches/:id/retry': () => {
        retried = true;
        return { requeued: 1 };
      },
      'POST /notes/import-batches/:id/retry-extractions': () => {
        throw fakeApiError(404, 'Not Found');
      },
    });
    render(<NoteImportBatchPage batchId="batch-1" pollMs={0} />, { host });

    expect(await screen.findByText(/no text layer/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry failed \(1\)/i }));
    expect(await screen.findByText('1 file queued again.')).toBeInTheDocument();
    expect(host.callsTo('POST /notes/import-batches/batch-1/retry')).toHaveLength(1);
  });

  it('hides "Retry failed extractions" once the server answers 404', async () => {
    const host = hostFor(WRITER, {
      'GET /notes/import-batches/:id': batchOf({ status: 'completed', counts: { imported: 2 } }),
      'GET /notes/import-batches/:id/items': { items: [], nextCursor: null },
      'POST /notes/import-batches/:id/retry-extractions': () => {
        throw fakeApiError(404, 'Not Found');
      },
    });
    render(<NoteImportBatchPage batchId="batch-1" pollMs={0} />, { host });

    fireEvent.click(await screen.findByRole('button', { name: /retry failed extractions/i }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /retry failed extractions/i })).not.toBeInTheDocument(),
    );
  });

  it('filters the file list by status', async () => {
    const host = hostFor(WRITER, {
      'GET /notes/import-batches/:id': batchOf({ status: 'completed_with_errors', counts: { imported: 1, failed: 1 } }),
      'GET /notes/import-batches/:id/items': (request: { query: URLSearchParams }) => ({
        items:
          request.query.get('status') === 'failed'
            ? [item({ id: 'f', path: 'broken.docx', status: 'failed', stage: 'failed', failureReason: 'corrupt_file', noteId: null })]
            : [item({}), item({ id: 'f', path: 'broken.docx', status: 'failed', stage: 'failed', noteId: null })],
        nextCursor: null,
      }),
    });
    render(<NoteImportBatchPage batchId="batch-1" pollMs={0} />, { host });

    fireEvent.click(await screen.findByRole('button', { name: 'Failed 1' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'docs/a.md' })).not.toBeInTheDocument());
    expect(screen.getByText('broken.docx')).toBeInTheDocument();
    expect(screen.getByText(/damaged/)).toBeInTheDocument();
  });

  it('polls while running and stops once complete', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      const host = hostFor(WRITER, {
        'GET /notes/import-batches/:id': () => {
          reads += 1;
          return reads < 2 ? batchOf({ counts: { queued: 1 } }) : batchOf({ status: 'completed', counts: { imported: 1 } });
        },
        'GET /notes/import-batches/:id/items': { items: [], nextCursor: null },
      });
      render(<NoteImportBatchPage batchId="batch-1" pollMs={50} />, { host });

      expect(await screen.findByRole('heading', { name: 'Importing notes' })).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(60);
      expect(await screen.findByRole('heading', { name: 'Import finished' })).toBeInTheDocument();
      const settled = reads;
      await vi.advanceTimersByTimeAsync(300);
      expect(reads).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('NotesDropZone', () => {
  it('shows the overlay on drag and imports dropped files', async () => {
    const host = hostFor(WRITER, {
      'POST /notes/import-batches': { batchId: 'drop-1' },
      'POST /notes/import-batches/:id/files': { itemId: 'i', action: 'new', skipped: false },
    });
    renderAt(
      <NotesDropZone>
        <p>Page content</p>
      </NotesDropZone>,
      host,
      '/notes',
    );
    const zone = screen.getByTestId('notes-drop-zone');
    const dataTransfer = { types: ['Files'], files: [new File(['# x'], 'x.md')], dropEffect: 'none' };

    fireEvent.dragEnter(zone, { dataTransfer });
    expect(screen.getAllByText('Drop notes to import').length).toBeGreaterThan(0);
    fireEvent.drop(zone, { dataTransfer });

    expect(await screen.findByText('Batch page')).toBeInTheDocument();
    expect(host.callsTo('POST /notes/import-batches/drop-1/files')).toHaveLength(1);
  });

  it('is inert for a reader', () => {
    render(
      <NotesDropZone>
        <p>Page content</p>
      </NotesDropZone>,
      { host: hostFor(READER) },
    );
    expect(screen.queryByTestId('notes-drop-zone')).not.toBeInTheDocument();
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });
});

describe('NotesPage header actions', () => {
  it('offers Import notes and Libraries by default', () => {
    render(<NotesPage />, { host: hostFor(WRITER, { 'GET /notes': { items: [], nextCursor: null } }) });
    expect(screen.getByRole('button', { name: /import notes/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /libraries/i })).toHaveAttribute('href', '/notes/libraries');
  });

  it("keeps a host's own secondary action", () => {
    render(<NotesPage secondaryAction={<button type="button">Import…</button>} />, {
      host: hostFor(WRITER, { 'GET /notes': { items: [], nextCursor: null } }),
    });
    expect(screen.getByRole('button', { name: 'Import…' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /libraries/i })).not.toBeInTheDocument();
  });
});
