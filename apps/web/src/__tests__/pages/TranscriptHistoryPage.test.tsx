import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

const navigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 't1' }), useNavigate: () => navigate };
});

vi.mock('../../services/transcripts', () => ({
  getTranscript: vi.fn(),
  getTranscriptSegments: vi.fn(),
}));

vi.mock('../../services/transcriptEditing', () => ({
  getTranscriptVersions: vi.fn(),
  getTranscriptVersion: vi.fn(),
  restoreTranscriptVersion: vi.fn(),
}));

vi.mock('../../contexts/NotificationContext', () => ({ useNotifications: () => null }));

import { render, mockAdminUser } from '../utils/test-utils';
import TranscriptHistoryPage from '../../pages/TranscriptHistoryPage';
import { ApiError } from '../../services/api';
import {
  getTranscriptVersion,
  getTranscriptVersions,
  restoreTranscriptVersion,
} from '../../services/transcriptEditing';
import type { TranscriptVersionSummary } from '../../services/transcriptEditing';
import { getTranscript } from '../../services/transcripts';
import type {
  TranscriptAccessRole,
  TranscriptDetail,
  TranscriptSegment,
  TranscriptSpeaker,
} from '../../services/transcripts';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const mockVersions = vi.mocked(getTranscriptVersions);
const mockVersion = vi.mocked(getTranscriptVersion);
const mockRestore = vi.mocked(restoreTranscriptVersion);
const mockGetTranscript = vi.mocked(getTranscript);

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Ana', colorIndex: 0, rev: 1 },
];

const SEGMENTS: TranscriptSegment[] = [
  {
    id: 's0',
    speakerId: 'sp1',
    startMs: 0,
    endMs: 4000,
    ordinal: 1000,
    text: 'The original wording',
    wordsAlignment: 'exact',
    confidence: 0.9,
    origin: 'ai',
    rev: 1,
    editedAt: null,
  },
];

function version(
  number: number,
  overrides: Partial<TranscriptVersionSummary> = {},
): TranscriptVersionSummary {
  return {
    version: number,
    kind: 'edit',
    summary: 'Edited 1 segment',
    author: { id: 'u1', name: 'Ana Ruiz', email: 'ana@example.com' },
    restoredFromVersion: null,
    hasSnapshot: false,
    opCount: 1,
    createdAt: '2026-09-14T10:00:00.000Z',
    ...overrides,
  };
}

function detail(access: TranscriptAccessRole = 'owner'): TranscriptDetail {
  return {
    id: 't1',
    title: 'Weekly standup',
    status: 'ready',
    transcriptionStatus: 'completed',
    playbackStatus: 'ready',
    language: 'en',
    durationMs: 60_000,
    speakerCount: 1,
    wordCount: 40,
    currentVersion: 4,
    failureReason: null,
    access,
    createdAt: '2026-09-14T08:00:00.000Z',
    updatedAt: '2026-09-14T10:00:00.000Z',
    speakers: SPEAKERS,
    provider: 'AssemblyAI',
    remoteDeletedAt: null,
    submittedAt: null,
    completedAt: null,
    sourceName: 'standup.m4a',
    sourceMimeType: 'audio/mp4',
    sourceSizeBytes: '1048576',
  };
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTranscript.mockResolvedValue({ status: 'ok', data: detail(), etag: null });
  mockVersions.mockResolvedValue({
    currentVersion: 4,
    items: [
      version(4, { createdAt: '2026-09-14T10:00:00.000Z' }),
      version(3, {
        createdAt: '2026-09-14T09:55:00.000Z',
        summary: 'Merged Speaker 3 into Ana',
      }),
      version(2, {
        createdAt: '2026-09-13T09:00:00.000Z',
        author: { id: 'u2', name: 'Ben Olsen', email: null },
      }),
      version(1, {
        kind: 'ai_original',
        author: null,
        summary: null,
        createdAt: '2026-09-13T08:00:00.000Z',
      }),
    ],
    nextCursor: null,
  });
  mockVersion.mockResolvedValue({
    ...version(1, { kind: 'ai_original', author: null, summary: null }),
    currentVersion: 4,
    speakers: SPEAKERS,
    segments: SEGMENTS,
  });
  mockRestore.mockResolvedValue({
    version: 5,
    summary: 'Restored version 1',
    idempotentReplay: false,
    speakers: SPEAKERS,
    segments: SEGMENTS,
    merges: [],
  });
});

function renderPage() {
  return render(<TranscriptHistoryPage />, { wrapperOptions: { user: mockAdminUser } });
}

describe('TranscriptHistoryPage — the list', () => {
  it('groups consecutive saves by one author on one day into a session', async () => {
    renderPage();

    // v4 and v3 are one sitting; v2 is another author's day; v1 stands alone.
    const sessions = await screen.findAllByRole('heading', { level: 2 });
    expect(sessions.map((heading) => heading.textContent)).toEqual([
      'Ana Ruiz',
      'Ben Olsen',
      'The transcription service',
    ]);
  });

  it('summarises a session from the server’s own summaries', async () => {
    renderPage();

    expect(
      await screen.findByText('Edited 1 segment · Merged Speaker 3 into Ana'),
    ).toBeInTheDocument();
  });

  it('badges version 1 as the AI original', async () => {
    renderPage();

    expect(await screen.findByText('AI original')).toBeInTheDocument();
  });

  it('marks which version is current', async () => {
    renderPage();

    expect(await screen.findByText('Current')).toBeInTheDocument();
  });

  it('passes axe', async () => {
    const { container } = renderPage();
    await screen.findByText('AI original');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('TranscriptHistoryPage — previewing a version', () => {
  it('renders the version with the same segment list the viewer uses, read-only', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Version 1/ }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('The original wording')).toBeInTheDocument();
    expect(mockVersion).toHaveBeenCalledWith('t1', 1);
    // The preview is the reader, so it carries none of the editing affordances.
    expect(within(dialog).queryByRole('button', { name: /^Edit the line/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Actions for the line/ })).toBeNull();
    // Nor the per-line play button (#108): a version preview has no player at
    // all, so a control that would start one belongs to the viewer, not here.
    expect(within(dialog).queryByRole('button', { name: /^Play this line/ })).toBeNull();
  });

  it('says a version older than the first snapshot is still being prepared', async () => {
    // A 409 here means "not materializable yet", never "you did something
    // wrong" — spec §4.3 only guarantees a snapshot for v1 and for restores.
    const user = userEvent.setup();
    mockVersion.mockRejectedValue(new ApiError('No snapshot', 409));
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Version 2/ }));

    expect(await screen.findByText(/still being prepared/)).toBeInTheDocument();
  });

  it('offers no Restore for the version that is already current', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Version 4/ }));

    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Restore this version' })).toBeNull();
  });

  it('offers no Restore to a viewer', async () => {
    const user = userEvent.setup();
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail('viewer'),
      etag: null,
    });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Version 1/ }));

    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Restore this version' })).toBeNull();
  });
});

describe('TranscriptHistoryPage — restoring', () => {
  it('confirms first, then restores against the current version and returns', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Version 1/ }));
    await user.click(await screen.findByRole('button', { name: 'Restore this version' }));

    expect(await screen.findByText('Restore version 1?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(mockRestore).toHaveBeenCalledWith('t1', 1, 4));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/transcripts/t1'));
  });

  it('explains a stale baseVersion rather than retrying with a guess', async () => {
    // This route's `baseVersion` MUST match, unlike the operations route's:
    // restoring over somebody's unseen edit is exactly what the 409 prevents.
    const user = userEvent.setup();
    mockRestore.mockRejectedValue(new ApiError('Stale', 409));
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Version 1/ }));
    await user.click(await screen.findByRole('button', { name: 'Restore this version' }));
    await user.click(await screen.findByRole('button', { name: 'Restore' }));

    expect(
      await screen.findByText(/Somebody saved a change while this page was open/),
    ).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalledWith('/transcripts/t1');
  });
});

describe('TranscriptHistoryPage — failures', () => {
  it('renders a load failure as a sentence', async () => {
    mockVersions.mockRejectedValue(new ApiError('Not found', 404));
    renderPage();

    expect(
      await screen.findByText(/no longer have access to it/),
    ).toBeInTheDocument();
  });

  it('says so plainly when there is nothing recorded', async () => {
    mockVersions.mockResolvedValue({ currentVersion: 1, items: [], nextCursor: null });
    renderPage();

    expect(
      await screen.findByText('This transcript has no recorded versions yet.'),
    ).toBeInTheDocument();
  });
});
