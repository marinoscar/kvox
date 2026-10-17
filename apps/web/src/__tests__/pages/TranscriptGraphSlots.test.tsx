import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { TranscriptPage } from '@marinoscar/kvox-web/transcripts/ui';
import type {
  TranscriptDetail,
  TranscriptSegment,
  TranscriptSpeaker,
} from '@marinoscar/kvox-web/transcripts/headless';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { server } from '../mocks/server';
import { render, mockAdminUser } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import {
  PROPOSAL_ID,
  mockGraphAiConfig,
  mockProposalDetail,
  proposalMock,
  proposalSummaryRow,
} from '../mocks/graphData';
import { invalidateGraphOntology } from '../../hooks/useGraphOntology';
import { appTranscriptAiAccess } from '../../kvox/transcriptAiAccess';
import { appTranscriptSharing } from '../../kvox/transcriptSharing';
import { appTranscriptPageSlots } from '../../kvox/transcriptSlots';

/**
 * What this app puts on the transcript page through its slots: the speaker
 * person links (#373) and "Add to graph" from a selection (#368). Moved out of
 * the page's own suite by #500 (epic #498): the page (now
 * `@marinoscar/kvox-web/transcripts/ui`) imports nothing from the graph, so the
 * graph behaviour is asserted here, over the real slot wiring
 * (`kvox/transcriptSlots.tsx`) and MSW.
 */

const API_BASE = 'http://localhost:3000/api';

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Ana', colorIndex: 0, rev: 1 },
  { id: 'sp2', label: 'B', displayName: 'Ben', colorIndex: 1, rev: 1 },
];

const DETAIL: TranscriptDetail = {
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
  ownerName: 'Admin User',
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
};

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
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
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
  server.use(
    http.get(`${API_BASE}/transcripts/t1`, () =>
      HttpResponse.json({ data: DETAIL }, { headers: { ETag: 'W/"v1"' } }),
    ),
    http.get(`${API_BASE}/transcripts/t1/segments`, () =>
      HttpResponse.json(
        { data: { currentVersion: 1, segments: SEGMENTS } },
        { headers: { ETag: 'W/"v1"' } },
      ),
    ),
    http.get(`${API_BASE}/transcripts/t1/audio`, () =>
      HttpResponse.json({
        data: {
          url: 'https://storage.example/signed',
          kind: 'playback',
          mimeType: 'audio/mp4',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      }),
    ),
    http.get(`${API_BASE}/transcripts/t1/words`, () =>
      HttpResponse.json({ data: { currentVersion: 1, fromMs: 0, toMs: 300_000, segments: [] } }),
    ),
    http.get(`${API_BASE}/notes`, () => HttpResponse.json({ data: { items: [], nextCursor: null } })),
  );
});

function renderPage(user = mockAdminUser) {
  return render(
    <Routes>
      <Route
        path="/transcripts/:id"
        element={
          <TranscriptPage
            slots={appTranscriptPageSlots}
            sharing={appTranscriptSharing}
            ai={appTranscriptAiAccess}
          />
        }
      />
    </Routes>,
    { wrapperOptions: { user, route: '/transcripts/t1' } },
  );
}

describe('TranscriptPage — speaker person links (#373)', () => {
  const graphUser = {
    ...mockAdminUser,
    permissions: [...mockAdminUser.permissions, 'graph:read'],
  };

  it('links a named speaker to their Person page when the caller can read the graph', async () => {
    server.use(
      http.get('*/api/graph/entities', ({ request }) => {
        expect(new URL(request.url).searchParams.get('transcriptId')).toBe('t1');
        return HttpResponse.json({
          data: {
            items: [
              {
                id: 'person-ana',
                type: 'Person',
                label: 'Ana',
                aliases: [],
                mentionCount: 1,
                lastSeenAt: null,
                speakerIds: ['sp1'],
              },
            ],
            nextCursor: null,
          },
        });
      }),
    );
    renderPage(graphUser);

    const links = await screen.findAllByRole('button', { name: "Open Ana's page" });
    expect(screen.queryByRole('button', { name: "Open Ben's page" })).not.toBeInTheDocument();
    fireEvent.click(links[0]!);
    expect(mockNavigate).toHaveBeenCalledWith('/graph/entities/person-ana');
  });

  it('asks the graph nothing without graph:read', async () => {
    const seen = vi.fn();
    server.use(
      http.get('*/api/graph/entities', () => {
        seen();
        return HttpResponse.json({ data: { items: [], nextCursor: null } });
      }),
    );
    renderPage();
    await screen.findByText('Weekly standup');
    expect(screen.queryByRole('button', { name: /Open .*'s page/ })).not.toBeInTheDocument();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('TranscriptPage — add to graph from a selection (issue #368)', () => {
  const graphUser = {
    ...mockAdminUser,
    permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'],
  };

  beforeEach(() => {
    invalidateGraphOntology();
    proposalMock.reset(mockProposalDetail('draft'));
    server.use(
      http.get('*/api/ai-tasks/config', () => HttpResponse.json({ data: mockGraphAiConfig() })),
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
    renderPage(graphUser);
    await screen.findByText('Line number 3');
    const line = selectInLine('Line number 3', 5, 11);
    // A drag-select ends in a click on an editable line; it must not open the editor.
    fireEvent.click(line);
    expect(screen.getByRole('button', { name: 'Edit the line at 0:15' })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Add to graph' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to graph' });
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('number');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Add to draft' })).toBeEnabled(),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to draft' }));

    expect(await screen.findByRole('region', { name: 'Graph proposal' })).toBeInTheDocument();
    const add = proposalMock.requests.find((request) => request.path.endsWith('/items'));
    expect(add?.body).toMatchObject({
      evidence: [
        { source: 'segment', segmentId: 's3', segmentRev: 1, charStart: 5, charEnd: 11, quote: 'number' },
      ],
    });
  });

  it('offers nothing while the graph is off', async () => {
    server.use(
      http.get('*/api/ai-tasks/config', () =>
        HttpResponse.json({ data: mockGraphAiConfig({ graphEnabled: false }) }),
      ),
    );
    renderPage(graphUser);
    await screen.findByText('Line number 3');
    await new Promise((resolve) => setTimeout(resolve, 50));
    selectInLine('Line number 3', 5, 11);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: 'Add to graph' })).not.toBeInTheDocument();
  });
});
