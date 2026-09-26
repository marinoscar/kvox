import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
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
  updateTranscript: vi.fn(),
}));

vi.mock('../../contexts/NotificationContext', () => ({ useNotifications: () => null }));

import { render, mockAdminUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import {
  PROPOSAL_ID,
  mockGraphAiConfig,
  mockProposalDetail,
  proposalMock,
  proposalSummaryRow,
} from '../mocks/graphData';
import { invalidateGraphOntology } from '../../hooks/useGraphOntology';
import { setViewportWidth } from '../setup';
import TranscriptPage, { formatRecordedAt, isTypingTarget } from '../../pages/TranscriptPage';
import {
  getTranscript,
  getTranscriptAudio,
  getTranscriptSegments,
  getTranscriptWords,
  retryTranscript,
  updateTranscript,
} from '../../services/transcripts';
import type {
  TranscriptDetail,
  TranscriptSegment,
  TranscriptSpeaker,
} from '../../services/transcripts';

/**
 * The viewer, over the real hooks and the real engine, with the SERVICE layer
 * mocked. The alternative — mocking the hooks — would leave the thing this page
 * is mostly made of (wiring three hooks and an engine into two responsive
 * layouts) asserted by nothing.
 *
 * jsdom has no media element worth the name and no layout, so the two stubs
 * below stand in: `HTMLMediaElement.prototype.play`, which jsdom leaves
 * unimplemented and which throws "not implemented" on every call, and
 * `offsetHeight`, which the virtualizer reads to decide how many rows exist.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const mockGetTranscript = vi.mocked(getTranscript);
const mockGetSegments = vi.mocked(getTranscriptSegments);
const mockGetAudio = vi.mocked(getTranscriptAudio);
const mockGetWords = vi.mocked(getTranscriptWords);
const mockRetry = vi.mocked(retryTranscript);
const mockUpdate = vi.mocked(updateTranscript);

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Ana', colorIndex: 0, rev: 1 },
  { id: 'sp2', label: 'B', displayName: 'Ben', colorIndex: 1, rev: 1 },
];

function detail(overrides: Partial<TranscriptDetail> = {}): TranscriptDetail {
  return {
    id: 't1',
    title: 'Weekly standup',
    status: 'ready',
    transcriptionStatus: 'completed',
    playbackStatus: 'ready',
    language: 'en',
    durationMs: 600_000,
    speakerCount: 2,
    wordCount: 1200,
    currentVersion: 1,
    failureReason: null,
    access: 'owner',
    recordedAt: '2026-01-01T00:00:00.000Z',
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
    ...overrides,
  };
}

const SEGMENTS: TranscriptSegment[] = Array.from({ length: 12 }, (_, index) => ({
  id: `s${index}`,
  speakerId: index % 2 === 0 ? 'sp1' : 'sp2',
  startMs: index * 5000,
  endMs: index * 5000 + 4000,
  ordinal: index + 1,
  text: `Line number ${index}`,
  wordsAlignment: 'exact' as const,
  confidence: 0.9,
  origin: 'ai' as const,
  rev: 1,
  editedAt: null,
}));

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
  // jsdom does not implement media playback; the un-stubbed method throws
  // "Not implemented" and would fail every test that presses Play.
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'load', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTranscript.mockResolvedValue({ status: 'ok', data: detail(), etag: 'W/"v1"' });
  mockGetSegments.mockResolvedValue({
    status: 'ok',
    data: { currentVersion: 1, segments: SEGMENTS },
    etag: 'W/"v1"',
  });
  mockGetAudio.mockResolvedValue({
    url: 'https://storage.example/signed',
    kind: 'playback',
    mimeType: 'audio/mp4',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  mockGetWords.mockResolvedValue({
    currentVersion: 1,
    fromMs: 0,
    toMs: 300_000,
    segments: [],
  });
});

function renderPage() {
  return render(<TranscriptPage />, { wrapperOptions: { user: mockAdminUser } });
}

describe('TranscriptPage — while it is still processing', () => {
  it('shows the four-step pipeline instead of an empty transcript', async () => {
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ status: 'processing', transcriptionStatus: 'processing' }),
      etag: 'W/"v1"',
    });
    renderPage();

    expect(await screen.findByText('Uploaded')).toBeInTheDocument();
    expect(screen.getByText('Preparing audio')).toBeInTheDocument();
    expect(screen.getByText('Transcribing')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('does not ask for segments a processing transcript does not have', async () => {
    // A guaranteed-empty response per poll, every five seconds, for the whole
    // wait.
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ status: 'processing' }),
      etag: 'W/"v1"',
    });
    renderPage();

    await screen.findByText('Uploaded');
    expect(mockGetSegments).not.toHaveBeenCalled();
  });

  it('mounts no media element before the transcript is ready', async () => {
    // `GET /:id/audio` has nothing to sign yet, and a 404 would put the player
    // into its error state for the entire processing wait.
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ status: 'processing' }),
      etag: 'W/"v1"',
    });
    renderPage();

    await screen.findByText('Uploaded');
    expect(mockGetAudio).not.toHaveBeenCalled();
  });

  it('announces progress through a live region, since it changes untouched', async () => {
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ status: 'processing', transcriptionStatus: 'processing' }),
      etag: 'W/"v1"',
    });
    renderPage();

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/Transcribing/);
  });
});

describe('TranscriptPage — the failed state', () => {
  it('shows the provider’s own reason, verbatim', async () => {
    // "The audio contained no speech" and "the credential was rejected" need
    // completely different things from the person reading it.
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({
        status: 'failed',
        transcriptionStatus: 'failed',
        failureReason: 'The provider rejected the audio format',
      }),
      etag: 'W/"v1"',
    });
    renderPage();

    expect(
      await screen.findByText('The provider rejected the audio format'),
    ).toBeInTheDocument();
  });

  it('offers Retry to the owner and calls the endpoint', async () => {
    const user = userEvent.setup();
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ status: 'failed', access: 'owner' }),
      etag: 'W/"v1"',
    });
    mockRetry.mockResolvedValue(detail({ status: 'processing' }));
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Retry' }));

    expect(mockRetry).toHaveBeenCalledWith('t1');
  });

  it('offers NO Retry to an editor — the API answers one with a 404', async () => {
    // A control that cannot work is worse than no control.
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ status: 'failed', access: 'editor' }),
      etag: 'W/"v1"',
    });
    renderPage();

    await screen.findByText(/could not be transcribed/i);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('says so plainly when the transcript was cancelled rather than broken', async () => {
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({
        status: 'failed',
        transcriptionStatus: 'cancelled',
        failureReason: null,
      }),
      etag: 'W/"v1"',
    });
    renderPage();

    expect(await screen.findByText(/Cancelled before it finished/)).toBeInTheDocument();
  });
});

describe('TranscriptPage — read mode', () => {
  it('renders the transcript, its speakers and the player', async () => {
    renderPage();

    expect(await screen.findByText('Weekly standup')).toBeInTheDocument();
    // The title comes from `GET /:id` (transcript detail); this region comes
    // from `SegmentList`, which only renders it once `GET /:id/segments`
    // resolves. The two requests race independently, so the title's own
    // resolution is not evidence the segments have arrived — this must be
    // awaited on its own rather than queried synchronously right after.
    expect(await screen.findByRole('region', { name: 'Transcript' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.getByLabelText('Playback position')).toBeInTheDocument();
  });

  it('offers "Play only this speaker" as the speaker control’s accessible name', async () => {
    // The chip's visible label ("Ana · 6 · 24 sec") is a fine summary and says
    // nothing about what activating it does.
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Play only Ana' }),
    ).toBeInTheDocument();
  });

  it('shows a clearable "Only:" chip once a speaker is selected', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Play only Ana' }));

    expect(await screen.findByText('Only: Ana')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear speaker filter' }));
    expect(screen.queryByText('Only: Ana')).not.toBeInTheDocument();
  });

  it('flips the speaker control’s name once it is active', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Play only Ana' }));

    expect(
      await screen.findByRole('button', { name: 'Stop playing only Ana' }),
    ).toBeInTheDocument();
  });

  it('offers the four playback speeds as buttons in the CARD transport', async () => {
    // The desktop docking, where the width for a four-button group exists.
    // The phone's own reachability is asserted separately below (#112) — this
    // assertion is about the `card` variant specifically, so it must not be
    // rewritten into something both variants happen to satisfy.
    renderPage();

    for (const rate of ['1 times speed', '1.25 times speed', '1.5 times speed', '2 times speed']) {
      expect(await screen.findByRole('button', { name: rate })).toBeInTheDocument();
    }
    expect(
      screen.queryByRole('button', { name: /^Playback speed, / }),
    ).not.toBeInTheDocument();
  });

  it('reaches all four speeds from the MINI transport’s one chip (#112)', async () => {
    // At 360px the four-button group is about a third of the transport. The
    // phone gets a single cycling chip instead — so the thing that has to be
    // proved is that cycling still REACHES every rate the group offered, and
    // wraps back to 1×.
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Weekly standup');
    await act(async () => setViewportWidth(390));

    const speedChip = () => screen.getByRole('button', { name: /^Playback speed, / });

    expect(speedChip()).toHaveAccessibleName('Playback speed, 1 times. Press to change.');
    // The four-button group is gone, which is the point of the change.
    expect(screen.queryByRole('button', { name: '1.5 times speed' })).not.toBeInTheDocument();

    for (const rate of ['1.25', '1.5', '2', '1']) {
      await user.click(speedChip());
      expect(speedChip()).toHaveAccessibleName(
        `Playback speed, ${rate} times. Press to change.`,
      );
    }
  });

  it('offers ±10s, named by what they do — and by what the icons draw', async () => {
    // MUI ships no Replay15/Forward15, so these buttons always DREW "10" while
    // their accessible names said "15 seconds" (#108): a sighted user and a
    // screen-reader user were told different things about the same control.
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Skip back 10 seconds' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Skip forward 10 seconds' }),
    ).toBeInTheDocument();
  });

  it('renders the reading pane at phone width too', async () => {
    renderPage();
    await screen.findByText('Weekly standup');

    await act(async () => setViewportWidth(390));

    // Same independent-request race as above: the segments region is not
    // implied by the title having resolved.
    expect(await screen.findByRole('region', { name: 'Transcript' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });
});

describe('TranscriptPage — "Preparing audio…"', () => {
  it('keeps the transcript readable while the rendition is still being made', async () => {
    // The transcript is `ready` — the TEXT is finished — while the transcode is
    // not. Blocking the reader on the audio would withhold the thing they came
    // for.
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ playbackStatus: 'processing' }),
      etag: 'W/"v1"',
    });
    mockGetAudio.mockResolvedValue({
      url: 'https://storage.example/original',
      kind: 'original',
      mimeType: 'audio/amr',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    // `canPlayType` answering '' is the browser saying "definitely not".
    const canPlayType = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockReturnValue('');

    renderPage();

    expect(await screen.findByText(/Preparing audio/)).toBeInTheDocument();
    // "Preparing audio" resolves off `GET /:id/audio` (plus the `canPlayType`
    // stub above); the segments region resolves off the independent
    // `GET /:id/segments` — awaiting one is not evidence for the other.
    expect(await screen.findByRole('region', { name: 'Transcript' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
    canPlayType.mockRestore();
  });
});

describe('TranscriptPage — keyboard shortcuts', () => {
  it('ignores a shortcut while the user is typing', () => {
    // Space in a rename field must insert a space, not pause the audio. The
    // shortcuts are bound at the DOCUMENT level, which is the only way they can
    // work while focus is in the segment list — and is exactly why this guard
    // has to exist.
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    Object.defineProperty(editable, 'isContentEditable', { value: true });

    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('toggles playback on Space and prevents the page from scrolling', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Play' });

    const event = new KeyboardEvent('keydown', {
      code: 'Space',
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    // A transcript that jumps a screenful every time playback starts is worse
    // than no shortcut at all.
    expect(event.defaultPrevented).toBe(true);
  });

  it('binds J and L to the ±10s skip', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Play' });

    for (const key of ['j', 'l']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => {
        document.dispatchEvent(event);
      });
      expect(event.defaultPrevented, `${key} should be handled`).toBe(true);
    }
  });

  it('leaves a browser shortcut alone', async () => {
    // Ctrl/Cmd/Alt combinations belong to the browser and the OS.
    renderPage();
    await screen.findByRole('button', { name: 'Play' });

    const event = new KeyboardEvent('keydown', {
      key: 'l',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
  });

  it('does not fire a shortcut typed into a field', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Play' });

    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = new KeyboardEvent('keydown', {
      code: 'Space',
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      input.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    input.remove();
  });
});

describe('TranscriptPage — recording date (#352)', () => {
  it('shows when the recording was made in the metadata row', async () => {
    renderPage();

    await screen.findByText('Weekly standup');
    expect(
      screen.getByText(`Recorded ${formatRecordedAt('2026-01-01T00:00:00.000Z')}`),
    ).toBeInTheDocument();
  });

  it.each(['owner', 'editor'] as const)(
    'offers "Edit recording date" to an %s',
    async (access) => {
      const user = userEvent.setup();
      mockGetTranscript.mockResolvedValue({
        status: 'ok',
        data: detail({ access }),
        etag: 'W/"v1"',
      });
      renderPage();
      await screen.findByText('Weekly standup');

      await user.click(screen.getByRole('button', { name: 'Transcript actions' }));

      expect(
        await screen.findByRole('menuitem', { name: 'Edit recording date' }),
      ).toBeInTheDocument();
    },
  );

  it('does not offer "Edit recording date" to a viewer', async () => {
    const user = userEvent.setup();
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ access: 'viewer' }),
      etag: 'W/"v1"',
    });
    renderPage();
    await screen.findByText('Weekly standup');

    await user.click(screen.getByRole('button', { name: 'Transcript actions' }));

    expect(await screen.findByRole('menuitem', { name: 'Export…' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Edit recording date' })).toBeNull();
  });

  it('updates the caption from the saved detail, without a reload', async () => {
    const user = userEvent.setup();
    const next = '2025-11-05T14:30:00.000Z';
    mockUpdate.mockResolvedValue(detail({ recordedAt: next }));
    renderPage();
    await screen.findByText('Weekly standup');

    await user.click(screen.getByRole('button', { name: 'Transcript actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit recording date' }));
    await screen.findByRole('dialog', { name: 'Edit recording date' });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(`Recorded ${formatRecordedAt(next)}`)).toBeInTheDocument();
    expect(mockUpdate).toHaveBeenCalledWith('t1', {
      recordedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(mockGetTranscript).toHaveBeenCalledTimes(1);
  });
});

describe('TranscriptPage — failures', () => {
  it('shows a 404 as one message with a way back, not as a blank page', async () => {
    mockGetTranscript.mockRejectedValue(
      Object.assign(new Error('gone'), { name: 'ApiError', status: 404 }),
    );
    renderPage();

    expect(await screen.findByRole('button', { name: 'Back to transcripts' })).toBeInTheDocument();
  });
});

describe('TranscriptPage — accessibility', () => {
  it('has no axe violations in read mode', async () => {
    const { container } = renderPage();
    await screen.findByText('Weekly standup');
    await waitFor(() => expect(mockGetAudio).toHaveBeenCalled());

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations at phone width, where the mini player is fixed', async () => {
    const { container } = renderPage();
    await screen.findByText('Weekly standup');
    await act(async () => setViewportWidth(390));

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations on the pipeline state', async () => {
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ status: 'processing' }),
      etag: 'W/"v1"',
    });
    const { container } = renderPage();
    await screen.findByText('Uploaded');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations on the failed state', async () => {
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ status: 'failed', failureReason: 'Nope' }),
      etag: 'W/"v1"',
    });
    const { container } = renderPage();
    await screen.findByText('Nope');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('gives the page a single h1', async () => {
    renderPage();
    await screen.findByText('Weekly standup');

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('names the player region', async () => {
    renderPage();

    expect(await screen.findByRole('region', { name: 'Audio player' })).toBeInTheDocument();
  });
});

describe('TranscriptPage — word timings', () => {
  it('asks for the window around the playhead once the transcript is ready', async () => {
    renderPage();

    await waitFor(() => expect(mockGetWords).toHaveBeenCalledWith('t1', 0, 600_000));
  });

  it('asks for nothing while the transcript is still processing', async () => {
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ status: 'processing' }),
      etag: 'W/"v1"',
    });
    renderPage();

    await screen.findByText('Uploaded');
    expect(mockGetWords).not.toHaveBeenCalled();
  });
});

describe('TranscriptPage — the segment list', () => {
  it('plays one line when its own play button is activated', async () => {
    // The #108 wiring, end to end: the row's button reaches the engine, which
    // reaches the element. Asserted through the element rather than through a
    // mocked engine, because the engine is the part the page does not own.
    renderPage();
    await screen.findByText('Weekly standup');

    const play = await screen.findByRole('button', {
      name: 'Play this line, Ben at 0:05',
    });

    // The element is created by `new Audio()` and never attached to the
    // document, so there is nothing to query for it — the seek is observed on
    // the prototype's own setter instead. jsdom's `currentTime` is a plain
    // accessor pair, which is what makes this substitutable.
    const seeks: number[] = [];
    const original = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'currentTime',
    );
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: (value: number) => {
        seeks.push(value);
      },
    });
    try {
      fireEvent.click(play);
      await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    } finally {
      if (original) {
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', original);
      }
    }

    // Seeking happens BEFORE `play()`, so by the time playback was requested
    // the element was already parked on that segment's start (5000ms).
    expect(seeks).toContain(5);
  });

  it('plays from a segment when its timestamp is activated', async () => {
    renderPage();
    await screen.findByText('Weekly standup');

    const timestamp = await screen.findByRole('button', { name: 'Play from 0:05' });
    fireEvent.click(timestamp);

    // The engine owns the element; what this asserts is that the wiring
    // reaches it at all, which a `play` that never happened would not.
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
  });
});

// =============================================================================
// #368 — "Add to graph" from a selection within one line
// =============================================================================

describe('TranscriptPage — add to graph from a selection (issue #368)', () => {
  const graphUser = {
    ...mockAdminUser,
    permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'],
  };

  beforeEach(() => {
    invalidateGraphOntology();
    proposalMock.reset(mockProposalDetail('draft'));
    server.use(
      http.get('*/api/ai/config', () => HttpResponse.json({ data: mockGraphAiConfig() })),
      http.get('*/api/graph/proposals', () =>
        HttpResponse.json({ data: { items: [proposalSummaryRow(PROPOSAL_ID)], nextCursor: null } }),
      ),
    );
  });

  function selectInLine(text: string, from: number, to: number) {
    const line = screen.getByText(text);
    const node = line.firstChild!;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.pointerUp(document);
    return line;
  }

  it('adds the selected words of one line to the draft and opens the sheet here', async () => {
    render(<TranscriptPage />, { wrapperOptions: { user: graphUser } });
    await screen.findByText('Line number 3');
    const line = selectInLine('Line number 3', 5, 11);
    // A drag-select ends in a click on an editable line; it must not open the editor.
    fireEvent.click(line);
    expect(screen.getByRole('button', { name: 'Edit the line at 0:15' })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Add to graph' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to graph' });
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('number');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Add to draft' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to draft' }));

    expect(await screen.findByRole('region', { name: 'Graph proposal' })).toBeInTheDocument();
    const add = proposalMock.requests.find((request) => request.path.endsWith('/items'));
    expect(add?.body).toMatchObject({
      evidence: [{ source: 'segment', segmentId: 's3', segmentRev: 1, charStart: 5, charEnd: 11, quote: 'number' }],
    });
  });

  it('offers nothing while the graph is off', async () => {
    server.use(
      http.get('*/api/ai/config', () => HttpResponse.json({ data: mockGraphAiConfig({ graphEnabled: false }) })),
    );
    render(<TranscriptPage />, { wrapperOptions: { user: graphUser } });
    await screen.findByText('Line number 3');
    await new Promise((resolve) => setTimeout(resolve, 50));
    selectInLine('Line number 3', 5, 11);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: 'Add to graph' })).not.toBeInTheDocument();
  });
});
