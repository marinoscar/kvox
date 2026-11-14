import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { http, HttpResponse, server } from './msw-compat.js';
import { Route, Routes } from 'react-router-dom';
import { TranscriptPage } from '../../src/transcripts/ui/index.js';
import type {
  TranscriptDetail,
  TranscriptSegment,
  TranscriptSpeaker,
} from '../../src/transcripts/headless/index.js';

vi.mock('../../src/transcripts/headless/clients/transcripts.js', () => ({
  getTranscript: vi.fn(),
  getTranscriptSegments: vi.fn(),
  getTranscriptAudio: vi.fn(),
  getTranscriptWords: vi.fn(),
  retryTranscript: vi.fn(),
  updateTranscript: vi.fn(),
}));

import './helpers.js';
import { render, mockAdminUser } from '../notes/helpers.js';
import type { MockUser } from '../notes/helpers.js';
import { testAi, testSharing } from '../transcripts/helpers.js';
import {
  getTranscript,
  getTranscriptAudio,
  getTranscriptSegments,
  getTranscriptWords,
} from '../../src/transcripts/headless/clients/transcripts.js';
import { setViewportWidth } from '../../src/core/testing/index.js';
import { graphTranscriptPageSlots } from '../../src/graph/ui/slots/GraphTranscriptSlots.js';

/**
 * Voice-based name suggestions on the transcript page (#827), through the real
 * graph slot (`useGraphSpeakerSuggestions`) and MSW: shown for a placeholder
 * speaker, accepted (then the transcript is read again) or dismissed, and
 * gated on `graph:read` (shown) and `graph:write` + `transcripts:write` (acted on).
 */

const mockGetTranscript = vi.mocked(getTranscript);
const mockGetSegments = vi.mocked(getTranscriptSegments);
const mockGetAudio = vi.mocked(getTranscriptAudio);
const mockGetWords = vi.mocked(getTranscriptWords);

const PLACEHOLDER_SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Speaker A', colorIndex: 0, rev: 1 },
  { id: 'sp2', label: 'B', displayName: 'Person B', colorIndex: 1, rev: 1 },
];

function detail(speakers: TranscriptSpeaker[]): TranscriptDetail {
  return {
    id: 't1',
    title: 'Weekly standup',
    status: 'ready',
    transcriptionStatus: 'completed',
    playbackStatus: 'ready',
    language: 'en',
    durationMs: 600_000,
    speakerCount: speakers.length,
    wordCount: 1200,
    currentVersion: 1,
    failureReason: null,
    access: 'owner',
    ownerName: 'Admin User',
    hasAudio: true,
    recordedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    speakers,
    provider: 'AssemblyAI',
    remoteDeletedAt: null,
    submittedAt: null,
    completedAt: null,
    sourceName: 'standup.m4a',
    sourceMimeType: 'audio/mp4',
    sourceSizeBytes: '1048576',
  };
}

const SEGMENTS: TranscriptSegment[] = Array.from({ length: 6 }, (_, index) => ({
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

const SUGGESTION = {
  id: '11111111-1111-4111-8111-111111111111',
  speakerId: 'sp1',
  entityId: '22222222-2222-4222-8222-222222222222',
  entityName: 'Person A',
  score: 0.871,
  margin: 0.12,
  createdAt: '2026-01-02T00:00:00.000Z',
};

const deciderUser: MockUser = {
  ...mockAdminUser,
  permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'],
};
const readerUser: MockUser = {
  ...mockAdminUser,
  permissions: [...mockAdminUser.permissions, 'graph:read'],
};

let listCalls: number;
let decisions: string[];

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, writable: true, value: vi.fn() });
  for (const method of ['play', 'pause', 'load'] as const) {
    Object.defineProperty(HTMLMediaElement.prototype, method, {
      configurable: true,
      writable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
  }
});

afterAll(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('theme_mode', 'light');
  setViewportWidth(1440);
  mockGetTranscript.mockResolvedValue({ status: 'ok', data: detail(PLACEHOLDER_SPEAKERS), etag: 'W/"v1"' });
  mockGetSegments.mockResolvedValue({ status: 'ok', data: { currentVersion: 1, segments: SEGMENTS }, etag: 'W/"v1"' });
  mockGetAudio.mockResolvedValue({
    url: 'https://storage.example/signed',
    kind: 'playback',
    mimeType: 'audio/mp4',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  mockGetWords.mockResolvedValue({ currentVersion: 1, fromMs: 0, toMs: 300_000, segments: [] });

  listCalls = 0;
  decisions = [];
  server.use(
    http.get('*/api/graph/speaker-suggestions', ({ request }) => {
      listCalls += 1;
      expect(new URL(request.url).searchParams.get('transcriptId')).toBe('t1');
      return HttpResponse.json({ data: [SUGGESTION] });
    }),
    http.post('*/api/graph/speaker-suggestions/:id/accept', ({ params }) => {
      decisions.push(`accept:${String(params.id)}`);
      return HttpResponse.json({ data: { id: params.id, status: 'accepted', decidedAt: '2026-01-03T00:00:00.000Z' } });
    }),
    http.post('*/api/graph/speaker-suggestions/:id/dismiss', ({ params }) => {
      decisions.push(`dismiss:${String(params.id)}`);
      return HttpResponse.json({ data: { id: params.id, status: 'dismissed', decidedAt: '2026-01-03T00:00:00.000Z' } });
    }),
  );
});

function renderPage(user: MockUser = deciderUser, graphEnabled = true) {
  return render(
    <Routes>
      <Route
        path="/transcripts/:id"
        element={<TranscriptPage slots={graphTranscriptPageSlots} sharing={testSharing} ai={testAi} />}
      />
    </Routes>,
    { wrapperOptions: { user, route: '/transcripts/t1' }, hostOptions: { features: { graphEnabled } } },
  );
}

async function findSuggestions() {
  return screen.findByRole('region', { name: 'Voice match suggestions' });
}

describe('TranscriptPage — voice match suggestions (#827)', () => {
  it('suggests a name for a placeholder speaker with the rounded score', async () => {
    renderPage();
    const section = await findSuggestions();
    expect(section).toHaveTextContent('Voice match');
    expect(section).toHaveTextContent('Speaker A sounds like Person A · 87%');
    expect(within(section).getByRole('button', { name: 'Accept: Speaker A is Person A' })).toBeEnabled();
  });

  it('works at phone width, under the speaker chips', async () => {
    setViewportWidth(375);
    renderPage();
    const section = await findSuggestions();
    expect(section).toHaveTextContent('Speaker A sounds like Person A · 87%');
  });

  it('accepts: sends the decision, removes the row and reads the transcript again', async () => {
    const user = userEvent.setup();
    renderPage();
    const section = await findSuggestions();
    const readsBefore = mockGetTranscript.mock.calls.length;
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail([{ ...PLACEHOLDER_SPEAKERS[0]!, displayName: 'Person A', rev: 2 }, PLACEHOLDER_SPEAKERS[1]!]),
      etag: 'W/"v2"',
    });

    await user.click(within(section).getByRole('button', { name: 'Accept: Speaker A is Person A' }));

    await waitFor(() => expect(decisions).toEqual([`accept:${SUGGESTION.id}`]));
    await waitFor(() => expect(mockGetTranscript.mock.calls.length).toBeGreaterThan(readsBefore));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Voice match suggestions' })).not.toBeInTheDocument(),
    );
  });

  it('dismisses: sends the decision and removes the row', async () => {
    const user = userEvent.setup();
    renderPage();
    const section = await findSuggestions();
    await user.click(within(section).getByRole('button', { name: 'Dismiss: Speaker A is not Person A' }));
    await waitFor(() => expect(decisions).toEqual([`dismiss:${SUGGESTION.id}`]));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Voice match suggestions' })).not.toBeInTheDocument(),
    );
  });

  it('puts the row back and says why when a dismiss fails', async () => {
    server.use(
      http.post('*/api/graph/speaker-suggestions/:id/dismiss', () =>
        HttpResponse.json({ message: 'Something went wrong' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    const section = await findSuggestions();
    await user.click(within(section).getByRole('button', { name: 'Dismiss: Speaker A is not Person A' }));
    const again = await findSuggestions();
    expect(await within(again).findByRole('alert')).toBeInTheDocument();
    expect(again).toHaveTextContent('Speaker A sounds like Person A');
  });

  it('shows the suggestion with its actions disabled without graph:write', async () => {
    renderPage(readerUser);
    const section = await findSuggestions();
    expect(within(section).getByRole('button', { name: 'Accept: Speaker A is Person A' })).toBeDisabled();
    expect(within(section).getByRole('button', { name: 'Dismiss: Speaker A is not Person A' })).toBeDisabled();
  });

  it('asks for nothing and shows nothing without graph:read', async () => {
    renderPage(mockAdminUser);
    await screen.findByText('Weekly standup');
    await screen.findAllByText('Line number 0');
    expect(screen.queryByRole('region', { name: 'Voice match suggestions' })).not.toBeInTheDocument();
    expect(listCalls).toBe(0);
  });

  it('asks for nothing while connected knowledge is off', async () => {
    renderPage(deciderUser, false);
    await screen.findAllByText('Line number 0');
    expect(listCalls).toBe(0);
  });

  it('asks for nothing when every speaker already has a name', async () => {
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail([
        { ...PLACEHOLDER_SPEAKERS[0]!, displayName: 'Person A' },
        PLACEHOLDER_SPEAKERS[1]!,
      ]),
      etag: 'W/"v1"',
    });
    renderPage();
    await screen.findAllByText('Line number 0');
    expect(screen.queryByRole('region', { name: 'Voice match suggestions' })).not.toBeInTheDocument();
    expect(listCalls).toBe(0);
  });
});
