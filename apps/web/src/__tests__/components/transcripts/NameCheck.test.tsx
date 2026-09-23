/**
 * "Fix names with AI" — the start dialog and the review panel (#329, #330).
 *
 * The dialog runs over the real `useAiConfig` and the real service layer, with
 * MSW answering — so what is asserted is the request body the API receives,
 * not a callback's arguments the component could satisfy without ever
 * producing that body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { server } from '../../mocks/server';
import { render } from '../../utils/test-utils';
import { NameCheckDialog, formatEstimate } from '../../../components/transcripts/NameCheckDialog';
import {
  NameSuggestionsPanel,
  groupNameSuggestions,
} from '../../../components/transcripts/NameSuggestionsPanel';
import { createNameCheck } from '../../../services/transcriptNameChecks';
import type {
  LatestNameCheck,
  NameCheckRun,
  NameSuggestion,
} from '../../../services/transcriptNameChecks';
import type { TranscriptSpeaker } from '../../../services/transcripts';

const API_BASE = '*/api';

const SPEAKERS: TranscriptSpeaker[] = [
  { id: '11111111-1111-4111-8111-111111111111', label: 'A', displayName: 'Oscar', colorIndex: 0, rev: 1 },
  { id: '22222222-2222-4222-8222-222222222222', label: 'B', displayName: 'Speaker B', colorIndex: 1, rev: 1 },
  { id: '33333333-3333-4333-8333-333333333333', label: 'C', displayName: 'Ana Solís', colorIndex: 2, rev: 1 },
];

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

function run(overrides: Partial<NameCheckRun> = {}): NameCheckRun {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    transcriptId: 't1',
    mode: 'standard',
    status: 'ready',
    basedOnVersion: 4,
    terms: ['Oscar'],
    providerId: 'openai',
    model: 'gpt-test',
    candidateCount: 3,
    suggestionCount: 3,
    inputTokens: 1000,
    outputTokens: 100,
    errorClass: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function suggestion(id: string, overrides: Partial<NameSuggestion> = {}): NameSuggestion {
  return {
    id,
    segmentId: 's0',
    speakerId: SPEAKERS[0].id,
    startMs: 12_000,
    start: 4,
    end: 8,
    original: 'Skar',
    replacement: 'Oscar',
    confidence: 0.92,
    reason: 'Sounds like the speaker name',
    source: 'phonetic',
    preview: 'Hi, Skar here',
    stale: false,
    ...overrides,
  };
}

function latest(overrides: Partial<LatestNameCheck> = {}): LatestNameCheck {
  return {
    run: run(),
    suggestions: [],
    counts: { pending: 0, accepted: 0, rejected: 0, stale: 0 },
    ...overrides,
  };
}

// =============================================================================
// Dialog
// =============================================================================

describe('NameCheckDialog', () => {
  let createBodies: unknown[];
  let estimateModes: string[];

  beforeEach(() => {
    createBodies = [];
    estimateModes = [];
    server.use(
      http.get(`${API_BASE}/ai/config`, () => HttpResponse.json({ data: aiConfig() })),
      http.get(`${API_BASE}/transcripts/:id/name-checks/estimate`, ({ request }) => {
        const mode = new URL(request.url).searchParams.get('mode') ?? '';
        estimateModes.push(mode);
        return HttpResponse.json({
          data:
            mode === 'thorough'
              ? { inputTokens: 48_200, requests: 6, candidates: 9 }
              : { inputTokens: 3_150, requests: 1, candidates: 9 },
        });
      }),
      http.post(`${API_BASE}/transcripts/:id/name-checks`, async ({ request }) => {
        createBodies.push(await request.json());
        return HttpResponse.json(
          {
            data: {
              run: run({ status: 'pending' }),
              estimate: { inputTokens: 3_150, requests: 1, candidates: 9 },
            },
          },
          { status: 202 },
        );
      }),
    );
  });

  function renderDialog(props: Partial<React.ComponentProps<typeof NameCheckDialog>> = {}) {
    const onOpenResults = vi.fn();
    const onClose = vi.fn();
    render(
      <NameCheckDialog
        open
        transcriptId="t1"
        speakers={SPEAKERS}
        onClose={onClose}
        onStart={(input) => createNameCheck('t1', input)}
        onOpenResults={onOpenResults}
        {...props}
      />,
    );
    return { onOpenResults, onClose };
  }

  it('lists only named speakers, all checked, and shows the estimate', async () => {
    renderDialog();

    expect(await screen.findByRole('checkbox', { name: 'Oscar' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Ana Solís' })).toBeChecked();
    // A generic label is never offered — the server would drop it anyway.
    expect(screen.queryByRole('checkbox', { name: 'Speaker B' })).not.toBeInTheDocument();

    expect(
      await screen.findByText(/≈ 1 request, ~3,150 tokens/),
    ).toBeInTheDocument();
    expect(estimateModes).toEqual(['standard']);
  });

  it('re-estimates when the mode changes', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText(/≈ 1 request/);

    await user.click(screen.getByRole('radio', { name: /Thorough/ }));

    expect(await screen.findByText(/≈ 6 requests, ~48,200 tokens/)).toBeInTheDocument();
    expect(estimateModes).toEqual(['standard', 'thorough']);
  });

  it('posts the selected speakers, extra terms and mode, then opens the results', async () => {
    const user = userEvent.setup();
    const { onOpenResults, onClose } = renderDialog();
    await screen.findByText(/≈ 1 request/);

    await user.click(screen.getByRole('checkbox', { name: 'Ana Solís' }));
    await user.type(screen.getByRole('combobox', { name: 'Other names & terms' }), 'Kvox{Enter}');
    await user.click(screen.getByRole('radio', { name: /Thorough/ }));
    await user.click(screen.getByRole('button', { name: 'Check names' }));

    await waitFor(() => expect(onOpenResults).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(createBodies).toEqual([
      { mode: 'thorough', speakerIds: [SPEAKERS[0].id], terms: ['Kvox'] },
    ]);
  });

  it('pre-selects only the speaker it was opened for', async () => {
    renderDialog({ initialSpeakerIds: [SPEAKERS[2].id] });

    expect(await screen.findByRole('checkbox', { name: 'Ana Solís' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Oscar' })).not.toBeChecked();
  });

  it('renders AiKeyRequired when the caller has no key', async () => {
    server.use(
      http.get(`${API_BASE}/ai/config`, () =>
        HttpResponse.json({ data: aiConfig({ keyConfigured: false }) }),
      ),
    );
    renderDialog();

    expect(
      await screen.findByRole('heading', { name: 'Add your AI key to use this' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check names' })).not.toBeInTheDocument();
  });

  it('opens the results instead of erroring when a check is already running', async () => {
    server.use(
      http.post(`${API_BASE}/transcripts/:id/name-checks`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            code: 'CONFLICT',
            message: 'A name check is already running',
            details: { reason: 'name_check_running', checkId: run().id },
          },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    const { onOpenResults } = renderDialog();
    await screen.findByText(/≈ 1 request/);

    await user.click(screen.getByRole('button', { name: 'Check names' }));

    await waitFor(() => expect(onOpenResults).toHaveBeenCalled());
  });

  it('turns ai_key_missing into the key setup state', async () => {
    server.use(
      http.post(`${API_BASE}/transcripts/:id/name-checks`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            code: 'CONFLICT',
            message: 'No key',
            details: { reason: 'ai_key_missing' },
          },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText(/≈ 1 request/);

    await user.click(screen.getByRole('button', { name: 'Check names' }));

    expect(
      await screen.findByRole('link', { name: 'Set up your AI key' }),
    ).toHaveAttribute('href', '/settings/ai');
  });

  it('formats the estimate', () => {
    expect(formatEstimate({ inputTokens: 12_400, requests: 3, candidates: 1 })).toBe(
      '≈ 3 requests, ~12,400 tokens',
    );
  });
});

// =============================================================================
// Panel
// =============================================================================

describe('NameSuggestionsPanel', () => {
  const SUGGESTIONS: NameSuggestion[] = [
    suggestion('b1111111-0000-4000-8000-000000000001'),
    suggestion('b1111111-0000-4000-8000-000000000002', {
      segmentId: 's2',
      startMs: 30_000,
      original: 'skar',
      preview: 'said skar again',
    }),
    suggestion('b1111111-0000-4000-8000-000000000003', {
      segmentId: 's3',
      original: 'Anna Soles',
      replacement: 'Ana Solís',
      preview: 'ask Anna Soles',
    }),
    suggestion('b1111111-0000-4000-8000-000000000004', {
      segmentId: 's4',
      startMs: 50_000,
      preview: 'totally different now',
      stale: true,
    }),
  ];

  function renderPanel(overrides: Partial<React.ComponentProps<typeof NameSuggestionsPanel>> = {}) {
    const handlers = {
      onAccept: vi.fn(),
      onReject: vi.fn(),
      onJump: vi.fn(),
      onStartNew: vi.fn(),
      onClose: vi.fn(),
    };
    render(
      <NameSuggestionsPanel
        open
        latest={latest({
          suggestions: SUGGESTIONS,
          counts: { pending: 4, accepted: 0, rejected: 0, stale: 0 },
        })}
        isLoading={false}
        loadError={null}
        busy={false}
        {...handlers}
        {...overrides}
      />,
    );
    return handlers;
  }

  it('groups suggestions case-insensitively by original → replacement', () => {
    const groups = groupNameSuggestions(SUGGESTIONS);
    expect(groups.map((group) => [group.original, group.replacement, group.suggestions.length]))
      .toEqual([
        ['Skar', 'Oscar', 3],
        ['Anna Soles', 'Ana Solís', 1],
      ]);
    // The stale row is in the group but never in what a group Accept sends.
    expect(groups[0].acceptableIds).toEqual([SUGGESTIONS[0].id, SUGGESTIONS[1].id]);
  });

  it('renders a heading and one header per group with its count', () => {
    renderPanel();

    expect(screen.getByRole('region', { name: 'Name suggestions' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Skar → Oscar ×3/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Anna Soles → Ana Solís ×1/ })).toBeInTheDocument();
  });

  it('"Accept all" on a group accepts exactly that group’s acceptable ids', async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Accept all "Skar" → "Oscar"' }));

    expect(onAccept).toHaveBeenCalledWith([SUGGESTIONS[0].id, SUGGESTIONS[1].id]);
  });

  it('"Reject all" on a group rejects every row in it', async () => {
    const user = userEvent.setup();
    const { onReject } = renderPanel();

    await user.click(
      screen.getByRole('button', { name: 'Reject all "Anna Soles" → "Ana Solís"' }),
    );

    expect(onReject).toHaveBeenCalledWith([SUGGESTIONS[2].id]);
  });

  it('shows a stale row disabled, with the reason written out', () => {
    renderPanel();

    const row = screen.getByTestId(`name-suggestion-${SUGGESTIONS[3].id}`);
    expect(within(row).getByText('Text changed since the check')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /^Accept/ })).toBeDisabled();
  });

  it('footer accepts every non-stale suggestion', async () => {
    const user = userEvent.setup();
    const { onAccept } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Accept all (3)' }));

    expect(onAccept).toHaveBeenCalledWith([
      SUGGESTIONS[0].id,
      SUGGESTIONS[1].id,
      SUGGESTIONS[2].id,
    ]);
  });

  it('jumps to a suggestion', async () => {
    const user = userEvent.setup();
    const { onJump } = renderPanel();

    const row = screen.getByTestId(`name-suggestion-${SUGGESTIONS[0].id}`);
    await user.click(within(row).getByRole('button', { name: 'Go to 0:12' }));

    expect(onJump).toHaveBeenCalledWith(SUGGESTIONS[0]);
  });

  it('shows progress while the check is running', () => {
    renderPanel({ latest: latest({ run: run({ status: 'running' }) }) });

    expect(screen.getByRole('progressbar', { name: 'Checking for misheard names' }))
      .toBeInTheDocument();
    expect(screen.getByText('You can keep editing; results appear here.')).toBeInTheDocument();
  });

  it('says so when nothing was found', () => {
    renderPanel({ latest: latest() });

    expect(screen.getByText('No likely misspellings found.')).toBeInTheDocument();
  });

  it('shows the failure and offers a retry', async () => {
    const user = userEvent.setup();
    const { onStartNew } = renderPanel({
      latest: latest({ run: run({ status: 'failed', error: 'The provider refused the key' }) }),
    });

    expect(screen.getByText('The provider refused the key')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onStartNew).toHaveBeenCalled();
  });
});
