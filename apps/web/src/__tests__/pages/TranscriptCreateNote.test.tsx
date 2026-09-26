import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes, useLocation } from 'react-router-dom';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

vi.mock('../../services/transcripts', () => ({
  getTranscript: vi.fn(),
  getTranscripts: vi.fn(),
  getTranscriptSegments: vi.fn(),
  getTranscriptAudio: vi.fn(),
  getTranscriptWords: vi.fn(),
  retryTranscript: vi.fn(),
  deleteTranscript: vi.fn(),
}));

vi.mock('../../contexts/NotificationContext', () => ({ useNotifications: () => null }));

import { server } from '../mocks/server';
import { render, mockAdminUser } from '../utils/test-utils';
import type { MockUser } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import TranscriptPage, { CREATE_NOTE_NOT_READY_REASON } from '../../pages/TranscriptPage';
import NewNotePage from '../../pages/NewNotePage';
import {
  getTranscript,
  getTranscripts,
  getTranscriptAudio,
  getTranscriptSegments,
  getTranscriptWords,
} from '../../services/transcripts';
import type {
  TranscriptDetail,
  TranscriptSegment,
  TranscriptSpeaker,
} from '../../services/transcripts';

/**
 * The create-note entry point on the transcript viewer — issue #59, epic #45.
 *
 * The three gates are the substance of this issue, and each one is a DIFFERENT
 * treatment chosen from what the user can do about it, so they are asserted as
 * three different shapes rather than three booleans:
 *
 *   no `notes:write`      nothing in the header AND nothing in the overflow menu
 *   `keyConfigured` false the control is there, it navigates, and the
 *                         DESTINATION explains itself
 *   not `ready`           the control is there, `aria-disabled`, and the reason
 *                         is readable rather than grey
 *
 * The navigation test drives the real handoff — `TranscriptPage` and
 * `NewNotePage` mounted under one router — because "deep-links to
 * `/notes/new?transcriptId=<id>`" is only true if the flow on the other end
 * actually reads it. A test asserting the URL alone would keep passing on the
 * day that contract broke.
 *
 * `services/transcripts` is mocked and everything else runs over MSW, matching
 * `TranscriptPage.test.tsx` and `NewNotePage.test.tsx` respectively.
 */

const API_BASE = 'http://localhost:3000/api';

/** jsdom performs no layout, so `color-contrast` is a false-negative trap here. */
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const mockGetTranscript = vi.mocked(getTranscript);
const mockGetTranscripts = vi.mocked(getTranscripts);
const mockGetSegments = vi.mocked(getTranscriptSegments);
const mockGetAudio = vi.mocked(getTranscriptAudio);
const mockGetWords = vi.mocked(getTranscriptWords);

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Ana', colorIndex: 0, rev: 1 },
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
    speakerCount: 1,
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

const SEGMENTS: TranscriptSegment[] = Array.from({ length: 4 }, (_, index) => ({
  id: `s${index}`,
  speakerId: 'sp1',
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

function noteRow(id: string, title: string) {
  return {
    id,
    title,
    excerpt: 'What we agreed.',
    status: 'ready',
    currentVersion: 1,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'tpl-1',
    templateName: 'Meeting minutes',
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function aiConfig(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    provider: 'openai',
    providerLabel: 'OpenAI',
    // #97: `source`/`derivedFrom` complete the `AiConfigModel` shape — absent,
    // a provenance assertion elsewhere would silently pass against a fallback
    // chip instead of the real one.
    models: [
      {
        id: 'gpt-4o-mini',
        label: 'GPT-4o mini',
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        source: 'catalogue',
        derivedFrom: null,
        structuredOutput: true,
        toolCalling: true,
      },
    ],
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    keyConfigured: true,
    ...overrides,
  };
}

function template(id: string, name: string) {
  return {
    id,
    name,
    description: '',
    instructions: 'Write it up.',
    outputFormat: 'markdown',
    structure: [],
    tone: null,
    length: null,
    model: null,
    isArchived: false,
    builtIn: true,
    hidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** The admin fixture minus one permission — the only difference under test. */
function withoutPermission(permission: string): MockUser {
  return {
    ...mockAdminUser,
    permissions: mockAdminUser.permissions.filter((value) => value !== permission),
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
  localStorage.setItem('theme_mode', 'light');
  setViewportWidth(1440);

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
  mockGetTranscripts.mockResolvedValue({
    items: [
      {
        id: 't1',
        title: 'Weekly standup',
        status: 'ready',
        transcriptionStatus: 'completed',
        playbackStatus: 'ready',
        language: 'en',
        durationMs: 600_000,
        speakerCount: 1,
        wordCount: 1200,
        currentVersion: 1,
        failureReason: null,
        access: 'owner',
        ownerName: 'Admin User',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    nextCursor: null,
  } as Awaited<ReturnType<typeof getTranscripts>>);

  server.use(
    http.get(`${API_BASE}/notes`, () =>
      HttpResponse.json({ data: { items: [], nextCursor: null } }),
    ),
    http.get(`${API_BASE}/ai/config`, () => HttpResponse.json({ data: aiConfig() })),
    http.get(`${API_BASE}/note-templates`, () =>
      HttpResponse.json({ data: { items: [template('tpl-1', 'Meeting minutes')], total: 1 } }),
    ),
  );
});

/** The live URL, so a test can assert where the action actually went. */
function Probe() {
  const { pathname, search } = useLocation();
  return <span data-testid="url">{`${pathname}${search}`}</span>;
}

/**
 * The viewer alone, at whatever viewport the test set.
 */
function renderViewer(user: MockUser = mockAdminUser) {
  return render(
    <Routes>
      <Route path="/transcripts/:id" element={<TranscriptPage />} />
    </Routes>,
    { wrapperOptions: { user, route: '/transcripts/t1' } },
  );
}

/** The viewer AND the destination, under one router — the real handoff. */
function renderFlow(user: MockUser = mockAdminUser) {
  return render(
    <>
      <Routes>
        <Route path="/transcripts/:id" element={<TranscriptPage />} />
        <Route path="/notes/new" element={<NewNotePage />} />
      </Routes>
      <Probe />
    </>,
    { wrapperOptions: { user, route: '/transcripts/t1' } },
  );
}

/** The compact treatment puts the action in the existing overflow menu. */
async function openOverflow(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Transcript actions' }));
  return screen.findByRole('menu');
}

describe('TranscriptPage — the create-note action and `notes:write`', () => {
  it('offers it to a user who holds `notes:write`', async () => {
    renderViewer();

    expect(await screen.findByRole('button', { name: 'Create note' })).toBeInTheDocument();
  });

  it('is ABSENT for a user who does not — in the header and in the menu', async () => {
    const user = userEvent.setup();
    renderViewer(withoutPermission('notes:write'));

    await screen.findByText('Weekly standup');
    expect(screen.queryByRole('button', { name: 'Create note' })).not.toBeInTheDocument();

    // Not merely disabled, and not only missing from the wide header: a control
    // this role can never use must not be in the overflow menu either.
    const menu = await openOverflow(user);
    expect(within(menu).queryByRole('menuitem', { name: /Create note/ })).toBeNull();
  });

  it('moves into the overflow menu on a phone rather than crowding the header', async () => {
    const user = userEvent.setup();
    setViewportWidth(400);
    renderViewer();

    await screen.findByText('Weekly standup');
    expect(screen.queryByRole('button', { name: 'Create note' })).not.toBeInTheDocument();

    const menu = await openOverflow(user);
    expect(within(menu).getByRole('menuitem', { name: /Create note/ })).toBeInTheDocument();
  });
});

describe('TranscriptPage — where the create-note action goes', () => {
  it('deep-links to /notes/new?transcriptId=<id> and the flow lands pre-selected', async () => {
    const user = userEvent.setup();
    renderFlow();

    await user.click(await screen.findByRole('button', { name: 'Create note' }));

    expect(screen.getByTestId('url')).toHaveTextContent('/notes/new?transcriptId=t1');

    // Step 1 is done on arrival — the whole point of the deep link — and the
    // template choice is the live question.
    await screen.findByRole('heading', { name: 'New note', level: 1 });
    await waitFor(() =>
      expect(screen.getByLabelText('Transcript')).toHaveTextContent('Weekly standup'),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Template')).toHaveTextContent('Meeting minutes'),
    );
  });

  it('is offered, and still navigates, when the caller has saved no AI key', async () => {
    // The deliberate non-gate: hiding this from the users who have not set up a
    // key hides it from exactly the people who have never heard of it. The
    // destination explains the problem and links to the one page that fixes it.
    server.use(
      http.get(`${API_BASE}/ai/config`, () =>
        HttpResponse.json({ data: aiConfig({ keyConfigured: false }) }),
      ),
    );
    const user = userEvent.setup();
    renderFlow();

    await user.click(await screen.findByRole('button', { name: 'Create note' }));

    expect(
      await screen.findByRole('heading', { name: 'Add your AI key to use this' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Template')).not.toBeInTheDocument();
  });
});

describe('TranscriptPage — the create-note action before the transcript is ready', () => {
  beforeEach(() => {
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ status: 'processing', transcriptionStatus: 'processing' }),
      etag: 'W/"v1"',
    });
  });

  it('disables it and says why, in text rather than in grey', async () => {
    renderFlow();

    const action = await screen.findByRole('button', { name: 'Create note' });
    expect(action).toHaveAttribute('aria-disabled', 'true');

    // The reason is IN THE ACCESSIBILITY TREE, not only in a hover tooltip:
    // `aria-describedby` resolves to an element carrying the sentence.
    const describedBy = action.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      CREATE_NOTE_NOT_READY_REASON,
    );
  });

  it('stays keyboard-reachable, shows the reason on focus, and does not navigate', async () => {
    const user = userEvent.setup();
    renderFlow();

    const action = await screen.findByRole('button', { name: 'Create note' });

    // `aria-disabled`, not `disabled`: a truly disabled button cannot be
    // focused at all, so a keyboard user tabbing the header would skip straight
    // past the control and never meet the explanation.
    action.focus();
    expect(action).toHaveFocus();

    // And the same sentence is offered to a pointer, through the tooltip.
    await user.hover(action);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      CREATE_NOTE_NOT_READY_REASON,
    );
    await user.unhover(action);

    await user.click(action);
    expect(screen.getByTestId('url')).toHaveTextContent('/transcripts/t1');
  });

  it('carries the same reason into the compact overflow menu', async () => {
    const user = userEvent.setup();
    setViewportWidth(400);
    renderViewer();

    const menu = await openOverflow(user);
    const item = within(menu).getByRole('menuitem', { name: /Create note/ });

    expect(item).toHaveAttribute('aria-disabled', 'true');
    // A tooltip inside an open menu is announced by almost nothing, so the
    // reason is part of the item's own accessible name instead.
    expect(item).toHaveAccessibleName(
      expect.stringContaining(CREATE_NOTE_NOT_READY_REASON) as unknown as string,
    );
  });
});

describe('TranscriptPage — notes already made from this transcript', () => {
  it('lists them, linking each to its own page', async () => {
    server.use(
      http.get(`${API_BASE}/notes`, ({ request }) => {
        const url = new URL(request.url);
        // The relationship, not "every note": a transcript page listing the
        // whole library would be provenance that is never wrong and never
        // useful.
        expect(url.searchParams.get('sourceTranscriptId')).toBe('t1');
        return HttpResponse.json({
          data: {
            items: [noteRow('n1', 'Standup minutes'), noteRow('n2', 'Action items')],
            nextCursor: null,
          },
        });
      }),
    );
    renderViewer();

    const section = await screen.findByRole('region', {
      name: 'Notes from this transcript',
    });
    expect(within(section).getByRole('link', { name: /Standup minutes/ })).toHaveAttribute(
      'href',
      '/notes/n1',
    );
    expect(within(section).getByRole('link', { name: /Action items/ })).toHaveAttribute(
      'href',
      '/notes/n2',
    );
  });

  it('is ABSENT when this transcript has no notes yet', async () => {
    renderViewer();

    await screen.findByText('Weekly standup');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument());
    expect(
      screen.queryByRole('region', { name: 'Notes from this transcript' }),
    ).not.toBeInTheDocument();
  });

  it('is ABSENT for a user who cannot read notes, and asks for none', async () => {
    let asked = 0;
    server.use(
      http.get(`${API_BASE}/notes`, () => {
        asked += 1;
        return HttpResponse.json({ data: { items: [noteRow('n1', 'Standup minutes')], nextCursor: null } });
      }),
    );
    renderViewer(withoutPermission('notes:read'));

    await screen.findByText('Weekly standup');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument());
    expect(
      screen.queryByRole('region', { name: 'Notes from this transcript' }),
    ).not.toBeInTheDocument();
    expect(asked).toBe(0);
  });
});

describe('TranscriptPage — accessibility of the new surface', () => {
  it('has no axe violations with the action and the notes list rendered', async () => {
    server.use(
      http.get(`${API_BASE}/notes`, () =>
        HttpResponse.json({
          data: { items: [noteRow('n1', 'Standup minutes')], nextCursor: null },
        }),
      ),
    );
    const { container } = renderViewer();

    await screen.findByRole('region', { name: 'Notes from this transcript' });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations while the action is disabled', async () => {
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: detail({ status: 'processing', transcriptionStatus: 'processing' }),
      etag: 'W/"v1"',
    });
    const { container } = renderViewer();

    await screen.findByRole('button', { name: 'Create note' });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
