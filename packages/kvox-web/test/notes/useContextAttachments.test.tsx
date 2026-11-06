/**
 * `useContextAttachments` (#810): upload, poll an extracting document until it settles,
 * remove, the limit, and the ids a request carries.
 *
 * The two clients are mocked; everything else (the checks, the error sentences) is real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';

vi.mock('../../src/notes/headless/clients/notes.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/notes/headless/clients/notes.js')>(
    '../../src/notes/headless/clients/notes.js',
  );
  return { ...actual, uploadNoteContextAttachment: vi.fn(), getNoteContextAttachmentStatus: vi.fn() };
});

import { KvoxApiError } from '../../src/core/headless/index.js';
import { renderHook } from './helpers.js';
import {
  getNoteContextAttachmentStatus,
  uploadNoteContextAttachment,
} from '../../src/notes/headless/clients/notes.js';
import { useContextAttachments } from '../../src/notes/headless/hooks/useContextAttachments.js';
import { MAX_CONTEXT_ATTACHMENTS } from '../../src/notes/headless/utils/contextAttachments.js';

const mockUpload = vi.mocked(uploadNoteContextAttachment);
const mockStatus = vi.mocked(getNoteContextAttachmentStatus);

function pdf(name = 'agenda.pdf'): File {
  return new File(['%PDF'], name, { type: 'application/pdf' });
}

function png(name = 'board.png'): File {
  return new File(['png'], name, { type: 'image/png' });
}

beforeEach(() => {
  mockUpload.mockReset();
  mockStatus.mockReset();
  mockUpload.mockImplementation(async (_host, file) => ({
    objectId: `obj-${file.name}`,
    kind: file.type.startsWith('image/') ? 'image' : 'document',
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    status: file.type.startsWith('image/') ? 'ready' : 'extracting',
    jobId: file.type.startsWith('image/') ? null : 'job-1',
  }));
});

describe('useContextAttachments', () => {
  it('starts empty and ready, with no ids', () => {
    const { result } = renderHook(() => useContextAttachments());
    expect(result.current.items).toEqual([]);
    expect(result.current.allReady).toBe(true);
    expect(result.current.ids).toEqual([]);
    expect(result.current.blockingReason).toBeNull();
  });

  it('starts from the attachments it is given, all ready', () => {
    const { result } = renderHook(() =>
      useContextAttachments({
        initial: [{ objectId: 'o1', kind: 'image', filename: 'a.png', mimeType: 'image/png' }],
      }),
    );
    expect(result.current.ids).toEqual(['o1']);
    expect(result.current.items[0]).toMatchObject({ status: 'ready', filename: 'a.png' });
  });

  it('uploads an image and is ready at once', async () => {
    const { result } = renderHook(() => useContextAttachments({ pollMs: 20 }));
    act(() => result.current.addFiles([png()]));

    expect(result.current.items[0].status).toBe('uploading');
    expect(result.current.allReady).toBe(false);
    await waitFor(() => expect(result.current.items[0].status).toBe('ready'));
    expect(result.current.ids).toEqual(['obj-board.png']);
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('polls an extracting document until it is ready', async () => {
    mockStatus.mockResolvedValueOnce({
      objectId: 'obj-agenda.pdf',
      kind: 'document',
      status: 'extracting',
      message: null,
      characters: null,
    });
    mockStatus.mockResolvedValue({
      objectId: 'obj-agenda.pdf',
      kind: 'document',
      status: 'ready',
      message: null,
      characters: 1234,
    });
    // Slow enough that the first (extracting) answer is observable before the second.
    const { result } = renderHook(() => useContextAttachments({ pollMs: 300 }));
    act(() => result.current.addFiles([pdf()]));

    await waitFor(() => expect(result.current.items[0].status).toBe('extracting'));
    expect(result.current.blockingReason).toMatch(/Wait/);
    await waitFor(() => expect(result.current.items[0].status).toBe('ready'));
    expect(result.current.items[0].characters).toBe(1234);
    expect(result.current.ids).toEqual(['obj-agenda.pdf']);
    expect(mockStatus).toHaveBeenCalledWith(expect.anything(), 'obj-agenda.pdf');
  });

  it('fails a document with no readable text, with the server’s sentence', async () => {
    mockStatus.mockResolvedValue({
      objectId: 'obj-scan.pdf',
      kind: 'document',
      status: 'unextractable',
      message: 'This PDF has no text layer.',
      characters: null,
    });
    const { result } = renderHook(() => useContextAttachments({ pollMs: 20 }));
    act(() => result.current.addFiles([pdf('scan.pdf')]));

    await waitFor(() => expect(result.current.items[0].status).toBe('failed'));
    expect(result.current.items[0].error).toBe('This PDF has no text layer.');
    expect(result.current.ids).toEqual([]);
    expect(result.current.blockingReason).toMatch(/Remove/);
  });

  it('fails a row whose upload was refused, with a friendly sentence', async () => {
    mockUpload.mockRejectedValueOnce(
      new KvoxApiError('raw', 400, undefined, { reason: 'context_attachment_unsupported_type' }),
    );
    const { result } = renderHook(() => useContextAttachments());
    act(() => result.current.addFiles([png('fake.png')]));

    await waitFor(() => expect(result.current.items[0].status).toBe('failed'));
    expect(result.current.items[0].error).toMatch(/cannot be attached/);
  });

  it('refuses an unsupported file before any upload, as a failed row', () => {
    const { result } = renderHook(() => useContextAttachments());
    act(() => result.current.addFiles([new File(['x'], 'clip.mp4', { type: 'video/mp4' })]));

    expect(result.current.items[0]).toMatchObject({ status: 'failed', kind: null });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('removes a row, and removing the failed one unblocks', async () => {
    const { result } = renderHook(() => useContextAttachments());
    act(() => result.current.addFiles([new File(['x'], 'clip.mp4', { type: 'video/mp4' }), png()]));
    await waitFor(() => expect(result.current.items[1].status).toBe('ready'));
    expect(result.current.allReady).toBe(false);

    act(() => result.current.remove(result.current.items[0].key));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.allReady).toBe(true);
    expect(result.current.ids).toEqual(['obj-board.png']);
  });

  it('ignores the answer of an upload whose row was removed while in flight', async () => {
    let resolve: (value: Awaited<ReturnType<typeof uploadNoteContextAttachment>>) => void = () => undefined;
    mockUpload.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useContextAttachments());
    act(() => result.current.addFiles([png()]));
    act(() => result.current.remove(result.current.items[0].key));

    await act(async () => {
      resolve({
        objectId: 'late',
        kind: 'image',
        filename: 'board.png',
        mimeType: 'image/png',
        size: 3,
        status: 'ready',
        jobId: null,
      });
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.ids).toEqual([]);
  });

  it(`adds at most ${MAX_CONTEXT_ATTACHMENTS} files and says how many were refused`, async () => {
    const { result } = renderHook(() => useContextAttachments());
    const files = Array.from({ length: MAX_CONTEXT_ATTACHMENTS + 2 }, (_, i) => png(`img-${i}.png`));
    act(() => result.current.addFiles(files));

    expect(result.current.items).toHaveLength(MAX_CONTEXT_ATTACHMENTS);
    expect(result.current.remaining).toBe(0);
    expect(result.current.notice).toMatch(/2 files were not added/);
    expect(mockUpload).toHaveBeenCalledTimes(MAX_CONTEXT_ATTACHMENTS);

    act(() => result.current.addFiles([png('one-more.png')]));
    expect(result.current.items).toHaveLength(MAX_CONTEXT_ATTACHMENTS);
    expect(result.current.notice).toMatch(/1 file was not added/);
    await waitFor(() => expect(result.current.allReady).toBe(true));
  });

  it('reset replaces every row', () => {
    const { result } = renderHook(() => useContextAttachments());
    act(() => result.current.addFiles([new File(['x'], 'clip.mp4', { type: 'video/mp4' })]));
    act(() =>
      result.current.reset([{ objectId: 'o9', kind: 'document', filename: 'x.md', mimeType: 'text/markdown' }]),
    );
    expect(result.current.ids).toEqual(['o9']);
    expect(result.current.allReady).toBe(true);
  });
});
