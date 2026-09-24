/**
 * The app-wide upload manager — issue #22, epic #19.
 *
 * The headline case is `keeps an upload running across a route change`: the
 * whole reason this is a provider around the shell rather than state on the
 * upload screen. The page that starts the transfer unmounts, the engine does
 * not, and the bytes keep moving.
 *
 * Everything else here is about the contract issues #30 and #32 will consume:
 * what `uploads` / `activeUploads` / `sessions` contain, and what the five
 * actions do to them.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import {
  UploadManagerProvider,
  KEEP_SCREEN_AWAKE_STORAGE_KEY,
  type UploadManagerContextValue,
} from '../../contexts/UploadManagerContext';
import { useUploadManager } from '../../hooks/useUploadManager';
import {
  UploadSessionGoneError,
  UploadSessionMismatchError,
  listUploadSessions,
  saveUploadSession,
  type UploadSessionRecord,
} from '../../services/uploadSessions';
import { KeepScreenAwakeToggle } from '../../components/upload/KeepScreenAwakeToggle';
import { createFakeXhrFactory, type FakeXhrController } from '../utils/fakeXhr';
import { installFakeIndexedDB, type FakeIndexedDbControl } from '../utils/fakeIndexedDB';
import type { UploadRuntime } from '../../services/resumableUpload';

const API = '*/api';
const OBJECT_ID = 'obj-1';
const PART_SIZE = 10;
const TOTAL_PARTS = 2;
const FRESH = new Date('2099-01-01T00:00:00.000Z').toISOString();

let xhr: FakeXhrController;
let idb: FakeIndexedDbControl;
let runtime: Partial<UploadRuntime>;
let abortCalls: number;
let uploadedParts: number[];

function makeFile(name = 'recording.m4a', lastModified = 111): File {
  return new File([new Uint8Array(PART_SIZE * TOTAL_PARTS)], name, {
    type: 'audio/mp4',
    lastModified,
  });
}

/** Captures the live context so a test can call actions imperatively. */
let manager: UploadManagerContextValue;

function Capture() {
  manager = useUploadManager();
  const first = manager.uploads[0];
  return (
    <div>
      <span data-testid="count">{manager.uploads.length}</span>
      <span data-testid="active">{manager.activeUploads.length}</span>
      <span data-testid="sessions">{manager.sessions.length}</span>
      <span data-testid="phase">{first ? first.progress.phase : 'none'}</span>
      <span data-testid="percent">{first ? first.progress.percent : ''}</span>
    </div>
  );
}

async function flushUi() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe('UploadManagerProvider', () => {
  beforeEach(() => {
    xhr = createFakeXhrFactory();
    idb = installFakeIndexedDB();
    abortCalls = 0;
    uploadedParts = [];
    localStorage.clear();

    runtime = {
      now: () => Date.now(),
      random: () => 0.5,
      createXhr: xhr.createXhr,
      isOnline: () => true,
      concurrency: () => 2,
    };

    server.use(
      http.post(`${API}/storage/objects/upload/init`, () =>
        HttpResponse.json({
          data: {
            objectId: OBJECT_ID,
            partSize: PART_SIZE,
            totalParts: TOTAL_PARTS,
            uploadId: 'upload-1',
            parts: [1, 2].map((partNumber) => ({
              partNumber,
              url: `https://s3.example.com/${OBJECT_ID}/part-${partNumber}`,
              expiresAt: FRESH,
            })),
          },
        }),
      ),
      http.post(`${API}/storage/objects/:id/upload/parts`, async ({ request }) => {
        const body = (await request.json()) as { partNumbers: number[] };
        return HttpResponse.json({
          data: body.partNumbers.map((partNumber) => ({
            partNumber,
            url: `https://s3.example.com/${OBJECT_ID}/part-${partNumber}`,
            expiresAt: FRESH,
          })),
        });
      }),
      http.get(`${API}/storage/objects/:id/upload/status`, () =>
        HttpResponse.json({
          data: {
            status: 'uploading',
            partSize: PART_SIZE,
            totalParts: TOTAL_PARTS,
            uploadedParts: uploadedParts.map((partNumber) => ({
              partNumber,
              size: PART_SIZE,
            })),
            uploadedBytes: uploadedParts.length * PART_SIZE,
            totalBytes: PART_SIZE * TOTAL_PARTS,
          },
        }),
      ),
      http.post(`${API}/storage/objects/:id/upload/complete`, () =>
        new HttpResponse(null, { status: 204 }),
      ),
      http.delete(`${API}/storage/objects/:id/upload/abort`, () => {
        abortCalls += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
  });

  afterEach(() => {
    idb.uninstall();
    xhr.reset();
  });

  // ---------------------------------------------------------------------------

  it('keeps an upload running across a route change', async () => {
    function StartPage() {
      const { startUpload } = useUploadManager();
      const navigate = useNavigate();
      return (
        <button
          type="button"
          onClick={async () => {
            await startUpload({ file: makeFile(), engineOptions: { runtime } });
            navigate('/elsewhere');
          }}
        >
          Start upload
        </button>
      );
    }

    render(
      <MemoryRouter initialEntries={['/new']}>
        <UploadManagerProvider>
          <Capture />
          <Routes>
            <Route path="/new" element={<StartPage />} />
            <Route path="/elsewhere" element={<p>Somewhere else entirely</p>} />
          </Routes>
        </UploadManagerProvider>
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Start upload' }));

    // The page that started the upload is GONE.
    expect(await screen.findByText('Somewhere else entirely')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start upload' })).not.toBeInTheDocument();

    // …and the transfer carries on regardless.
    const inFlight = await xhr.waitForPending(2);
    await act(async () => {
      inFlight.forEach((request) => request.respond());
    });

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('completed'));
    expect(screen.getByTestId('percent')).toHaveTextContent('100');
  });

  // ---------------------------------------------------------------------------

  describe('the list issues #30 and #32 render', () => {
    async function renderManager() {
      render(
        <MemoryRouter>
          <UploadManagerProvider>
            <Capture />
          </UploadManagerProvider>
        </MemoryRouter>,
      );
      await flushUi();
    }

    it('tracks an upload from start to completion and clears its session', async () => {
      await renderManager();

      await act(async () => {
        await manager.startUpload({ file: makeFile(), engineOptions: { runtime } });
      });

      expect(screen.getByTestId('count')).toHaveTextContent('1');
      expect(screen.getByTestId('active')).toHaveTextContent('1');
      // Recorded BEFORE the first part lands — the window it protects against
      // is widest at the start.
      expect(screen.getByTestId('sessions')).toHaveTextContent('1');
      expect(manager.uploads[0]).toMatchObject({
        objectId: OBJECT_ID,
        fileName: 'recording.m4a',
        size: PART_SIZE * TOTAL_PARTS,
        resumed: false,
      });

      const inFlight = await xhr.waitForPending(2);
      await act(async () => {
        inFlight.forEach((request) => request.respond());
      });

      await waitFor(() =>
        expect(screen.getByTestId('phase')).toHaveTextContent('completed'),
      );
      await waitFor(() => expect(screen.getByTestId('sessions')).toHaveTextContent('0'));
      expect(screen.getByTestId('active')).toHaveTextContent('0');
    });

    it('pauses and resumes a running upload', async () => {
      await renderManager();
      await act(async () => {
        await manager.startUpload({ file: makeFile(), engineOptions: { runtime } });
      });
      await xhr.waitForPending(2);

      act(() => manager.pauseUpload(OBJECT_ID));
      await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('paused'));
      expect(screen.getByTestId('active')).toHaveTextContent('0');

      act(() => manager.resumeUpload(OBJECT_ID));
      await waitFor(() =>
        expect(screen.getByTestId('phase')).toHaveTextContent('uploading'),
      );
      expect(xhr.requests).toHaveLength(4);

      await act(async () => {
        await manager.cancelUpload(OBJECT_ID);
      });
    });

    it('cancels an upload, aborts it server-side and forgets its session', async () => {
      await renderManager();
      await act(async () => {
        await manager.startUpload({ file: makeFile(), engineOptions: { runtime } });
      });
      await xhr.waitForPending(2);

      await act(async () => {
        await manager.cancelUpload(OBJECT_ID);
      });

      expect(abortCalls).toBe(1);
      expect(screen.getByTestId('phase')).toHaveTextContent('cancelled');
      await waitFor(() => expect(screen.getByTestId('sessions')).toHaveTextContent('0'));
    });

    it('dismisses a settled upload but refuses to hide a running one', async () => {
      await renderManager();
      await act(async () => {
        await manager.startUpload({ file: makeFile(), engineOptions: { runtime } });
      });
      await xhr.waitForPending(2);

      // Hiding a live transfer would leave it consuming the user's data with
      // nothing on screen able to stop it.
      act(() => manager.dismissUpload(OBJECT_ID));
      expect(screen.getByTestId('count')).toHaveTextContent('1');

      await act(async () => {
        await manager.cancelUpload(OBJECT_ID);
      });
      act(() => manager.dismissUpload(OBJECT_ID));

      expect(screen.getByTestId('count')).toHaveTextContent('0');
    });
  });

  // ---------------------------------------------------------------------------

  describe('resuming after a reload', () => {
    async function renderWithStoredSession() {
      render(
        <MemoryRouter>
          <UploadManagerProvider>
            <Capture />
          </UploadManagerProvider>
        </MemoryRouter>,
      );
      await flushUi();

      await act(async () => {
        await manager.startUpload({ file: makeFile(), engineOptions: { runtime } });
      });
      const inFlight = await xhr.waitForPending(2);

      // The tab "dies": part 1 lands, part 2 never does.
      await act(async () => {
        inFlight[0].respond();
      });
      uploadedParts = [1];
      act(() => manager.pauseUpload(OBJECT_ID));
      act(() => manager.dismissUpload(OBJECT_ID));
      xhr.reset();
    }

    it('re-picks the file, skips what the server already holds, and finishes', async () => {
      await renderWithStoredSession();

      const session = manager.sessions[0];
      expect(session).toMatchObject({ objectId: OBJECT_ID, fileName: 'recording.m4a' });

      await act(async () => {
        await manager.resumeFromSession(session, makeFile(), { runtime });
      });

      expect(manager.uploads[0].resumed).toBe(true);
      const inFlight = await xhr.waitForPending(1);
      // Part 1 is NOT re-sent: the status endpoint is the authority on what
      // landed, not this browser's memory of what it sent.
      expect(xhr.requests).toHaveLength(1);
      expect(inFlight[0].url).toContain('part-2');

      await act(async () => {
        inFlight[0].respond();
      });
      await waitFor(() =>
        expect(screen.getByTestId('phase')).toHaveTextContent('completed'),
      );
    });

    it('refuses a file that is not the one the session was started for', async () => {
      await renderWithStoredSession();
      const session = manager.sessions[0];

      await expect(
        manager.resumeFromSession(session, makeFile('something-else.m4a'), { runtime }),
      ).rejects.toBeInstanceOf(UploadSessionMismatchError);

      // Nothing was uploaded, and nothing was asked of the API: the check runs
      // before a single byte of the wrong file can reach the object.
      expect(xhr.requests).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------

  describe('discarding sessions whose transcript is gone (issue #339)', () => {
    const TRANSCRIPT_ID = 't-stale';
    let transcriptRequests: number;

    const storedSession: UploadSessionRecord = {
      objectId: 'obj-stale',
      transcriptId: TRANSCRIPT_ID,
      fileName: 'OpenAI.m4a',
      size: PART_SIZE * TOTAL_PARTS,
      lastModified: 111,
      partSize: PART_SIZE,
      createdAt: 1,
    };

    /** Answer `GET /api/transcripts/:id` with whatever `respond` returns. */
    function transcriptAnswers(respond: () => Response) {
      transcriptRequests = 0;
      server.use(
        http.get(`${API}/transcripts/:id`, () => {
          transcriptRequests += 1;
          return respond();
        }),
      );
    }

    function transcriptWithStatus(status: string) {
      return () => HttpResponse.json({ data: { id: TRANSCRIPT_ID, status } });
    }

    async function renderWithSession() {
      // Persisted by a "previous visit", before the provider ever mounts.
      await saveUploadSession(storedSession);
      render(
        <MemoryRouter>
          <UploadManagerProvider>
            <Capture />
          </UploadManagerProvider>
        </MemoryRouter>,
      );
      await flushUi();
    }

    /** Wait for the reconcile request, then let whatever it decided settle. */
    async function afterReconcile() {
      await waitFor(() => expect(transcriptRequests).toBeGreaterThan(0));
      await flushUi();
      await flushUi();
    }

    it('discards a session whose transcript answers 404 (purged)', async () => {
      transcriptAnswers(() =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 }),
      );
      await renderWithSession();

      await waitFor(() => expect(screen.getByTestId('sessions')).toHaveTextContent('0'));
      expect(await listUploadSessions()).toEqual([]);
      expect(transcriptRequests).toBe(1);
    });

    it('discards a session whose transcript is being deleted', async () => {
      transcriptAnswers(transcriptWithStatus('deleting'));
      await renderWithSession();

      await waitFor(() => expect(screen.getByTestId('sessions')).toHaveTextContent('0'));
      expect(await listUploadSessions()).toEqual([]);
    });

    it('discards a session whose transcript no longer needs its upload', async () => {
      transcriptAnswers(transcriptWithStatus('processing'));
      await renderWithSession();

      await waitFor(() => expect(screen.getByTestId('sessions')).toHaveTextContent('0'));
    });

    it('keeps a session whose transcript is still uploading — Resume is valid', async () => {
      transcriptAnswers(transcriptWithStatus('uploading'));
      await renderWithSession();
      await afterReconcile();

      expect(screen.getByTestId('sessions')).toHaveTextContent('1');
      expect(await listUploadSessions()).toHaveLength(1);
    });

    it('keeps the session on a network error — it is retried on the next reconcile', async () => {
      transcriptAnswers(() => HttpResponse.error());
      await renderWithSession();
      await afterReconcile();

      expect(screen.getByTestId('sessions')).toHaveTextContent('1');
      expect(await listUploadSessions()).toHaveLength(1);
    });

    it('keeps the session on a server error', async () => {
      transcriptAnswers(() => HttpResponse.json({ message: 'boom' }, { status: 503 }));
      await renderWithSession();
      await afterReconcile();

      expect(screen.getByTestId('sessions')).toHaveTextContent('1');
    });

    it('never asks about a session with no transcript attached', async () => {
      transcriptAnswers(() => HttpResponse.json({ message: 'Not found' }, { status: 404 }));
      await saveUploadSession({ ...storedSession, transcriptId: null });
      render(
        <MemoryRouter>
          <UploadManagerProvider>
            <Capture />
          </UploadManagerProvider>
        </MemoryRouter>,
      );
      await flushUi();
      await flushUi();

      expect(transcriptRequests).toBe(0);
      expect(screen.getByTestId('sessions')).toHaveTextContent('1');
    });

    it('reconciles again when the tab becomes visible', async () => {
      let status = 'uploading';
      transcriptAnswers(() => transcriptWithStatus(status)());
      await renderWithSession();
      await afterReconcile();
      expect(screen.getByTestId('sessions')).toHaveTextContent('1');

      // Hours in a background tab: the purge ran meanwhile.
      status = 'deleting';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await waitFor(() => expect(screen.getByTestId('sessions')).toHaveTextContent('0'));
      expect(transcriptRequests).toBe(2);
    });

    it('discards the session when Resume finds the upload gone', async () => {
      // The transcript check still says "uploading" (a purge racing the
      // reconcile), but the object itself is already gone.
      transcriptAnswers(transcriptWithStatus('uploading'));
      server.use(
        http.get(`${API}/storage/objects/:id/upload/status`, () =>
          HttpResponse.json({ message: 'Not found' }, { status: 404 }),
        ),
      );
      await renderWithSession();
      await afterReconcile();

      const session = manager.sessions[0];
      await act(async () => {
        await expect(
          manager.resumeFromSession(session, makeFile('OpenAI.m4a'), { runtime }),
        ).rejects.toBeInstanceOf(UploadSessionGoneError);
      });

      expect(screen.getByTestId('sessions')).toHaveTextContent('0');
      expect(await listUploadSessions()).toEqual([]);
      expect(xhr.requests).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------

  describe('keep screen on', () => {
    it('defaults on, persists the user turning it off, and hides where unsupported', async () => {
      render(
        <MemoryRouter>
          <UploadManagerProvider>
            <Capture />
            <KeepScreenAwakeToggle />
          </UploadManagerProvider>
        </MemoryRouter>,
      );
      await flushUi();

      expect(manager.keepScreenAwake).toBe(true);
      // jsdom has no Screen Wake Lock API, so the toggle renders nothing
      // rather than apologising for a platform gap.
      expect(manager.wakeLockSupported).toBe(false);
      expect(screen.queryByLabelText(/keep screen on/i)).not.toBeInTheDocument();

      act(() => manager.setKeepScreenAwake(false));

      expect(manager.keepScreenAwake).toBe(false);
      expect(localStorage.getItem(KEEP_SCREEN_AWAKE_STORAGE_KEY)).toBe('false');
    });

    it('renders the switch where the API exists', async () => {
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        writable: true,
        value: { request: async () => ({ release: async () => {}, addEventListener: () => {} }) },
      });

      render(
        <MemoryRouter>
          <UploadManagerProvider>
            <Capture />
            <KeepScreenAwakeToggle />
          </UploadManagerProvider>
        </MemoryRouter>,
      );
      await flushUi();

      const toggle = screen.getByLabelText(/keep screen on/i);
      expect(toggle).toBeChecked();

      await userEvent.click(toggle);
      expect(localStorage.getItem(KEEP_SCREEN_AWAKE_STORAGE_KEY)).toBe('false');

      delete (navigator as { wakeLock?: unknown }).wakeLock;
    });
  });
});
