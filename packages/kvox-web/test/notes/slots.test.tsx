import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';

import { mockAdminUser, render, testAi } from './helpers.js';
import { fakeApiError } from '../../src/core/testing/index.js';
import { NotePage } from '../../src/notes/ui/pages/NotePage.js';
import { NotesPage } from '../../src/notes/ui/pages/NotesPage.js';
import type {
  NoteHeaderActionsProps,
  NotePageProviderProps,
  NotePageSlots,
  NoteProposalActionsProps,
  NoteSelectionActionsProps,
} from '../../src/notes/ui/slots.js';
import type { Note } from '../../src/notes/headless/clients/notes.js';

/**
 * The slots of the note page and the library — issue #502, epic #498.
 *
 * The notes slice cannot import the graph UI, so what the web edition adds to
 * the note page (the review sheet, "Add to graph", a header button) arrives
 * through these slots. The contract worth pinning is what the page hands each
 * one, that an absent slot costs nothing, that the provider wraps the page, and
 * that a slot which throws cannot take the page down.
 */

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    title: 'Q3 planning — decisions',
    titleSource: 'ai',
    body: 'We will ship behind a flag.',
    status: 'ready',
    currentVersion: 3,
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    originTranscript: {
      id: 't1',
      title: 'Planning call',
      durationMs: 60_000,
      status: 'ready',
      playbackStatus: 'not_needed',
      via: 'direct',
      hops: 0,
    },
    ...overrides,
  };
}

function renderNote(slots?: NotePageSlots) {
  return render(
    <Routes>
      <Route path="/notes/:id" element={<NotePage slots={slots} ai={testAi()} />} />
    </Routes>,
    {
      wrapperOptions: { user: mockAdminUser, route: '/notes/n1' },
      hostOptions: {
        routes: {
          'GET /notes/n1': note(),
          'GET /note-templates/:id': () => {
            throw fakeApiError(404, 'Not found');
          },
        },
      },
    },
  );
}

describe('NotePage — slots', () => {
  it('renders the page unchanged with no slots at all', async () => {
    renderNote();

    expect(await screen.findByText('We will ship behind a flag.')).toBeInTheDocument();
  });

  it('hands each slot the note it is about', async () => {
    const header = vi.fn((_props: NoteHeaderActionsProps) => <button type="button">Header slot</button>);
    const proposal = vi.fn((_props: NoteProposalActionsProps) => <p>Proposal slot</p>);
    const selection = vi.fn((_props: NoteSelectionActionsProps) => <p>Selection slot</p>);

    renderNote({
      HeaderActions: header,
      ProposalActions: proposal,
      SelectionActions: selection,
    });

    expect(await screen.findByRole('button', { name: 'Header slot' })).toBeInTheDocument();
    expect(screen.getByText('Proposal slot')).toBeInTheDocument();
    expect(screen.getByText('Selection slot')).toBeInTheDocument();

    expect(header).toHaveBeenCalledWith({ noteId: 'n1' }, undefined);
    const proposalProps = proposal.mock.calls.at(-1)![0];
    expect(proposalProps).toMatchObject({
      noteId: 'n1',
      version: 3,
      originTranscriptId: 't1',
      status: 'ready',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(proposalProps.bodyRef).toHaveProperty('current');
    expect(selection.mock.calls.at(-1)![0]).toMatchObject({
      noteId: 'n1',
      version: 3,
      markdown: 'We will ship behind a flag.',
      // Not while the body is being edited or written; a ready note is neither.
      enabled: true,
    });
  });

  it('wraps the whole page in the Provider, so the slots can share state', async () => {
    const seen: Array<string | undefined> = [];
    function Provider({ noteId, children }: NotePageProviderProps) {
      seen.push(noteId);
      return <div data-testid="provider">{children}</div>;
    }

    renderNote({ Provider, HeaderActions: () => <span>Header slot</span> });

    const provider = await screen.findByTestId('provider');
    expect(provider).toContainElement(await screen.findByText('We will ship behind a flag.'));
    expect(provider).toContainElement(screen.getByText('Header slot'));
    expect(seen[0]).toBe('n1');
  });

  it('asks the aside hook on every render, and renders with the width it answers', async () => {
    // The width reaches the page as a responsive `mr` (an `sx` value, never a
    // media-query read: the breakpoint gates stay in the shell), which jsdom
    // cannot evaluate, so the observable contract is that the hook is called by
    // the page and the page renders around it.
    const useAsideWidth = vi.fn(() => 480);

    renderNote({ useAsideWidth });

    expect(await screen.findByText('We will ship behind a flag.')).toBeInTheDocument();
    expect(useAsideWidth).toHaveBeenCalled();
  });

  it('survives a slot that throws, and says so in the log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Broken(): never {
      throw new Error('boom');
    }

    renderNote({ HeaderActions: Broken });

    expect(await screen.findByText('We will ship behind a flag.')).toBeInTheDocument();
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('"HeaderActions" slot of the notes pages threw'),
        expect.any(Error),
      ),
    );
    error.mockRestore();
  });
});

describe('NotesPage — the SearchPrefix slot', () => {
  const routes = {
    'GET /notes': { items: [], total: 0, nextCursor: null },
    'GET /search': {
      results: [],
      matchedDocuments: 0,
      truncated: false,
      nextCursor: null,
      degraded: null,
      searchedTypes: ['note'],
      semantic: true,
      semanticReason: null,
      unindexedCount: 0,
    },
  };

  it('is drawn above the ranked results while the search box holds a query, and not before', async () => {
    const { userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(
      <NotesPage
        slots={{ SearchPrefix: ({ query }) => <p>{`Prefix for ${query}`}</p> }}
      />,
      { wrapperOptions: { user: mockAdminUser, route: '/notes' }, hostOptions: { routes } },
    );

    await screen.findByRole('heading', { name: 'Notes', level: 1 });
    expect(screen.queryByText(/Prefix for/)).not.toBeInTheDocument();

    await user.type(await screen.findByLabelText('Search notes'), 'budget');

    expect(await screen.findByText('Prefix for budget')).toBeInTheDocument();
  });
});
