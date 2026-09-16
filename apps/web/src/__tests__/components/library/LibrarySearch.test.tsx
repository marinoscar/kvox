/**
 * The library search box, over the REAL hooks and MSW — issue #176, epic #164.
 *
 * What these suites pin is the SWITCH: a non-empty box renders
 * `GET /api/search` with its snippets, an empty one renders the newest-first
 * list exactly as before, and the two never appear at once. Everything else
 * here follows from that — the two distinguishable empty states, the count
 * that is a cap rather than a total, and the quiet line an all-stopword query
 * gets instead of an error.
 *
 * Both views are exercised, because they are twins by design and a regression
 * that lands in one and not the other is the thing their twinning exists to
 * make visible.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../../mocks/server';
import { render, mockAdminUser } from '../../utils/test-utils';
import TranscriptsLibraryView from '../../../components/library/TranscriptsLibraryView';
import NotesLibraryView from '../../../components/library/NotesLibraryView';
import type { SearchResponse, SearchResult } from '../../../services/search';
import type { NoteListItem } from '../../../services/notes';
import type { TranscriptListItem } from '../../../services/transcripts';

const API_BASE = 'http://localhost:3000/api';

/**
 * The same `useNavigate` double `TranscriptsLibraryView.test.tsx` installs.
 * `MemoryRouter` has no route for `/transcripts/:id`, so the only observable
 * consequence of opening a result is the call itself.
 */
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

/** Every `GET /api/search` this render issued, so the wiring can be asserted. */
let searchRequests: URL[] = [];

function searchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    type: 'transcript',
    id: 's1',
    title: 'Pricing review',
    score: 0.42,
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'ready',
    snippets: [
      { html: 'we set the <mark>budget</mark> in March', startMs: 62_000, field: 'segment' },
    ],
    ...overrides,
  };
}

function respondWithSearch(overrides: Partial<SearchResponse> = {}) {
  const body: SearchResponse = {
    results: [searchResult()],
    matchedDocuments: 1,
    truncated: false,
    nextCursor: null,
    degraded: null,
    searchedTypes: ['transcript', 'note'],
    // The healthy default: the semantic arm ran, so `SemanticSearchNotice`
    // stays silent and every suite below is about something else.
    semantic: true,
    semanticReason: null,
    unindexedCount: 0,
    ...overrides,
  };
  server.use(
    http.get(`${API_BASE}/search`, ({ request }) => {
      searchRequests.push(new URL(request.url));
      return HttpResponse.json({ data: body });
    }),
  );
}

function transcriptItem(overrides: Partial<TranscriptListItem> = {}): TranscriptListItem {
  return {
    id: 't1',
    title: 'Weekly standup',
    status: 'ready',
    transcriptionStatus: 'completed',
    playbackStatus: 'ready',
    language: 'en',
    durationMs: 900_000,
    speakerCount: 3,
    wordCount: 2400,
    currentVersion: 1,
    failureReason: null,
    access: 'owner',
    ownerName: 'Admin User',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function noteItem(overrides: Partial<NoteListItem> = {}): NoteListItem {
  return {
    id: 'n1',
    title: 'Q3 planning — decisions',
    excerpt: 'We agreed to ship the migration behind a flag.',
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
    currentGenerationId: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.setItem('theme_mode', 'light');
  // The keyword-only notice remembers its dismissal here; a leak between tests
  // would make one suite's dismissal silence another's assertion.
  sessionStorage.clear();
  mockNavigate.mockReset();
  searchRequests = [];
  server.use(
    http.get(`${API_BASE}/transcripts`, () =>
      HttpResponse.json({ data: { items: [transcriptItem()], nextCursor: null } }),
    ),
    http.get(`${API_BASE}/notes`, () =>
      HttpResponse.json({ data: { items: [noteItem()], nextCursor: null } }),
    ),
    http.get(`${API_BASE}/transcripts/:id`, () =>
      HttpResponse.json({ data: { id: 't1', title: 'Q3 planning' } }),
    ),
  );
  respondWithSearch();
});

function renderTranscripts() {
  return render(<TranscriptsLibraryView />, { wrapperOptions: { user: mockAdminUser } });
}

function renderNotes() {
  return render(<NotesLibraryView />, { wrapperOptions: { user: mockAdminUser } });
}

describe('TranscriptsLibraryView — the box switches the source', () => {
  it('renders the ORDINARY LIST for an empty box, and searches nothing', async () => {
    renderTranscripts();

    expect(await screen.findByText('Weekly standup')).toBeInTheDocument();
    expect(searchRequests).toHaveLength(0);
    expect(screen.queryByText('Pricing review')).not.toBeInTheDocument();
  });

  it('renders SEARCH RESULTS, with their snippets, once the box has a term', async () => {
    const user = userEvent.setup();
    const { container } = renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'budget');

    expect(await screen.findByText('Pricing review')).toBeInTheDocument();
    // The list is GONE — the two sources never share the page.
    expect(screen.queryByText('Weekly standup')).not.toBeInTheDocument();
    // The snippet is why it matched, and the hit is a real <mark> element.
    await waitFor(() => expect(container.querySelector('mark')).not.toBeNull());
    expect(container.querySelector('mark')).toHaveTextContent('budget');
    expect(container.textContent).toContain('we set the budget in March');
  });

  it('asks for its OWN type, with the term, and debounces the keystrokes', async () => {
    const user = userEvent.setup();
    renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'budget');
    await screen.findByText('Pricing review');

    expect(searchRequests.length).toBeGreaterThan(0);
    const last = searchRequests[searchRequests.length - 1];
    expect(last.searchParams.get('q')).toBe('budget');
    expect(last.searchParams.get('types')).toBe('transcript');
    // Six keystrokes are not six ranked full-text queries.
    expect(searchRequests.length).toBeLessThan(6);
  });

  it('opens the SEARCH RESULT that was clicked, by its own id', async () => {
    // Not the list row's id: a result row carries the document's id from the
    // search response, and routing it by anything else would open a different
    // recording than the one whose snippet the reader just read.
    const user = userEvent.setup();
    renderTranscripts();
    await screen.findByText('Weekly standup');
    await user.type(screen.getByLabelText('Search transcripts'), 'budget');

    await user.click(await screen.findByText('Pricing review'));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/transcripts/s1'));
  });
});

describe('TranscriptsLibraryView — the two empty states are different', () => {
  it('says NO MATCHES for a real query that found nothing', async () => {
    respondWithSearch({ results: [], matchedDocuments: 0 });
    const user = userEvent.setup();
    renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'zzz');

    expect(await screen.findByText(/No matches for/)).toBeInTheDocument();
    expect(screen.getByText(/No matches for/)).toHaveTextContent('zzz');
    // NOT the "type to search" panel, and not the list's own filter panel.
    expect(screen.queryByText('Type to search')).not.toBeInTheDocument();
    expect(screen.queryByText('No transcripts match those filters')).not.toBeInTheDocument();
  });

  it('says TYPE TO SEARCH for a box with nothing to search for', async () => {
    const user = userEvent.setup();
    renderTranscripts();
    await screen.findByText('Weekly standup');

    // A box holding only whitespace is a question begun, not a question asked.
    await user.type(screen.getByLabelText('Search transcripts'), '   ');

    expect(await screen.findByText('Type to search')).toBeInTheDocument();
    expect(screen.queryByText(/No matches for/)).not.toBeInTheDocument();
    expect(searchRequests).toHaveLength(0);
  });
});

describe('TranscriptsLibraryView — what the answer says about itself', () => {
  it('reports a truncated window as a CAP, never as a total', async () => {
    respondWithSearch({ matchedDocuments: 200, truncated: true });
    const user = userEvent.setup();
    renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'budget');

    const line = await screen.findByText(/top 200 matches/);
    expect(line).toBeInTheDocument();
    // The sentence must not read as a count of the user's corpus.
    expect(line).toHaveTextContent(/There are more/);
    expect(screen.queryByText('200 matches')).not.toBeInTheDocument();
  });

  it('reports an untruncated window as the exact count it is', async () => {
    respondWithSearch({ matchedDocuments: 1, truncated: false });
    const user = userEvent.setup();
    renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'budget');

    expect(await screen.findByText('1 match')).toBeInTheDocument();
    expect(screen.queryByText(/top 1 matches/)).not.toBeInTheDocument();
  });

  it('explains a stopwords-degraded answer quietly, and not as an error', async () => {
    respondWithSearch({ degraded: 'stopwords' });
    const user = userEvent.setup();
    renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'the and of');

    expect(await screen.findByText(/common words/)).toBeInTheDocument();
    expect(screen.getByText(/title matches only/)).toBeInTheDocument();
    // Not an alert, not a toast.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so when its own type was not searched at all', async () => {
    // A caller holding `notes:read` but not `transcripts:read` gets a 200 with
    // a narrowed `searchedTypes` rather than a 403 — an empty list here would
    // be this view telling the user they have nothing, which is not true.
    respondWithSearch({ results: [], matchedDocuments: 0, searchedTypes: ['note'] });
    const user = userEvent.setup();
    renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'budget');

    expect(await screen.findByText(/cannot search transcripts/)).toBeInTheDocument();
  });
});

describe('SearchResultsView — the keyword-only notice (#191)', () => {
  it('says the results are keyword-only when the semantic arm did not run', async () => {
    respondWithSearch({ semantic: false, semanticReason: 'ai_key_missing', unindexedCount: 0 });
    const user = userEvent.setup();
    renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'budget');

    expect(await screen.findByText(/keyword-only/i)).toBeInTheDocument();
    // ABOVE the results, never instead of them.
    expect(screen.getByText('Pricing review')).toBeInTheDocument();
    // An INFO line. A keyword answer is still a correct answer.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('MuiAlert-colorInfo');
    expect(alert.className).not.toMatch(/colorError|colorWarning/);
    // And it names the reason the server actually reported.
    expect(screen.getByText(/no AI provider key was saved/i)).toBeInTheDocument();
  });

  it('says NOTHING when the answer was semantic', async () => {
    respondWithSearch({ semantic: true, semanticReason: null, unindexedCount: 12 });
    const user = userEvent.setup();
    renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'budget');
    await screen.findByText('Pricing review');

    expect(screen.queryByText(/keyword-only/i)).not.toBeInTheDocument();
    // ⚠ Not even the count — `unindexedCount` is a fact ABOUT the degradation,
    // and there is no degradation to explain here.
    expect(screen.queryByText(/of your documents/i)).not.toBeInTheDocument();
  });

  it('shows the unindexed count only when it is non-zero', async () => {
    respondWithSearch({ semantic: false, semanticReason: 'no_indexed_content', unindexedCount: 7 });
    const user = userEvent.setup();
    const first = renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'budget');
    expect(await screen.findByText(/7 of your documents/i)).toBeInTheDocument();

    first.unmount();
    sessionStorage.clear();

    respondWithSearch({ semantic: false, semanticReason: 'no_indexed_content', unindexedCount: 0 });
    renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'budget');
    expect(await screen.findByText(/keyword-only/i)).toBeInTheDocument();
    expect(screen.queryByText(/of your documents/i)).not.toBeInTheDocument();
  });

  it('never replaces the "no matches" empty state', async () => {
    respondWithSearch({
      results: [],
      matchedDocuments: 0,
      semantic: false,
      semanticReason: 'ai_key_missing',
      unindexedCount: 3,
    });
    const user = userEvent.setup();
    renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'zzz');

    // Both sentences are true at once and both are on screen.
    expect(await screen.findByText(/No matches for/)).toBeInTheDocument();
    expect(screen.getByText(/keyword-only/i)).toBeInTheDocument();
  });

  it('keeps each feed\'s dismissal separate', async () => {
    respondWithSearch({ semantic: false, semanticReason: 'ai_key_missing', unindexedCount: 0 });
    const user = userEvent.setup();
    const first = renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'budget');
    await screen.findByText(/keyword-only/i);
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByText(/keyword-only/i)).not.toBeInTheDocument();

    first.unmount();

    // Notes is a second, independently indexable library.
    renderNotes();
    await screen.findByText('Q3 planning — decisions');
    await user.type(screen.getByLabelText('Search notes'), 'budget');

    expect(await screen.findByText(/keyword-only/i)).toBeInTheDocument();
  });
});

describe('SearchResultsView — accessibility', () => {
  /** jsdom performs no layout, so `color-contrast` is a known false-negative. */
  const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

  it('has no axe violations with results, snippets and a count on screen', async () => {
    respondWithSearch({ matchedDocuments: 200, truncated: true, degraded: 'stopwords' });
    const user = userEvent.setup();
    const { container } = renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'budget');
    await screen.findByText('Pricing review');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations on the "no matches" panel', async () => {
    respondWithSearch({ results: [], matchedDocuments: 0 });
    const user = userEvent.setup();
    const { container } = renderTranscripts();
    await screen.findByText('Weekly standup');

    await user.type(screen.getByLabelText('Search transcripts'), 'zzz');
    await screen.findByText(/No matches for/);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('NotesLibraryView — the same switch, its own type', () => {
  it('renders the ordinary list for an empty box', async () => {
    renderNotes();

    expect(await screen.findByText('Q3 planning — decisions')).toBeInTheDocument();
    expect(searchRequests).toHaveLength(0);
  });

  it('renders search results with snippets, asking for types=note', async () => {
    respondWithSearch({
      results: [
        searchResult({
          type: 'note',
          id: 'n9',
          title: 'Pricing decisions',
          snippets: [
            { html: 'the <mark>budget</mark> was agreed', startMs: null, field: 'body' },
          ],
        }),
      ],
      searchedTypes: ['note'],
    });
    const user = userEvent.setup();
    const { container } = renderNotes();
    await screen.findByText('Q3 planning — decisions');

    await user.type(screen.getByLabelText('Search notes'), 'budget');

    expect(await screen.findByText('Pricing decisions')).toBeInTheDocument();
    expect(screen.queryByText('Q3 planning — decisions')).not.toBeInTheDocument();
    await waitFor(() => expect(container.querySelector('mark')).not.toBeNull());
    expect(searchRequests[searchRequests.length - 1].searchParams.get('types')).toBe('note');
  });

  it('distinguishes its own two empty states too', async () => {
    respondWithSearch({ results: [], matchedDocuments: 0, searchedTypes: ['note'] });
    const user = userEvent.setup();
    renderNotes();
    await screen.findByText('Q3 planning — decisions');

    await user.type(screen.getByLabelText('Search notes'), 'zzz');
    expect(await screen.findByText(/No matches for/)).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Search notes'));
    await user.type(screen.getByLabelText('Search notes'), '  ');
    expect(await screen.findByText('Type to search')).toBeInTheDocument();
  });
});
