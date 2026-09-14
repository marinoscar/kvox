import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 't1' }), useNavigate: () => vi.fn() };
});

vi.mock('../../services/transcripts', () => ({
  getTranscript: vi.fn(),
  getTranscriptSegments: vi.fn(),
  getTranscriptAudio: vi.fn(),
  getTranscriptWords: vi.fn(),
  retryTranscript: vi.fn(),
  deleteTranscript: vi.fn(),
  removeShare: vi.fn(),
}));

vi.mock('../../services/transcriptEditing', async () => {
  const actual = await vi.importActual<typeof import('../../services/transcriptEditing')>(
    '../../services/transcriptEditing',
  );
  return {
    ...actual,
    applyOperations: vi.fn(),
    searchTranscript: vi.fn(),
    restoreTranscriptVersion: vi.fn(),
  };
});

vi.mock('../../contexts/NotificationContext', () => ({ useNotifications: () => null }));

import { render, mockAdminUser } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import TranscriptPage from '../../pages/TranscriptPage';
import {
  getTranscript,
  getTranscriptAudio,
  getTranscriptSegments,
  getTranscriptWords,
} from '../../services/transcripts';
import type {
  TranscriptAccessRole,
  TranscriptDetail,
  TranscriptSegment,
  TranscriptSpeaker,
} from '../../services/transcripts';
import { applyOperations, searchTranscript } from '../../services/transcriptEditing';
import type { OperationsResult } from '../../services/transcriptEditing';

/**
 * The correction UI on the real page, over the real hooks and the real engine,
 * with the SERVICE layer mocked — the same shape as `TranscriptPage.test.tsx`
 * and for the same reason: mocking the hooks would leave the wiring this page
 * mostly consists of asserted by nothing.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

/**
 * For a PORTALLED surface (a popover, a bottom sheet), checked against
 * `document.body`.
 *
 * `region` is off because it is an artefact of the harness, not a defect: axe
 * wants every top-level node inside a landmark, and a portal root is by
 * definition a sibling of the app shell that owns the landmarks. The real page
 * satisfies the rule; a test that renders one page into a bare body cannot.
 */
const AXE_PORTAL_OPTIONS = {
  rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
};

const mockGetTranscript = vi.mocked(getTranscript);
const mockGetSegments = vi.mocked(getTranscriptSegments);
const mockGetAudio = vi.mocked(getTranscriptAudio);
const mockGetWords = vi.mocked(getTranscriptWords);
const mockApply = vi.mocked(applyOperations);
const mockSearch = vi.mocked(searchTranscript);

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Ana', colorIndex: 0, rev: 1 },
  { id: 'sp2', label: 'B', displayName: 'Speaker 3', colorIndex: 1, rev: 1 },
];

const SEGMENTS: TranscriptSegment[] = Array.from({ length: 6 }, (_, index) => ({
  id: `s${index}`,
  speakerId: index % 2 === 0 ? 'sp1' : 'sp2',
  startMs: index * 5000,
  endMs: index * 5000 + 4000,
  ordinal: (index + 1) * 1000,
  text: `Line number ${index}`,
  wordsAlignment: 'exact' as const,
  confidence: 0.9,
  origin: 'ai' as const,
  rev: 1,
  editedAt: null,
}));

function detail(access: TranscriptAccessRole = 'owner'): TranscriptDetail {
  return {
    id: 't1',
    title: 'Weekly standup',
    status: 'ready',
    transcriptionStatus: 'completed',
    playbackStatus: 'ready',
    language: 'en',
    durationMs: 60_000,
    speakerCount: 2,
    wordCount: 120,
    currentVersion: 4,
    failureReason: null,
    access,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
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

function opsResult(overrides: Partial<OperationsResult> = {}): OperationsResult {
  return {
    version: 5,
    summary: 'Edited 1 segment',
    idempotentReplay: false,
    speakers: SPEAKERS,
    segments: SEGMENTS,
    merges: [],
    ...overrides,
  };
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  for (const method of ['play', 'pause', 'load'] as const) {
    Object.defineProperty(HTMLMediaElement.prototype, method, {
      configurable: true,
      writable: true,
      value: method === 'play' ? vi.fn().mockResolvedValue(undefined) : vi.fn(),
    });
  }
});

afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
});

beforeEach(() => {
  vi.clearAllMocks();
  setViewportWidth(1440);
  mockGetTranscript.mockResolvedValue({ status: 'ok', data: detail(), etag: 'W/"v4"' });
  mockGetSegments.mockResolvedValue({
    status: 'ok',
    data: { currentVersion: 4, segments: SEGMENTS },
    etag: 'W/"v4"',
  });
  mockGetAudio.mockResolvedValue({
    url: 'https://storage.example/signed',
    kind: 'playback',
    mimeType: 'audio/mp4',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  mockGetWords.mockResolvedValue({
    currentVersion: 4,
    fromMs: 0,
    toMs: 300_000,
    segments: [],
  });
  mockApply.mockResolvedValue(opsResult());
  mockSearch.mockResolvedValue({
    q: 'Line',
    matchCase: false,
    wholeWord: false,
    speakerId: null,
    total: 2,
    segmentCount: 2,
    truncated: false,
    matches: [
      { segmentId: 's0', speakerId: 'sp1', startMs: 0, start: 0, end: 4, preview: 'Line…' },
      { segmentId: 's2', speakerId: 'sp1', startMs: 10_000, start: 0, end: 4, preview: 'Line…' },
    ],
  });
});

function renderPage() {
  return render(<TranscriptPage />, { wrapperOptions: { user: mockAdminUser } });
}

describe('TranscriptPage — a viewer sees no editing controls', () => {
  beforeEach(() => {
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail('viewer'),
      etag: 'W/"v4"',
    });
  });

  it('mounts no per-segment action button and no editable text', async () => {
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    expect(screen.queryByRole('button', { name: /^Actions for the line/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit the line/ })).toBeNull();
  });

  it('mounts no merge affordances in the speakers panel', async () => {
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    expect(screen.queryByRole('button', { name: /Merge speakers/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /to merge/ })).toBeNull();
    // The read-only filter is untouched — this is still the reader #30 shipped.
    expect(screen.getByRole('button', { name: 'Play only Ana' })).toBeInTheDocument();
  });

  it('shows no save indicator, because a viewer has nothing to save', async () => {
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    expect(screen.queryByText('All changes saved')).toBeNull();
  });

  it('offers Find but not Replace', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Find and replace' }));

    expect(await screen.findByLabelText('Find')).toBeInTheDocument();
    expect(screen.queryByLabelText('Replace with')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace all' })).toBeNull();
  });

  it('passes axe', async () => {
    const { container } = renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('TranscriptPage — editing a segment', () => {
  it('turns the line into a field on click and sends one update_text', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Edit the line at 0:00' }));
    const field = await screen.findByLabelText('Edit the line at 0:00');
    await user.type(field, '!');

    // The page uses the production 1.5 s debounce — a burst of typing is one
    // version, and this is what that costs a test.
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1), { timeout: 4_000 });
    expect(mockApply.mock.calls[0][1].ops).toEqual([
      { op: 'segment.update_text', segmentId: 's0', rev: 1, text: 'Line number 0!' },
    ]);
  });

  it('is reachable by keyboard alone: Enter opens the field, Esc puts it back', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    const line = screen.getByRole('button', { name: 'Edit the line at 0:00' });
    line.focus();
    await user.keyboard('{Enter}');

    const field = await screen.findByLabelText('Edit the line at 0:00');
    await user.type(field, 'XYZ');
    await user.keyboard('{Escape}');

    // Esc is a REVERT, not a discard: the change was already applied
    // optimistically, so the text goes back rather than the edit vanishing.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit the line at 0:00' })).toHaveTextContent(
        'Line number 0',
      ),
    );
  });

  it('marks an edited segment, for provenance', async () => {
    mockGetSegments.mockResolvedValue({
      status: 'ok',
      data: {
        currentVersion: 4,
        segments: SEGMENTS.map((segment) =>
          segment.id === 's1' ? { ...segment, origin: 'user' as const } : segment,
        ),
      },
      etag: 'W/"v4"',
    });
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    expect(screen.getAllByText('edited')).toHaveLength(1);
  });

  it('offers the five segment actions from the overflow menu', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Actions for the line at 0:00' }));

    for (const label of [
      'Change speaker',
      'Split here',
      'Join with next',
      'Play from here',
      'Delete segment',
    ]) {
      expect(await screen.findByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  });

  it('joins with the next segment, sending both ids and both revs', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Actions for the line at 0:00' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Join with next' }));

    await waitFor(() => expect(mockApply).toHaveBeenCalled());
    expect(mockApply.mock.calls[0][1].ops).toEqual([
      { op: 'segment.join', segmentIds: ['s0', 's1'], revs: [1, 1] },
    ]);
  });

  it('changes the speaker from the menu’s second view', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Actions for the line at 0:00' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Change speaker' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Speaker 3' }));

    await waitFor(() => expect(mockApply).toHaveBeenCalled());
    expect(mockApply.mock.calls[0][1].ops).toEqual([
      { op: 'segment.set_speaker', segmentId: 's0', rev: 1, speakerId: 'sp2' },
    ]);
  });

  it('splits at the offset the dialog chose, as atCharOffset', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Actions for the line at 0:00' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Split here' }));
    await user.click(await screen.findByRole('button', { name: 'Split' }));

    await waitFor(() => expect(mockApply).toHaveBeenCalled());
    const op = mockApply.mock.calls[0][1].ops[0] as Record<string, unknown>;
    expect(op.op).toBe('segment.split');
    expect(op.segmentId).toBe('s0');
    expect(typeof op.atCharOffset).toBe('number');
    expect(op.atWordIndex).toBeUndefined();
  });

  it('passes axe with the editor mounted', async () => {
    const { container } = renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('passes axe with the segment actions open', async () => {
    // The open sheet is where the list nesting goes wrong if these menus are
    // ever put back inside a MUI `Menu`, which renders its own `<ul>`.
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Actions for the line at 0:00' }));
    await screen.findByRole('menuitem', { name: 'Change speaker' });

    expect(await axe(document.body, AXE_PORTAL_OPTIONS)).toHaveNoViolations();
  });

  it('passes axe with the speaker actions open', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Actions for Speaker 3' }));
    await screen.findByRole('menuitem', { name: 'Rename' });

    expect(await axe(document.body, AXE_PORTAL_OPTIONS)).toHaveNoViolations();
  });
});

describe('TranscriptPage — merging speakers', () => {
  it('takes at most three taps on a phone, and the third one commits', async () => {
    const user = userEvent.setup();
    mockApply.mockResolvedValue(
      opsResult({
        summary: 'Merged Speaker 3 into Ana',
        merges: [
          {
            targetId: 'sp1',
            sources: [
              {
                speakerId: 'sp2',
                label: 'B',
                displayName: 'Speaker 3',
                colorIndex: 1,
                segmentIds: ['s1'],
              },
            ],
          },
        ],
      }),
    );
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });
    await act(async () => setViewportWidth(390));

    // 1 — the chip.
    await user.click(await screen.findByRole('button', { name: 'Actions for Speaker 3' }));
    // 2 — "Merge into…".
    await user.click(await screen.findByRole('menuitem', { name: 'Merge into…' }));
    // 3 — the target. There is deliberately no fourth "Are you sure?": the Undo
    // snackbar below is the confirmation, and it is shown after the user can
    // see what happened.
    await user.click(
      await screen.findByRole('menuitem', { name: 'Merge Speaker 3 into Ana' }),
    );

    await waitFor(() => expect(mockApply).toHaveBeenCalled());
    expect(mockApply.mock.calls[0][1].ops).toEqual([
      { op: 'speaker.merge', sourceIds: ['sp2'], targetId: 'sp1', keepName: true },
    ]);
    expect(await screen.findByText('Merged Speaker 3 into Ana')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('offers the dialog on desktop once two speakers are ticked', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    const merge = screen.getByRole('button', { name: 'Merge speakers' });
    expect(merge).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Select Ana to merge' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Speaker 3 to merge' }));
    await user.click(screen.getByRole('button', { name: 'Merge 2 speakers' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Which name should it keep?')).toBeInTheDocument();
  });

  it('renames a speaker inline from the panel’s action menu', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Actions for Speaker 3' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = await screen.findByRole('combobox', { name: 'Speaker name' });
    await user.clear(field);
    await user.type(field, 'Ben Olsen');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApply).toHaveBeenCalled());
    expect(mockApply.mock.calls[0][1].ops).toEqual([
      { op: 'speaker.rename', speakerId: 'sp2', rev: 1, displayName: 'Ben Olsen' },
    ]);
  });
});

describe('TranscriptPage — find & replace', () => {
  it('opens on Cmd/Ctrl+F, even from inside a field', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.keyboard('{Control>}f{/Control}');

    expect(await screen.findByLabelText('Find')).toBeInTheDocument();
  });

  it('reports the match count and highlights every hit', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Find and replace' }));
    await user.type(await screen.findByLabelText('Find'), 'Line');

    expect(await screen.findByText('1 of 2')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByTestId('search-match').length).toBeGreaterThan(0),
    );
  });

  it('walks the matches with Next and wraps around', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Find and replace' }));
    await user.type(await screen.findByLabelText('Find'), 'Line');
    await screen.findByText('1 of 2');

    await user.click(screen.getByRole('button', { name: 'Next match' }));
    expect(await screen.findByText('2 of 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next match' }));
    expect(await screen.findByText('1 of 2')).toBeInTheDocument();
  });

  it('sends ONE transcript.find_replace for Replace all', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Find and replace' }));
    await user.type(await screen.findByLabelText('Find'), 'Line');
    await user.type(screen.getByLabelText('Replace with'), 'Row');
    await screen.findByText('1 of 2');
    await user.click(screen.getByRole('button', { name: 'Replace all' }));

    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply.mock.calls[0][1].ops).toEqual([
      {
        op: 'transcript.find_replace',
        find: 'Line',
        replace: 'Row',
        matchCase: false,
        wholeWord: false,
      },
    ]);
  });

  it('replaces only the current match with Replace', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Find and replace' }));
    await user.type(await screen.findByLabelText('Find'), 'Line');
    await user.type(screen.getByLabelText('Replace with'), 'Row');
    await screen.findByText('1 of 2');
    await user.click(screen.getByRole('button', { name: 'Replace' }));

    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply.mock.calls[0][1].ops).toEqual([
      { op: 'segment.update_text', segmentId: 's0', rev: 1, text: 'Row number 0' },
    ]);
  });
});

describe('TranscriptPage — leaving and deleting', () => {
  it('offers Delete to an owner and asks first', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Transcript actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete transcript' }));

    expect(await screen.findByText('Delete this transcript?')).toBeInTheDocument();
  });

  it('offers Leave — not Delete — to a recipient, and warns it cannot be undone', async () => {
    const user = userEvent.setup();
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail('editor'),
      etag: 'W/"v4"',
    });
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Transcript actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete transcript' })).toBeNull();
    await user.click(await screen.findByRole('menuitem', { name: 'Leave this transcript' }));

    expect(await screen.findByText(/Only the owner can share it with you again/)).toBeInTheDocument();
  });
});

describe('TranscriptPage — what the user is told about saving', () => {
  it('renders a 403 rather than swallowing it, for an editor without transcripts:write', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../services/api');
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail('editor'),
      etag: 'W/"v4"',
    });
    mockApply.mockRejectedValue(new ApiError('Forbidden', 403));
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Edit the line at 0:00' }));
    await user.type(await screen.findByLabelText('Edit the line at 0:00'), '!');

    expect(
      await screen.findByText(/You can read this transcript but not change it/, undefined, {
        timeout: 4_000,
      }),
    ).toBeInTheDocument();
  });

  it('offers the conflict card with both choices when somebody else saved first', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../services/api');
    mockApply.mockRejectedValue(
      new ApiError('Conflict', 409, 'CONFLICT', {
        currentVersion: 5,
        conflicts: [{ entity: 'segment', id: 's0', current: 2 }],
      }),
    );
    mockGetSegments.mockResolvedValue({
      status: 'ok',
      data: {
        currentVersion: 5,
        segments: SEGMENTS.map((segment) =>
          segment.id === 's0' ? { ...segment, rev: 2, text: 'Their line' } : segment,
        ),
      },
      etag: 'W/"v5"',
    });
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Edit the line at 0:00' }));
    await user.type(await screen.findByLabelText('Edit the line at 0:00'), '!');

    expect(
      await screen.findByText('Someone changed this segment', undefined, { timeout: 4_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use theirs' })).toBeInTheDocument();
    expect(screen.getByText('Their line')).toBeInTheDocument();
  });
});

describe('TranscriptPage — the Export and Share menu items', () => {
  // Issues #28 and #29 shipped these two dialogs standalone, deliberately
  // unwired, because this page belonged to another change at the time. These
  // are the tests for the wiring itself: that each item is offered to exactly
  // the roles the API will actually serve.

  it('offers Export to a viewer, because a viewer share is a read-play-EXPORT grant', async () => {
    const user = userEvent.setup();
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail('viewer'),
      etag: 'W/"v4"',
    });
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Transcript actions' }));

    expect(await screen.findByRole('menuitem', { name: 'Export…' })).toBeInTheDocument();
  });

  it('withholds Share from a viewer, because the share routes answer them a 404', async () => {
    const user = userEvent.setup();
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail('viewer'),
      etag: 'W/"v4"',
    });
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Transcript actions' }));
    await screen.findByRole('menuitem', { name: 'Export…' });

    expect(screen.queryByRole('menuitem', { name: 'Share…' })).toBeNull();
  });

  it('offers Share to the owner and opens the dialog on it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Transcript actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Share…' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('opens the export dialog from the menu', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Transcript actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Export…' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
