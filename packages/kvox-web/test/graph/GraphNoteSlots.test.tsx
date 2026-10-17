import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { http, HttpResponse, server } from './msw-compat.js';
import { Route, Routes } from 'react-router-dom';
import 'vitest-axe/extend-expect';

import { mockProposalDetail, proposalMock } from './graphData.js';
import './helpers.js';
import { mockAdminUser, render, testAi } from '../notes/helpers.js';
import type { MockUser } from '../notes/helpers.js';
import { NotePage } from '../../src/notes/ui/index.js';
import type { Note } from '../../src/notes/headless/index.js';
import { graphNotePageSlots } from '../../src/graph/ui/slots/GraphNoteSlots.js';

/**
 * `/notes/:id` with the web edition's graph slots — issues #367 and #368,
 * epic #45, the slot components of the graph slice (`graphNotePageSlots`)
 * mounted into the notes slice's `NotePage` (issue #503, epic #498).
 *
 * The note page is the notes slice's; what it does on its own is covered by that
 * slice's `NotePage.test.tsx`. This file is the other half: the review button,
 * the sheet, the extract dialog and "Add to graph" are the graph UI that the
 * slots mount into it, gated on `graph:read`, `graph:write` and the host's
 * `graphEnabled`, and driven over the fake host.
 */

const API_BASE = 'http://localhost:3000/api';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Q3 planning — decisions',
    titleSource: 'ai',
    body: '',
    status: 'generating',
    currentVersion: 0,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'tpl-1',
    templateName: 'Meeting minutes',
    sourceName: null,
    contextText: null,
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** What `GET /api/notes/:id` answers with right now. */
let current: Note;

/** What `GET /api/ai-tasks/config` answers with. */
let aiConfig: Record<string, unknown>;

beforeEach(() => {
  localStorage.setItem('theme_mode', 'light');
  current = note();
  aiConfig = {
    available: true,
    provider: 'openai',
    providerLabel: 'OpenAI',
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
  };
  server.use(
    http.get(`${API_BASE}/ai-tasks/config`, () => HttpResponse.json({ data: aiConfig })),
    http.get(`${API_BASE}/notes/:id`, () => HttpResponse.json({ data: current })),
  );
});

function renderNote(
  route = '/notes/n1',
  user: MockUser = mockAdminUser,
  graphEnabled: boolean | null = true,
) {
  return render(
    <Routes>
      <Route path="/notes/:id" element={<NotePage slots={graphNotePageSlots} ai={testAi()} />} />
      <Route path="/notes" element={<h1>Library</h1>} />
    </Routes>,
    { wrapperOptions: { user, route }, hostOptions: { features: { graphEnabled: graphEnabled ?? undefined } } },
  );
}
// =============================================================================
// #367 — the graph proposal entry button and review sheet
// =============================================================================

describe('NotePage — the graph proposal review (issue #367)', () => {
  const graphUser: MockUser = {
    ...mockAdminUser,
    permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'],
  };

  beforeEach(() => {
    current = note({ status: 'ready', body: 'We will ship behind a flag.', currentVersion: 3 });
    proposalMock.reset(mockProposalDetail('draft'));
  });

  it('is absent when the deployment has connected knowledge off', async () => {
    renderNote('/notes/n1', graphUser, false);
    await screen.findByText('We will ship behind a flag.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Graph proposal/ })).not.toBeInTheDocument();
  });

  it('is absent while the host has not said whether connected knowledge is on', async () => {
    renderNote('/notes/n1', graphUser, null);
    await screen.findByText('We will ship behind a flag.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Graph proposal/ })).not.toBeInTheDocument();
  });

  it('is absent without graph:read', async () => {
    renderNote('/notes/n1', mockAdminUser);
    await screen.findByText('We will ship behind a flag.');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: /Graph proposal/ })).not.toBeInTheDocument();
  });

  it('shows the undecided count and opens the sheet beside the note', async () => {
    const user = userEvent.setup();
    renderNote('/notes/n1', graphUser);
    const pending = proposalMock.detail!.proposal.counts.pending;
    const button = await screen.findByRole('button', { name: `Graph proposal, ${pending} undecided` });
    expect(within(button).getByText(String(pending))).toBeInTheDocument();
    await user.click(button);
    expect(await screen.findByRole('region', { name: 'Graph proposal' })).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the sheet from ?review=1', async () => {
    renderNote('/notes/n1?review=1', graphUser);
    expect(await screen.findByRole('region', { name: 'Graph proposal' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /People/ })).toBeInTheDocument();
  });
});

// =============================================================================
// #368 — guide the graph, re-extract with a model, add from a selection
// =============================================================================

describe('NotePage — guide the graph and add from a selection (issue #368)', () => {
  const graphUser: MockUser = {
    ...mockAdminUser,
    permissions: [...mockAdminUser.permissions, 'graph:read', 'graph:write'],
  };
  const BODY = 'We will ship **behind a flag** next week.';

  beforeEach(() => {
    current = note({ status: 'ready', body: BODY, currentVersion: 3 });
    proposalMock.reset(mockProposalDetail('draft'));
  });

  function selectRendered(fromText: string, fromOffset: number, toText: string, toOffset: number) {
    const find = (text: string) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent === text) return node;
      }
      throw new Error(`No text node "${text}"`);
    };
    const range = document.createRange();
    range.setStart(find(fromText), fromOffset);
    range.setEnd(find(toText), toOffset);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.pointerUp(document);
  }

  it('Extract from the empty sheet opens the extract dialog, then shows the run', async () => {
    proposalMock.reset(null);
    const user = userEvent.setup();
    renderNote('/notes/n1?review=1', graphUser);
    await user.click(await screen.findByRole('button', { name: 'Extract' }));
    const dialog = await screen.findByRole('dialog', { name: 'Extract to your graph' });
    await within(dialog).findByText(/input tokens/);
    await user.click(within(dialog).getByRole('button', { name: 'Extract' }));
    expect(await screen.findByText('Reading your note and transcript…')).toBeInTheDocument();
    const extract = proposalMock.requests.filter((request) => request.path.endsWith('/extract'));
    expect(extract).toHaveLength(1);
    expect(extract[0].body).toEqual({});
  });

  it('shows the guidance summary and Edit guidance re-opens the dialog pre-filled', async () => {
    const detail = mockProposalDetail('draft');
    detail.proposal = {
      ...detail.proposal,
      userGuidance: { pinnedEntityIds: [], instructions: 'Only the migration', entityTypes: ['Person', 'Project'] },
    };
    proposalMock.reset(detail);
    const user = userEvent.setup();
    renderNote('/notes/n1?review=1', graphUser);
    expect(await screen.findByText('2 types · instructions')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit guidance' }));
    const dialog = await screen.findByRole('dialog', { name: 'Extract again' });
    expect(await within(dialog).findByRole('textbox', { name: 'Instructions' })).toHaveValue('Only the migration');
    expect(within(dialog).getByRole('checkbox', { name: 'Claim' })).toHaveAttribute('aria-checked', 'false');
  });

  it('adds a selection from the rendered body to the draft, and opens the sheet on it', async () => {
    renderNote('/notes/n1', graphUser);
    await screen.findByText('behind a flag');
    await screen.findByRole('button', { name: /Graph proposal/ });
    act(() => selectRendered('We will ship ', 3, 'behind a flag', 6));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to graph' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to graph' });
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('will ship **behind');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Add to draft' })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to draft' }));
    expect(await screen.findByRole('region', { name: 'Graph proposal' })).toBeInTheDocument();
    const sheet = screen.getByRole('region', { name: 'Graph proposal' });
    const title = await within(sheet).findByText('will ship **behind');
    const row = title.closest('[data-testid^="proposal-row-"]') as HTMLElement;
    expect(within(row).getByText('Added by you')).toBeInTheDocument();
    const add = proposalMock.requests.find((request) => request.path.endsWith('/items'));
    expect(add?.body).toMatchObject({
      evidence: [
        {
          source: 'note',
          noteVersion: 3,
          charStart: BODY.indexOf('will'),
          charEnd: BODY.indexOf('behind') + 'behind'.length,
          quote: 'will ship **behind',
        },
      ],
    });
  });

  it('offers nothing for a selection without graph:write', async () => {
    const reader: MockUser = { ...mockAdminUser, permissions: [...mockAdminUser.permissions, 'graph:read'] };
    renderNote('/notes/n1', reader);
    await screen.findByText('behind a flag');
    await screen.findByRole('button', { name: /Graph proposal/ });
    act(() => selectRendered('We will ship ', 3, 'behind a flag', 6));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('button', { name: 'Add to graph' })).not.toBeInTheDocument();
  });
});
