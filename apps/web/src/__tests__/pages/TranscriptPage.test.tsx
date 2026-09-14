import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
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
}));

vi.mock('../../contexts/NotificationContext', () => ({ useNotifications: () => null }));

import { render, mockAdminUser } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import TranscriptPage, { isTypingTarget } from '../../pages/TranscriptPage';
import {
  getTranscript,
  getTranscriptAudio,
  getTranscriptSegments,
  getTranscriptWords,
  retryTranscript,
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
    expect(screen.getByRole('region', { name: 'Transcript' })).toBeInTheDocument();
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

  it('offers the four playback speeds', async () => {
    renderPage();

    for (const rate of ['1 times speed', '1.25 times speed', '1.5 times speed', '2 times speed']) {
      expect(await screen.findByRole('button', { name: rate })).toBeInTheDocument();
    }
  });

  it('offers ±15s, named by what they do', async () => {
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Skip back 15 seconds' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Skip forward 15 seconds' }),
    ).toBeInTheDocument();
  });

  it('renders the reading pane at phone width too', async () => {
    renderPage();
    await screen.findByText('Weekly standup');

    await act(async () => setViewportWidth(390));

    expect(screen.getByRole('region', { name: 'Transcript' })).toBeInTheDocument();
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
    expect(screen.getByRole('region', { name: 'Transcript' })).toBeInTheDocument();
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

  it('binds J and L to the ±15s skip', async () => {
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
