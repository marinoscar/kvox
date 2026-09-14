import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../mocks/server';
import { render, mockAdminUser, mockUser } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import LibraryPage from '../../pages/LibraryPage';
import { clearNoteSourceNameCache } from '../../hooks/useNoteSourceNames';
import type { TranscriptListItem } from '../../services/transcripts';
import type { NoteListItem } from '../../services/notes';

/**
 * The library, over the REAL data hooks and MSW rather than mocked ones. The
 * thing most likely to be wrong here is the wiring between the tabs, the
 * filters and the queries the hooks actually issue — which a mocked hook would
 * assert nothing about.
 *
 * ⚠ EVERY RENDER NAMES A ROUTE, and that is the point of #57 rather than
 * boilerplate: the Transcripts | Notes tab IS the URL (`pages/libraryTabs.ts`),
 * so a test that did not say which path it was on would be testing a page in a
 * state the application cannot be in.
 */

const API_BASE = 'http://localhost:3000/api';

/**
 * jsdom performs no layout, so `color-contrast` cannot resolve an element's
 * effective background and is a well-known false-negative trap here. Every
 * other rule runs at full strength — the same posture, and the same reasoning,
 * as the DataTable conformance suite's own axe pass.
 */
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function item(overrides: Partial<TranscriptListItem> = {}): TranscriptListItem {
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
    currentGenerationId: 'gen-1',
    failureReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Record every list request, so the tab/filter wiring can be asserted. */
let requests: URL[] = [];
/** The same, for `GET /api/notes`. Kept separate so one tab cannot mask the other. */
let noteRequests: URL[] = [];

function respondWith(items: TranscriptListItem[], nextCursor: string | null = null) {
  server.use(
    http.get(`${API_BASE}/transcripts`, ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json({ data: { items, nextCursor } });
    }),
  );
}

function respondWithNotes(items: NoteListItem[], nextCursor: string | null = null) {
  server.use(
    http.get(`${API_BASE}/notes`, ({ request }) => {
      noteRequests.push(new URL(request.url));
      return HttpResponse.json({ data: { items, nextCursor } });
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
  requests = [];
  noteRequests = [];
  // The source-name cache is module-level and lives for the tab, deliberately
  // (see `useNoteSourceNames`) — which in a test file means it lives for the
  // whole FILE unless cleared, and one suite's fixture would silently satisfy
  // the next suite's assertion.
  clearNoteSourceNameCache();
  respondWith([item()]);
  respondWithNotes([noteItem()]);
});

describe('LibraryPage — tabs', () => {
  it('renders Mine and Shared with me as parallel views', () => {
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    const tabs = screen.getByRole('tablist', { name: 'Transcript scope' });
    expect(within(tabs).getByRole('tab', { name: 'Mine' })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: 'Shared with me' })).toBeInTheDocument();
  });

  it('queries scope=owned first', async () => {
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].searchParams.get('scope')).toBe('owned');
  });

  it('re-queries with scope=shared when the second tab is selected', async () => {
    const user = userEvent.setup();
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));

    await user.click(screen.getByRole('tab', { name: 'Shared with me' }));

    await waitFor(() =>
      expect(requests.some((url) => url.searchParams.get('scope') === 'shared')).toBe(true),
    );
  });
});

describe('LibraryPage — rows', () => {
  it('shows the title, duration and speaker count', async () => {
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByText('Weekly standup')).toBeInTheDocument();
    expect(screen.getByText(/15 min/)).toBeInTheDocument();
    expect(screen.getByText(/3 speakers/)).toBeInTheDocument();
  });

  it('says which STAGE a processing transcript is in, not just "Processing"', async () => {
    // A user watching a recording being transcribed is watching this chip.
    // "Processing" alone answers none of the questions they actually have.
    respondWith([
      item({ status: 'processing', transcriptionStatus: 'processing', playbackStatus: 'ready' }),
    ]);
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByText(/Processing · Transcribing/)).toBeInTheDocument();
  });

  it('reports the transcode stage while only the audio is still being prepared', async () => {
    respondWith([
      item({
        status: 'processing',
        transcriptionStatus: 'waiting_input',
        playbackStatus: 'processing',
      }),
    ]);
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByText(/Processing · Preparing audio/)).toBeInTheDocument();
  });

  it('marks a failed transcript', async () => {
    respondWith([
      item({ status: 'failed', failureReason: 'The provider rejected the audio' }),
    ]);
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByText('Failed')).toBeInTheDocument();
  });
});

describe('LibraryPage — search and filter', () => {
  it('debounces the search box into a single q= query', async () => {
    const user = userEvent.setup();
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    const before = requests.length;

    await user.type(screen.getByLabelText('Search titles'), 'budget');

    await waitFor(
      () => expect(requests.some((url) => url.searchParams.get('q') === 'budget')).toBe(true),
      { timeout: 3000 },
    );
    // Six keystrokes must not be six queries against a `LIKE` on the column the
    // list is also ordered by.
    expect(requests.length - before).toBeLessThan(6);
  });

  it('translates the "Any status" sentinel into an OMITTED parameter', async () => {
    // `status=all` is a UI value the API knows nothing about; it filters by
    // omitting the parameter.
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].searchParams.has('status')).toBe(false);
  });

  it('sends the chosen status', async () => {
    const user = userEvent.setup();
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));

    await user.click(screen.getByLabelText('Status'));
    await user.click(await screen.findByRole('option', { name: 'Failed' }));

    await waitFor(() =>
      expect(requests.some((url) => url.searchParams.get('status') === 'failed')).toBe(true),
    );
  });
});

describe('LibraryPage — empty states', () => {
  it('offers a call to action when the library is genuinely empty', async () => {
    respondWith([]);
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByText('No transcripts yet')).toBeInTheDocument();
    // TWO controls named the same thing at desktop width — the header button
    // and the empty state's own call to action — which is deliberate: the
    // empty state has to carry the action, because a header button above an
    // explanatory panel is not where the reader is looking.
    expect(
      screen.getAllByRole('button', { name: /new transcript/i }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('offers a DIFFERENT empty state when a filter matched nothing', async () => {
    // "Upload a recording" is nonsense advice for a library that is full and a
    // search term that matched none of it.
    const user = userEvent.setup();
    respondWith([]);
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('No transcripts yet');

    await user.type(screen.getByLabelText('Search titles'), 'zzz');

    expect(
      await screen.findByText('No transcripts match those filters', undefined, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
  });

  it('offers a third empty state on the Shared tab', async () => {
    const user = userEvent.setup();
    respondWith([]);
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('No transcripts yet');

    await user.click(screen.getByRole('tab', { name: 'Shared with me' }));

    expect(
      await screen.findByText('Nothing has been shared with you yet'),
    ).toBeInTheDocument();
  });
});

describe('LibraryPage — the create affordance', () => {
  it('shows a header button at desktop width', async () => {
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByRole('button', { name: 'New transcript' })).toBeInTheDocument();
  });

  it('shows a FAB instead at phone width', async () => {
    // A floating control on a laptop covers content for no reason; on a phone
    // it is the only way to keep the primary action reachable.
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await act(async () => setViewportWidth(375));

    const fab = await screen.findByRole('button', { name: 'New transcript' });
    expect(fab).toBeInTheDocument();
  });

  it('hides it entirely from a user without transcripts:write', async () => {
    // `mockUser` holds only the two `user_settings` permissions.
    render(<LibraryPage />, { wrapperOptions: { user: mockUser, route: '/transcripts' } });
    await screen.findByText('Weekly standup');

    expect(
      screen.queryByRole('button', { name: /new transcript/i }),
    ).not.toBeInTheDocument();
  });
});

describe('LibraryPage — paging', () => {
  it('offers Load more only while a cursor exists', async () => {
    respondWith([item()], 'cursor-2');
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('offers no Load more at the end of the list', async () => {
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');

    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('LibraryPage — accessibility', () => {
  it('has no axe violations with rows', async () => {
    const { container } = render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations in the empty state', async () => {
    respondWith([]);
    const { container } = render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('No transcripts yet');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations on the Transcripts tab in the dark theme', async () => {
    // See the Notes tab's own dark pass for why the theme is set this way.
    localStorage.setItem('theme_mode', 'dark');
    const { container } = render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations at phone width, where the FAB is mounted', async () => {
    const { container } = render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');
    await act(async () => setViewportWidth(375));

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('gives the page a single h1, and it is the LIBRARY rather than one tab', async () => {
    render(<LibraryPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    // Not "Transcripts": the page is the library and Transcripts is one of its
    // two tabs. A page heading naming one tab is a page that claims to be
    // something it is only half of.
    expect(headings[0]).toHaveTextContent('Library');
  });
});

/**
 * Issue #57's central claim: the Transcripts | Notes tab is the URL, not
 * component state. Everything in this suite is a property a `useState` tab
 * would silently get wrong — a deep link landing on the wrong tab, a reload
 * resetting it, Back leaving the strip out of step with the address bar.
 */
describe('LibraryPage — the tab is the URL', () => {
  /** Renders the live pathname, so the assertions can read the address bar. */
  function Probe() {
    const { pathname } = useLocation();
    return <span data-testid="pathname">{pathname}</span>;
  }

  function renderAt(route: string) {
    return render(
      <>
        <LibraryPage />
        <Probe />
      </>,
      { wrapperOptions: { user: mockAdminUser, route } },
    );
  }

  it('selects Transcripts on /transcripts', async () => {
    renderAt('/transcripts');

    const tabs = screen.getByRole('tablist', { name: 'Library' });
    expect(within(tabs).getByRole('tab', { name: 'Transcripts' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByText('Weekly standup')).toBeInTheDocument();
  });

  it('selects Notes on a DEEP LINK to /notes, with no click first', async () => {
    // The case state-plus-effect gets wrong: it renders the transcripts tab for
    // a frame and then jumps, and a user who followed a link to their notes
    // watches the wrong list flash past.
    renderAt('/notes');

    const tabs = screen.getByRole('tablist', { name: 'Library' });
    expect(within(tabs).getByRole('tab', { name: 'Notes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByText('Q3 planning — decisions')).toBeInTheDocument();
    // …and it did not also fetch the transcripts list to render a tab nobody
    // asked for.
    expect(requests).toHaveLength(0);
  });

  it('survives a RELOAD, because a reload is just the same URL again', async () => {
    // A remount with the same entry is exactly what a reload is from this
    // component's point of view, and it is the scenario where a state-held tab
    // reverts to whatever its initializer said.
    const first = renderAt('/notes');
    expect(await screen.findByText('Q3 planning — decisions')).toBeInTheDocument();
    first.unmount();

    renderAt('/notes');
    expect(await screen.findByText('Q3 planning — decisions')).toBeInTheDocument();
    expect(
      within(screen.getByRole('tablist', { name: 'Library' })).getByRole('tab', {
        name: 'Notes',
      }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  it('puts the tab in the URL when one is clicked, rather than only in state', async () => {
    const user = userEvent.setup();
    renderAt('/transcripts');
    expect(screen.getByTestId('pathname')).toHaveTextContent('/transcripts');

    await user.click(screen.getByRole('tab', { name: 'Notes' }));

    // THE ASSERTION THIS SUITE EXISTS FOR. A tab that only changed the rendered
    // list would pass every other test here and fail this one.
    await waitFor(() => expect(screen.getByTestId('pathname')).toHaveTextContent('/notes'));
    expect(await screen.findByText('Q3 planning — decisions')).toBeInTheDocument();
  });

  it('goes back to /transcripts when the first tab is clicked again', async () => {
    const user = userEvent.setup();
    renderAt('/notes');
    await screen.findByText('Q3 planning — decisions');

    await user.click(screen.getByRole('tab', { name: 'Transcripts' }));

    await waitFor(() =>
      expect(screen.getByTestId('pathname')).toHaveTextContent('/transcripts'),
    );
    expect(await screen.findByText('Weekly standup')).toBeInTheDocument();
  });

  it('shows only the tabs the user can actually open', async () => {
    // Reachability is the destination's job (`anyPermission` on `library`);
    // WHICH tabs is this page's. A tab a click would bounce off is worse than
    // no tab at all.
    render(<LibraryPage />, {
      wrapperOptions: {
        user: { ...mockAdminUser, permissions: ['notes:read'] },
        route: '/notes',
      },
    });

    const tabs = screen.getByRole('tablist', { name: 'Library' });
    expect(within(tabs).getByRole('tab', { name: 'Notes' })).toBeInTheDocument();
    expect(within(tabs).queryByRole('tab', { name: 'Transcripts' })).not.toBeInTheDocument();
  });
});

describe('LibraryPage — the Notes tab', () => {
  function renderNotes(user = mockAdminUser) {
    return render(<LibraryPage />, { wrapperOptions: { user, route: '/notes' } });
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

  it('names the primary action for THIS tab, not the other one', async () => {
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
    const { container } = render(<LibraryPage />, {
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
});
