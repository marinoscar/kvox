/**
 * The pre-flight dialog (#813): counts by type, size, skipped files grouped by reason, the
 * extraction line, the batch-cap refusal, the unpacking state, and the ZIP flow from the
 * import button. Invented content only.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { strToU8, zipSync } from 'fflate';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';
import { BatchUploadProvider } from '../../src/notes/headless/index.js';
import type { NoteImportManifest } from '../../src/notes/headless/index.js';
import { ImportNotesButton } from '../../src/notes/ui/components/ImportNotesButton.js';
import { ImportPreflightDialog } from '../../src/notes/ui/components/ImportPreflightDialog.js';
import { mockUser, render } from '../transcripts/helpers.js';

const WRITER = { ...mockUser, permissions: ['notes:read', 'notes:write', 'graph:read'] };

function manifestOf(overrides: Partial<NoteImportManifest> = {}): NoteImportManifest {
  const file = (name: string) => new File(['x'.repeat(1024)], name);
  return {
    accepted: [
      { file: file('a.pdf'), path: 'pack/a.pdf', kind: 'pdf', size: 1024 },
      { file: file('b.docx'), path: 'pack/b.docx', kind: 'docx', size: 1024 },
      { file: file('c.md'), path: 'pack/c.md', kind: 'md', size: 1024 },
    ],
    rejected: [
      { name: 'x.png', path: 'pack/x.png', reason: 'in_archive_unsupported' },
      { name: 'y.png', path: 'pack/y.png', reason: 'in_archive_unsupported' },
      { name: '.DS_Store', path: '.DS_Store', reason: 'system_file' },
    ],
    counts: { pdf: 1, docx: 1, pptx: 0, md: 1, txt: 0 },
    totalBytes: 3072,
    archives: 1,
    refusal: null,
    ...overrides,
  };
}

describe('ImportPreflightDialog', () => {
  it('shows counts by type, size, skipped groups and the extraction line; Import and Cancel answer', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ImportPreflightDialog open manifest={manifestOf()} onConfirm={onConfirm} onCancel={onCancel} />, {
      wrapperOptions: { user: WRITER },
    });

    const dialog = screen.getByRole('dialog', { name: 'Import these files?' });
    expect(within(dialog).getByText('3 files · 3.0 KB')).toBeInTheDocument();
    expect(within(dialog).getByText('PDF 1')).toBeInTheDocument();
    expect(within(dialog).getByText('Word 1')).toBeInTheDocument();
    expect(within(dialog).getByText('Markdown 1')).toBeInTheDocument();
    expect(within(dialog).getByText('3 files skipped')).toBeInTheDocument();
    expect(within(dialog).getByText('Not a supported type (2)')).toBeInTheDocument();
    expect(within(dialog).getByText('System or hidden files (1)')).toBeInTheDocument();
    expect(within(dialog).getByText(/Review Queue/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByText('Not a supported type (2)'));
    expect(within(dialog).getByText('pack/x.png')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 3 files' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('virtualizes a long skipped group', () => {
    const rejected = Array.from({ length: 300 }, (_, i) => ({
      name: `f${i}.png`,
      path: `pack/f${i}.png`,
      reason: 'in_archive_unsupported' as const,
    }));
    render(<ImportPreflightDialog open manifest={manifestOf({ rejected })} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText('Not a supported type (300)'));
    expect(screen.getByTestId('preflight-skipped-scroll')).toBeInTheDocument();
    expect(screen.queryAllByText(/^pack\/f\d+\.png$/).length).toBeLessThan(300);
  });

  it('shows the batch-cap refusal and no import button', () => {
    render(
      <ImportPreflightDialog
        open
        manifest={manifestOf({
          refusal: { reason: 'batch_too_large', found: 620, limit: 500, message: 'This is 620 files; one import takes at most 500. Split it into smaller imports.' },
        })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/split it into smaller imports/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^import/i })).not.toBeInTheDocument();
  });

  it('shows the unpacking progress while preparing', () => {
    render(
      <ImportPreflightDialog
        open
        isPreparing
        preparing={{ archive: 'big.zip', archiveIndex: 1, archiveCount: 1, bytesRead: 50, totalBytes: 100 }}
        manifest={null}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Reading your files' })).toBeInTheDocument();
    expect(screen.getByText('Unpacking big.zip…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Unpacking' })).toHaveAttribute('aria-valuenow', '50');
  });

  it('says when extraction is off', () => {
    render(<ImportPreflightDialog open manifest={manifestOf()} autoExtract={false} showExtractionNotice onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/extraction is off for you/i)).toBeInTheDocument();
  });
});

describe('ImportNotesButton with a ZIP and the background upload', () => {
  it('unpacks the archive, asks, opens the batch at once and keeps uploading', async () => {
    const host = createFakeKvoxWebHost({
      viewer: { userId: WRITER.id, permissions: WRITER.permissions },
      routes: {
        'POST /notes/import-batches': { batchId: 'zip-1' },
        'POST /notes/import-batches/:id/files': { itemId: 'i', action: 'new', skipped: false },
        'POST /notes/import-batches/:id/close': {},
      },
    });
    render(
      <BatchUploadProvider>
        <Routes>
          <Route path="/notes" element={<ImportNotesButton />} />
          <Route path="/notes/import-batches/:batchId" element={<p>Batch page</p>} />
        </Routes>
      </BatchUploadProvider>,
      { host, wrapperOptions: { route: '/notes' } },
    );

    const input = screen.getByLabelText('Choose notes to import');
    expect(input.getAttribute('accept')).toContain('.zip');
    const archive = new File(
      [zipSync({ 'one.md': strToU8('# One'), 'two.txt': strToU8('Two'), 'skip.png': strToU8('png') }) as BlobPart],
      'Pack.zip',
    );
    fireEvent.change(input, { target: { files: [archive] } });

    const dialog = await screen.findByRole('dialog', { name: 'Import these files?' });
    expect(within(dialog).getByText('1 file skipped')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 2 files' }));

    expect(await screen.findByText('Batch page')).toBeInTheDocument();
    await waitFor(() => expect(host.callsTo('POST /notes/import-batches/zip-1/files')).toHaveLength(2));
    const paths = host.callsTo('POST /notes/import-batches/zip-1/files').map((call) => (call.body as FormData).get('path'));
    expect(paths.sort()).toEqual(['Pack/one.md', 'Pack/two.txt']);
    await waitFor(() => expect(host.callsTo('POST /notes/import-batches/zip-1/close')).toHaveLength(1));
  });
});
