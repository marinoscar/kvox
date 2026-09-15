import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../mocks/server';
import { render, mockAdminUser } from '../utils/test-utils';
import NotesPage from '../../pages/NotesPage';
import { clearNoteSourceNameCache } from '../../hooks/useNoteSourceNames';
import type { NoteListItem } from '../../services/notes';

/**
 * `/notes`, over the REAL data hooks and MSW rather than mocked ones — the
 * notes half of the deleted `LibraryPage.test.tsx` (issue #106).
 *
 * The suites are #57's, unchanged except for what the split genuinely moves:
 * these used to be "the Notes TAB" of one page reached at `/notes`, and they
 * are now a page of their own whose `h1` reads "Notes". The strip that used to
 * choose between this view and the transcripts one is gone, and its absence is
 * asserted below rather than left implicit — a leftover strip would render a
 * working page and pass every other test in this file.
 */

const API_BASE = 'http://localhost:3000/api';

/**
 * jsdom performs no layout, so `color-contrast` cannot resolve an element's
 * effective background and is a well-known false-negative trap here. Every
 * other rule runs at full strength — the same posture, and the same reasoning,
 * as the DataTable conformance suite's own axe pass.
 */
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

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
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Record every `GET /api/notes`, so the filter wiring can be asserted. */
let noteRequests: URL[] = [];

function respondWithNotes(
  items: NoteListItem[],
  nextCursor: string | null = null,
  // `total` defaults to the page's own length, which is right for every test
  // that is not about paging. A test that IS — one asserting the count line
  // over a feed with more pages behind it — passes the real figure.
  total: number = items.length,
) {
  server.use(
    http.get(`${API_BASE}/notes`, ({ request }) => {
      noteRequests.push(new URL(request.url));
      return HttpResponse.json({ data: { items, total, nextCursor } });
    }),
    // The source-name resolver reads the transcript by id. Answered here so
    // the rows can assert the NAME rather than the fallback noun — which is
    // the whole "from *Q3 planning*" requirement.
    http.get(`${API_BASE}/transcripts/:id`, () =>
      HttpResponse.json({ data: { id: 't1', title: 'Q3 planning' } }),
    ),
  );
}

beforeEach(() => {
  // ⚠ `localStorage` IS NOT CLEARED BETWEEN TESTS by the global setup, and
  // `ThemeContextProvider` seeds itself from this key — so a dark-theme axe
  // test would leak its theme into every test after it in this file. Reset
  // explicitly rather than relying on declaration order.
  localStorage.setItem('theme_mode', 'light');
  noteRequests = [];
  // The source-name cache is module-level and lives for the tab, deliberately
  // (see `useNoteSourceNames`) — which in a test file means it lives for the
  // whole FILE unless cleared, and one suite's fixture would silently satisfy
  // the next suite's assertion.
  clearNoteSourceNameCache();
  respondWithNotes([noteItem()]);
});

describe('NotesPage', () => {
  function renderNotes(user = mockAdminUser) {
    return render(<NotesPage />, { wrapperOptions: { user, route: '/notes' } });
  }

  it('lists a note with its title, date, template and status', async () => {
    renderNotes();

    expect(await screen.findByText('Q3 planning — decisions')).toBeInTheDocument();
    expect(screen.getByText(/Meeting minutes/)).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('names the source and links to it — "from Q3 planning"', async () => {
    // The epic's own premise rendered: a note is DERIVED, and a row that only
    // said "from a transcript" would have thrown away the fact that makes it
    // trustworthy.
    renderNotes();
    await screen.findByText('Q3 planning — decisions');

    const link = await screen.findByRole('link', { name: 'Q3 planning' });
    expect(link).toHaveAttribute('href', '/transcripts/t1');
  });

  it('falls back to the category noun when the source cannot be named', async () => {
    // A source the caller can no longer read answers 404 — permanently, for
    // this user. The row must stay readable rather than show a uuid or an error.
    server.use(
      http.get(`${API_BASE}/transcripts/:id`, () => new HttpResponse(null, { status: 404 })),
    );
    renderNotes();

    expect(await screen.findByText('a transcript')).toBeInTheDocument();
  });

  it('shows progress for a note that is still being generated', async () => {
    respondWithNotes([
      noteItem({ id: 'n2', title: 'Being written', status: 'generating', excerpt: '' }),
    ]);
    renderNotes();

    expect(await screen.findByText('Being written')).toBeInTheDocument();
    expect(screen.getByText('Generating…')).toBeInTheDocument();
    expect(screen.getByLabelText('Generating Being written')).toBeInTheDocument();
  });

  it('offers a call to action when there are no notes at all', async () => {
    respondWithNotes([]);
    renderNotes();

    expect(await screen.findByText('No notes yet')).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /new note/i }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('offers a DIFFERENT empty state when a filter matched nothing', async () => {
    const user = userEvent.setup();
    respondWithNotes([]);
    renderNotes();
    await screen.findByText('No notes yet');

    await user.type(screen.getByLabelText('Search notes'), 'zzz');

    expect(
      await screen.findByText('No notes match those filters', undefined, { timeout: 3000 }),
    ).toBeInTheDocument();
  });

  it('translates the "Any status" sentinel into an OMITTED parameter', async () => {
    renderNotes();

    await waitFor(() => expect(noteRequests.length).toBeGreaterThan(0));
    expect(noteRequests[0].searchParams.has('status')).toBe(false);
  });

  it('sends the chosen status', async () => {
    const user = userEvent.setup();
    renderNotes();
    await waitFor(() => expect(noteRequests.length).toBeGreaterThan(0));

    await user.click(screen.getByLabelText('Status'));
    await user.click(await screen.findByRole('option', { name: 'Failed' }));

    await waitFor(() =>
      expect(noteRequests.some((url) => url.searchParams.get('status') === 'failed')).toBe(
        true,
      ),
    );
  });

  it('debounces the search box into a single q= query', async () => {
    const user = userEvent.setup();
    renderNotes();
    await waitFor(() => expect(noteRequests.length).toBeGreaterThan(0));
    const before = noteRequests.length;

    await user.type(screen.getByLabelText('Search notes'), 'budget');

    await waitFor(
      () => expect(noteRequests.some((url) => url.searchParams.get('q') === 'budget')).toBe(true),
      { timeout: 3000 },
    );
    expect(noteRequests.length - before).toBeLessThan(6);
  });

  it('offers Load more only while a cursor exists', async () => {
    respondWithNotes([noteItem()], 'cursor-2');
    renderNotes();

    expect(await screen.findByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('names the primary action for THIS page, not its sibling', async () => {
    // It read "for THIS tab" until #106, and the assertion is the same one:
    // `LibraryPageFrame` takes the action as a prop, so a page wired to the
    // wrong one would offer "New transcript" from `/notes`.
    renderNotes();
    await screen.findByText('Q3 planning — decisions');

    expect(screen.getByRole('button', { name: 'New note' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New transcript' }),
    ).not.toBeInTheDocument();
  });

  it('hides the create affordance from a user without notes:write', async () => {
    renderNotes({ ...mockAdminUser, permissions: ['notes:read'] });
    await screen.findByText('Q3 planning — decisions');

    expect(screen.queryByRole('button', { name: /new note/i })).not.toBeInTheDocument();
  });

  it('has no axe violations with rows', async () => {
    const { container } = renderNotes();
    await screen.findByText('Q3 planning — decisions');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme', async () => {
    // Both themes, per the issue's criterion.
    //
    // ⚠ THE THEME IS SET THROUGH `localStorage`, not through a render option.
    // `ThemeContextProvider` reads `theme_mode` synchronously in its `useState`
    // initializer, which is the only hook this suite has on it — the
    // `wrapperOptions.theme` field exists in the helper's type and is not read
    // by it, so passing it would render the LIGHT theme and quietly assert
    // nothing. Same approach `UserAiPage.test.tsx` takes.
    //
    // What this actually guards is that nothing about the dark render changes
    // the STRUCTURE (a themed component swapping an element or dropping a
    // label): `color-contrast` is the one rule jsdom cannot evaluate, so it is
    // off in `AXE_OPTIONS` for both themes.
    localStorage.setItem('theme_mode', 'dark');
    const { container } = render(<NotesPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/notes' },
    });
    await screen.findByText('Q3 planning — decisions');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations in the empty state', async () => {
    respondWithNotes([]);
    const { container } = renderNotes();
    await screen.findByText('No notes yet');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('gives the page a single h1, and it NAMES the page (#106)', async () => {
    renderNotes();
    await screen.findByText('Q3 planning — decisions');

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    // "Notes", not "Library". This view was a tab under a "Library" heading
    // between #57 and #106; it is a destination now and the heading says so.
    expect(headings[0]).toHaveTextContent('Notes');
  });

  it('renders NO Transcripts | Notes tab strip (#106)', async () => {
    // The assertion this file carries through the split, matched by
    // `TranscriptsPage.test.tsx`'s own. A leftover strip renders a working
    // page and passes every other test here.
    renderNotes();
    await screen.findByText('Q3 planning — decisions');

    expect(screen.queryByRole('tablist', { name: 'Library' })).toBeNull();
  });

/**
 * =============================================================================
 * THE RESULT COUNT LINE AND THE DATE SEPARATORS — issue #190
 * =============================================================================
 *
 * `TranscriptsPage.test.tsx`'s twin block; that file carries the reasoning.
 * These two surfaces are twins by design and the suites stay test-for-test
 * alike so a divergence shows up here.
 */
describe('NotesPage — result count and date groups', () => {
  it('says how many MATCH, not how many are on screen', async () => {
    respondWithNotes([noteItem()], 'cursor-2', 300);
    renderNotes();

    expect(await screen.findByText('300 notes')).toBeInTheDocument();
  });

  it('uses the singular for one', async () => {
    respondWithNotes([noteItem()], null, 1);
    renderNotes();

    expect(await screen.findByText('1 note')).toBeInTheDocument();
  });

  it('announces the count politely, so a search result is not silent', async () => {
    respondWithNotes([noteItem()], null, 7);
    renderNotes();
    const line = await screen.findByText('7 notes');

    expect(line.closest('[role="status"]')).not.toBeNull();
    expect(line.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('renders a date separator above the rows', async () => {
    respondWithNotes([noteItem({ updatedAt: new Date().toISOString() })], null, 1);
    renderNotes();
    await screen.findByText('Q3 planning — decisions');

    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it('keeps the separators OUT of the list semantics', async () => {
    respondWithNotes([noteItem({ updatedAt: new Date().toISOString() })], null, 1);
    renderNotes();
    const separator = await screen.findByText('Today');

    const li = separator.closest('li');
    expect(li).not.toBeNull();
    expect(li).toHaveAttribute('role', 'presentation');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });
});
});

/**
 * Deep links into this library — issue #170, epic #166.
 *
 * `TranscriptsPage.test.tsx`'s matching block, minus the `?scope` this library
 * has no tab for. The parsers themselves are pure and covered in
 * `notesLibraryPure.test.ts`; what is asserted here is the contract a link
 * relies on — that the seeded values reach the CONTROLS and the FIRST request,
 * not merely a later one.
 */
describe('NotesPage — seeded from the URL', () => {
  function renderAt(route: string) {
    return render(<NotesPage />, { wrapperOptions: { user: mockAdminUser, route } });
  }

  it('applies ?status=failed to the filter AND to the first query', async () => {
    renderAt('/notes?status=failed');

    expect(screen.getByLabelText('Status')).toHaveTextContent('Failed');
    await waitFor(() => expect(noteRequests.length).toBeGreaterThan(0));
    expect(noteRequests[0].searchParams.get('status')).toBe('failed');
  });

  it('falls back to Any status for an unknown ?status, and never sends it on', async () => {
    renderAt('/notes?status=bogus');

    expect(screen.getByLabelText('Status')).toHaveTextContent('Any status');
    await waitFor(() => expect(noteRequests.length).toBeGreaterThan(0));
    expect(noteRequests[0].searchParams.has('status')).toBe(false);
  });

  it('refuses ?status=draft, which is a real status this page does not offer', async () => {
    renderAt('/notes?status=draft');

    expect(screen.getByLabelText('Status')).toHaveTextContent('Any status');
    await waitFor(() => expect(noteRequests.length).toBeGreaterThan(0));
    expect(noteRequests[0].searchParams.has('status')).toBe(false);
  });

  it('fills the search box from ?q and filters the FIRST request with it', async () => {
    renderAt('/notes?q=budget');

    expect(screen.getByLabelText('Search notes')).toHaveValue('budget');
    await waitFor(() => expect(noteRequests.length).toBeGreaterThan(0));
    // ⚠ Not "eventually". A view that seeded only the box would fire an
    // unfiltered query first and replace it 300 ms later.
    expect(noteRequests[0].searchParams.get('q')).toBe('budget');
  });

  it('ignores ?scope entirely — this library has no scope to select', async () => {
    renderAt('/notes?scope=shared');

    await waitFor(() => expect(noteRequests.length).toBeGreaterThan(0));
    expect(noteRequests[0].searchParams.has('scope')).toBe(false);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('SEEDS the state without binding to it — a later change sticks', async () => {
    const user = userEvent.setup();
    renderAt('/notes?status=failed');
    await waitFor(() => expect(noteRequests.length).toBeGreaterThan(0));

    await user.click(screen.getByLabelText('Status'));
    await user.click(await screen.findByRole('option', { name: 'Any status' }));

    await waitFor(() =>
      expect(noteRequests[noteRequests.length - 1].searchParams.has('status')).toBe(false),
    );
  });
});
