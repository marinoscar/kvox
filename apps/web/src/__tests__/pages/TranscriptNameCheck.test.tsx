/**
 * "Fix names with AI" on the real transcript page (#329, #330): the rename
 * nudge, and accepting suggestions end to end — settle the outbox, apply,
 * adopt the returned segments, report what happened.
 *
 * Same shape as `TranscriptCorrections.test.tsx`: the transcript SERVICE is
 * mocked; the name-check and AI-config calls go through MSW so their request
 * bodies are what is asserted.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

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

import { server } from '../mocks/server';
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
  TranscriptDetail,
  TranscriptSegment,
  TranscriptSpeaker,
} from '../../services/transcripts';
import { applyOperations } from '../../services/transcriptEditing';
import type { OperationsResult } from '../../services/transcriptEditing';
import type { LatestNameCheck, NameSuggestion } from '../../services/transcriptNameChecks';

const API_BASE = '*/api';
const CHECK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mockGetTranscript = vi.mocked(getTranscript);
const mockGetSegments = vi.mocked(getTranscriptSegments);
const mockGetAudio = vi.mocked(getTranscriptAudio);
const mockGetWords = vi.mocked(getTranscriptWords);
const mockApply = vi.mocked(applyOperations);

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Speaker A', colorIndex: 0, rev: 1 },
  { id: 'sp2', label: 'B', displayName: 'Ana', colorIndex: 1, rev: 1 },
];

const SEGMENTS: TranscriptSegment[] = Array.from({ length: 4 }, (_, index) => ({
  id: `s${index}`,
  speakerId: index % 2 === 0 ? 'sp1' : 'sp2',
  startMs: index * 5000,
  endMs: index * 5000 + 4000,
  ordinal: (index + 1) * 1000,
  text: `Hi Skar number ${index}`,
  wordsAlignment: 'exact' as const,
  confidence: 0.9,
  origin: 'ai' as const,
  rev: 1,
  editedAt: null,
}));

function detail(): TranscriptDetail {
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
  };
}

function suggestion(index: number, overrides: Partial<NameSuggestion> = {}): NameSuggestion {
  return {
    id: `b1111111-0000-4000-8000-00000000000${index}`,
    segmentId: `s${index}`,
    speakerId: 'sp1',
    startMs: index * 5000,
    start: 3,
    end: 7,
    original: 'Skar',
    replacement: 'Oscar',
    confidence: 0.9,
    reason: null,
    source: 'phonetic',
    preview: `Hi Skar number ${index}`,
    stale: false,
    ...overrides,
  };
}

function latestReady(suggestions: NameSuggestion[]): LatestNameCheck {
  return {
    run: {
      id: CHECK_ID,
      transcriptId: 't1',
      mode: 'standard',
      status: 'ready',
      basedOnVersion: 4,
      terms: ['Oscar'],
      providerId: 'openai',
      model: 'gpt-test',
      candidateCount: suggestions.length,
      suggestionCount: suggestions.length,
      inputTokens: 100,
      outputTokens: 10,
      errorClass: null,
      error: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
    },
    suggestions,
    counts: { pending: suggestions.length, accepted: 0, rejected: 0, stale: 0 },
  };
}

function aiConfig(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    provider: 'openai',
    providerLabel: 'OpenAI',
    models: [],
    defaultModel: 'gpt-test',
    maxInputTokens: 100_000,
    maxOutputTokens: 4_000,
    keyConfigured: true,
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
  mockGetWords.mockResolvedValue({ currentVersion: 4, fromMs: 0, toMs: 300_000, segments: [] });
  server.use(
    http.get(`${API_BASE}/ai/config`, () => HttpResponse.json({ data: aiConfig() })),
  );
});

function renderPage() {
  return render(<TranscriptPage />, { wrapperOptions: { user: mockAdminUser } });
}

async function renameSpeakerTo(user: ReturnType<typeof userEvent.setup>, from: string, to: string) {
  await user.click(screen.getByRole('button', { name: `Actions for ${from}` }));
  await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  const field = await screen.findByRole('combobox', { name: 'Speaker name' });
  await user.clear(field);
  await user.type(field, to);
  await user.click(screen.getByRole('button', { name: 'Save' }));
}

describe('TranscriptPage — the post-rename name-check nudge', () => {
  it('offers to check for a real name once the rename has saved', async () => {
    mockApply.mockResolvedValue({
      version: 5,
      summary: 'Renamed a speaker',
      idempotentReplay: false,
      speakers: [{ ...SPEAKERS[0], displayName: 'Oscar', rev: 2 }, SPEAKERS[1]],
      segments: SEGMENTS,
      merges: [],
    } satisfies OperationsResult);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await renameSpeakerTo(user, 'Speaker A', 'Oscar');

    expect(
      await screen.findByText('Check the transcript for misheard "Oscar"?'),
    ).toBeInTheDocument();

    // "Check" opens the start dialog pre-selected to that speaker only.
    server.use(
      http.get(`${API_BASE}/transcripts/:id/name-checks/estimate`, () =>
        HttpResponse.json({ data: { inputTokens: 10, requests: 1, candidates: 1 } }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Check' }));
    const dialog = await screen.findByRole('dialog', { name: 'Fix names with AI' });
    expect(await within(dialog).findByRole('checkbox', { name: 'Oscar' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Ana' })).not.toBeChecked();
  });

  it('does not offer it for a generic label like "Speaker B"', async () => {
    mockApply.mockResolvedValue({
      version: 5,
      summary: 'Renamed a speaker',
      idempotentReplay: false,
      speakers: [SPEAKERS[0], { ...SPEAKERS[1], displayName: 'Speaker B', rev: 2 }],
      segments: SEGMENTS,
      merges: [],
    } satisfies OperationsResult);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await renameSpeakerTo(user, 'Ana', 'Speaker B');

    await waitFor(() => expect(mockApply).toHaveBeenCalled());
    // Give a (wrongly) mounted prompt the chance to read the AI config.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/Check the transcript for misheard/)).not.toBeInTheDocument();
  });

  it('does not offer it when the caller has no AI key', async () => {
    server.use(
      http.get(`${API_BASE}/ai/config`, () =>
        HttpResponse.json({ data: aiConfig({ keyConfigured: false }) }),
      ),
    );
    mockApply.mockResolvedValue({
      version: 5,
      summary: 'Renamed a speaker',
      idempotentReplay: false,
      speakers: [{ ...SPEAKERS[0], displayName: 'Oscar', rev: 2 }, SPEAKERS[1]],
      segments: SEGMENTS,
      merges: [],
    } satisfies OperationsResult);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await renameSpeakerTo(user, 'Speaker A', 'Oscar');

    await waitFor(() => expect(mockApply).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByText(/Check the transcript for misheard/)).not.toBeInTheDocument();
  });
});

describe('TranscriptPage — reviewing name suggestions', () => {
  it('accepts a group, adopts the new text, and reports what was applied', async () => {
    const suggestions = [suggestion(0), suggestion(2), suggestion(3, { stale: true })];
    let current = latestReady(suggestions);
    const applyBodies: unknown[] = [];
    server.use(
      http.get(`${API_BASE}/transcripts/:id/name-checks/latest`, () =>
        HttpResponse.json({ data: current }),
      ),
      http.post(`${API_BASE}/transcripts/:id/name-checks/:checkId/apply`, async ({ request, params }) => {
        expect(params.checkId).toBe(CHECK_ID);
        applyBodies.push(await request.json());
        current = latestReady([]);
        return HttpResponse.json({
          data: {
            applied: 2,
            stale: 1,
            version: 5,
            segments: SEGMENTS.map((segment) =>
              segment.id === 's0' || segment.id === 's2'
                ? { ...segment, text: segment.text.replace('Skar', 'Oscar'), rev: 2 }
                : segment,
            ),
            speakers: SPEAKERS,
          },
        });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });
    // The badge carries the pending count once `latest` has loaded — wait for
    // it, so the click opens the panel rather than the start dialog.
    await screen.findByText('3');

    await user.click(screen.getByRole('button', { name: 'Fix names with AI' }));
    const panel = await screen.findByRole('region', { name: 'Name suggestions' });
    expect(within(panel).getByRole('heading', { name: /Skar → Oscar ×3/ })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Accept all "Skar" → "Oscar"' }));

    expect(
      await screen.findByText('Applied 2 corrections — 1 skipped because the text changed'),
    ).toBeInTheDocument();
    expect(applyBodies).toEqual([{ suggestionIds: [suggestions[0].id, suggestions[1].id] }]);
    expect(await screen.findByText('Hi Oscar number 0')).toBeInTheDocument();
  });

  it('closes find & replace when the name panel opens', async () => {
    server.use(
      http.get(`${API_BASE}/transcripts/:id/name-checks/latest`, () =>
        HttpResponse.json({ data: latestReady([suggestion(0)]) }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: 'Transcript' });

    await user.click(screen.getByRole('button', { name: 'Find and replace' }));
    expect(await screen.findByLabelText('Find')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Fix names with AI' })).toBeInTheDocument(),
    );
    // Wait for the badge's data so the click opens the panel, not the dialog.
    await screen.findByText('1');
    await user.click(screen.getByRole('button', { name: 'Fix names with AI' }));

    expect(await screen.findByRole('region', { name: 'Name suggestions' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Find')).not.toBeInTheDocument();
  });
});
