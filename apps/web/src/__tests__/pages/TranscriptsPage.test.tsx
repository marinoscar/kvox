import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../mocks/server';
import { render, mockAdminUser, mockUser } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import TranscriptsPage from '../../pages/TranscriptsPage';
import type { TranscriptListItem } from '../../services/transcripts';

/**
 * `/transcripts`, over the REAL data hooks and MSW rather than mocked ones. The
 * thing most likely to be wrong here is the wiring between the scope tabs, the
 * filters and the queries the hooks actually issue — which a mocked hook would
 * assert nothing about.
 *
 * This file is the transcripts half of the deleted `LibraryPage.test.tsx`
 * (issue #106). The suites are #30's and #57's, unchanged except for what the
 * split genuinely moves: the page's own `h1` now reads "Transcripts" rather
 * than "Library", and the Transcripts | Notes tab strip that used to sit above
 * this view is gone — asserted explicitly below, because a strip left behind
 * would still render a working page and pass every other test here.
 *
 * ⚠ EVERY RENDER STILL NAMES `/transcripts`. It is no longer load-bearing for
 * tab selection — there is no tab to select — but the view's own Mine | Shared
 * strip and the row links are route-relative, so rendering outside the subtree
 * would be testing a page in a state the application cannot be in.
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

/** Record every list request, so the tab/filter wiring can be asserted. */
let requests: URL[] = [];

/**
 * And every `GET /api/search`, separately — issue #176, epic #164.
 *
 * ⚠ THE SEARCH BOX NO LONGER FILTERS THE LIST. A non-empty box renders
 * `GET /api/search` instead of the list, so a term is observable HERE and never
 * as a `q=` on `/transcripts`. The list's own `?q=` filter is untouched and
 * still works; this page simply stopped being the thing that calls it with a
 * term. The behaviour of the switch itself is covered in
 * `components/library/LibrarySearch.test.tsx`; what these assertions keep is
 * the property they always had — that a typed word becomes ONE request, and
 * that a `?q=` deep link filters the FIRST one.
 */
let searchRequests: URL[] = [];

function respondWith(
  items: TranscriptListItem[],
  nextCursor: string | null = null,
  // `total` defaults to the page's own length, which is right for every test
  // that is not about paging. A test that IS — one asserting the count line
  // over a feed with more pages behind it — passes the real figure.
  total: number = items.length,
) {
  server.use(
    http.get(`${API_BASE}/transcripts`, ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json({ data: { items, total, nextCursor } });
    }),
  );
}

function respondWithSearch(results: unknown[] = []) {
  server.use(
    http.get(`${API_BASE}/search`, ({ request }) => {
      searchRequests.push(new URL(request.url));
      return HttpResponse.json({
        data: {
          results,
          matchedDocuments: results.length,
          truncated: false,
          nextCursor: null,
          degraded: null,
          searchedTypes: ['transcript', 'note'],
        },
      });
    }),
  );
}

beforeEach(() => {
  // ⚠ `localStorage` IS NOT CLEARED BETWEEN TESTS by the global setup, and
  // `ThemeContextProvider` seeds itself from this key — so a dark-theme axe
  // test would leak its theme into every test after it in this file. Reset
  // explicitly rather than relying on declaration order.
  localStorage.setItem('theme_mode', 'light');
  requests = [];
  searchRequests = [];
  respondWith([item()]);
  respondWithSearch();
});

describe('TranscriptsPage — scope tabs', () => {
  it('renders Mine and Shared with me as parallel views', () => {
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    const tabs = screen.getByRole('tablist', { name: 'Transcript scope' });
    expect(within(tabs).getByRole('tab', { name: 'Mine' })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: 'Shared with me' })).toBeInTheDocument();
  });

  it('queries scope=owned first', async () => {
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].searchParams.get('scope')).toBe('owned');
  });

  it('re-queries with scope=shared when the second tab is selected', async () => {
    const user = userEvent.setup();
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));

    await user.click(screen.getByRole('tab', { name: 'Shared with me' }));

    await waitFor(() =>
      expect(requests.some((url) => url.searchParams.get('scope') === 'shared')).toBe(true),
    );
  });
});

describe('TranscriptsPage — rows', () => {
  it('shows the title, duration and speaker count', async () => {
    render(<TranscriptsPage />, {
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
    render(<TranscriptsPage />, {
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
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByText(/Processing · Preparing audio/)).toBeInTheDocument();
  });

  it('marks a failed transcript', async () => {
    respondWith([
      item({ status: 'failed', failureReason: 'The provider rejected the audio' }),
    ]);
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByText('Failed')).toBeInTheDocument();
  });
});

describe('TranscriptsPage — search and filter', () => {
  it('debounces the search box into a single q= query — now against /search (#176)', async () => {
    const user = userEvent.setup();
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    const listBefore = requests.length;

    await user.type(screen.getByLabelText('Search transcripts'), 'budget');

    await waitFor(
      () =>
        expect(searchRequests.some((url) => url.searchParams.get('q') === 'budget')).toBe(true),
      { timeout: 3000 },
    );
    // Six keystrokes must not be six ranked full-text queries.
    expect(searchRequests.length).toBeLessThan(6);
    // …and the list is not re-queried at all while the box is driving a search.
    expect(requests.length).toBe(listBefore);
  });

  it('translates the "Any status" sentinel into an OMITTED parameter', async () => {
    // `status=all` is a UI value the API knows nothing about; it filters by
    // omitting the parameter.
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].searchParams.has('status')).toBe(false);
  });

  it('sends the chosen status', async () => {
    const user = userEvent.setup();
    render(<TranscriptsPage />, {
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

describe('TranscriptsPage — empty states', () => {
  it('offers a call to action when the library is genuinely empty', async () => {
    respondWith([]);
    render(<TranscriptsPage />, {
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
    // filter that matched none of it.
    //
    // ⚠ DRIVEN BY THE STATUS FILTER since #176, not by the search box: a term
    // in the box renders `SearchResultsView` and ITS "No matches for …" panel
    // instead of this one. That is the distinction the issue exists to draw —
    // see `components/library/LibrarySearch.test.tsx`, which asserts the two
    // panels are never confused for one another.
    const user = userEvent.setup();
    respondWith([]);
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('No transcripts yet');

    await user.click(screen.getByLabelText('Status'));
    await user.click(await screen.findByRole('option', { name: 'Failed' }));

    expect(
      await screen.findByText('No transcripts match those filters', undefined, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
  });

  it('offers a third empty state on the Shared tab', async () => {
    const user = userEvent.setup();
    respondWith([]);
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('No transcripts yet');

    await user.click(screen.getByRole('tab', { name: 'Shared with me' }));

    expect(
      await screen.findByText('Nothing has been shared with you yet'),
    ).toBeInTheDocument();
  });
});

describe('TranscriptsPage — the create affordance', () => {
  it('shows a header button at desktop width', async () => {
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByRole('button', { name: 'New transcript' })).toBeInTheDocument();
  });

  it('shows a FAB instead at phone width', async () => {
    // A floating control on a laptop covers content for no reason; on a phone
    // it is the only way to keep the primary action reachable.
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await act(async () => setViewportWidth(375));

    const fab = await screen.findByRole('button', { name: 'New transcript' });
    expect(fab).toBeInTheDocument();
  });

  it('hides it entirely from a user without transcripts:write', async () => {
    // `mockUser` holds only the two `user_settings` permissions.
    render(<TranscriptsPage />, { wrapperOptions: { user: mockUser, route: '/transcripts' } });
    await screen.findByText('Weekly standup');

    expect(
      screen.queryByRole('button', { name: /new transcript/i }),
    ).not.toBeInTheDocument();
  });
});

describe('TranscriptsPage — paging', () => {
  it('offers Load more only while a cursor exists', async () => {
    respondWith([item()], 'cursor-2');
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('offers no Load more at the end of the list', async () => {
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');

    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

/**
 * =============================================================================
 * THE RESULT COUNT LINE AND THE DATE SEPARATORS — issue #190
 * =============================================================================
 *
 * Epic #162 reduces the filter bar to one search box, which makes this line the
 * only feedback a search gives beyond the rows themselves — so its wording, its
 * live region, and the fact that it counts MATCHES rather than LOADED ROWS are
 * all load-bearing rather than decorative.
 *
 * The separators are asserted through the axe pass as much as through their
 * text: they are `role="presentation"` `<li>`s inside the feed's one `<ul>`, and
 * the thing that would break is the list semantics for all 300 rows, not the
 * heading itself.
 */
describe('TranscriptsPage — result count and date groups', () => {
  it('says how many MATCH, not how many are on screen', async () => {
    // One page of one row out of 300. A count derived from the rows would say
    // "1 transcript" under a list the user can page through 15 more times.
    respondWith([item()], 'cursor-2', 300);
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByText('300 transcripts')).toBeInTheDocument();
  });

  it('uses the singular for one', async () => {
    respondWith([item()], null, 1);
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    expect(await screen.findByText('1 transcript')).toBeInTheDocument();
  });

  it('announces the count politely, so a search result is not silent', async () => {
    respondWith([item()], null, 7);
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    const line = await screen.findByText('7 transcripts');

    expect(line.closest('[role="status"]')).not.toBeNull();
    expect(line.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('renders a date separator above the rows', async () => {
    respondWith([item({ updatedAt: new Date().toISOString() })], null, 1);
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');

    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it('keeps the separators OUT of the list semantics', async () => {
    // `role="presentation"` on the separator `<li>` is what stops a screen
    // reader announcing "list, 300 items" when 30 of those are headings, and
    // what avoids a heading level between the page `h1` and each row `h2`.
    respondWith([item({ updatedAt: new Date().toISOString() })], null, 1);
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    const separator = await screen.findByText('Today');

    const li = separator.closest('li');
    expect(li).not.toBeNull();
    expect(li).toHaveAttribute('role', 'presentation');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('has no axe violations with a separator present', async () => {
    respondWith([item({ updatedAt: new Date().toISOString() })], null, 1);
    const { container } = render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('TranscriptsPage — accessibility', () => {
  it('has no axe violations with rows', async () => {
    const { container } = render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations in the empty state', async () => {
    respondWith([]);
    const { container } = render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('No transcripts yet');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations on the Transcripts tab in the dark theme', async () => {
    // See the Notes tab's own dark pass for why the theme is set this way.
    localStorage.setItem('theme_mode', 'dark');
    const { container } = render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations at phone width, where the FAB is mounted', async () => {
    const { container } = render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');
    await act(async () => setViewportWidth(375));

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('gives the page a single h1, and it NAMES the page (#106)', async () => {
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    // "Transcripts", not "Library". Between #57 and #106 this heading read
    // "Library" and naming one tab would have been a page claiming to be
    // something it was only half of. The tab strip is gone, so the page IS this
    // view and the heading says so.
    expect(headings[0]).toHaveTextContent('Transcripts');
  });

  it('renders NO Transcripts | Notes tab strip (#106)', async () => {
    // The assertion this file exists to carry through the split. A leftover
    // strip renders a perfectly working page and passes every other test here,
    // so nothing else in this file would notice it.
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });
    await screen.findByText('Weekly standup');

    expect(screen.queryByRole('tablist', { name: 'Library' })).toBeNull();
    // …and the view's OWN strip is untouched: this is a deletion of one tab
    // pair, not of tabs.
    expect(screen.getByRole('tablist', { name: 'Transcript scope' })).toBeInTheDocument();
  });
});


/**
 * Deep links into this library — issue #170, epic #166.
 *
 * The home page's counts strip builds `?scope=shared` and `?status=failed`, so
 * the assertions below are about the CONTRACT those links rely on rather than
 * about the parsers themselves, which are pure and covered in
 * `notesLibraryPure.test.ts` without mounting anything.
 *
 * ⚠ THE FIRST REQUEST IS THE ONE THAT MATTERS, hence `requests[0]` throughout.
 * A view that seeded only its visible controls and let the filters arrive on a
 * later render would pass a "the list is eventually filtered" assertion while
 * still firing an unfiltered query first — the exact behaviour `debouncedSearch`
 * is seeded to prevent.
 */
describe('TranscriptsPage — seeded from the URL', () => {
  it('opens on the Shared with me tab for ?scope=shared', async () => {
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts?scope=shared' },
    });

    expect(screen.getByRole('tab', { name: 'Shared with me' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].searchParams.get('scope')).toBe('shared');
  });

  it('opens on Mine for ?scope=owned', async () => {
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts?scope=owned' },
    });

    expect(screen.getByRole('tab', { name: 'Mine' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].searchParams.get('scope')).toBe('owned');
  });

  it('applies ?status=failed to the filter AND to the first query', async () => {
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts?status=failed' },
    });

    expect(screen.getByLabelText('Status')).toHaveTextContent('Failed');
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].searchParams.get('status')).toBe('failed');
  });

  it('falls back to Any status for an unknown ?status, and never sends it on', async () => {
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts?status=bogus' },
    });

    expect(screen.getByLabelText('Status')).toHaveTextContent('Any status');
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].searchParams.get('status')).toBeNull();
  });

  it('fills the search box from ?q and filters the FIRST SEARCH request with it', async () => {
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts?q=budget' },
    });

    expect(screen.getByLabelText('Search transcripts')).toHaveValue('budget');
    // ⚠ Not "eventually" — the first one. See this block's header. Since #176
    // the request a term lands on is `/search`, and the flash that assertion
    // guards against is prevented differently: the view is in search mode on
    // its FIRST render, showing a spinner, so there is no unfiltered answer to
    // render and replace.
    await waitFor(() => expect(searchRequests.length).toBeGreaterThan(0));
    expect(searchRequests[0].searchParams.get('q')).toBe('budget');
    expect(searchRequests[0].searchParams.get('types')).toBe('transcript');
    expect(requests.every((url) => url.searchParams.get('q') === null)).toBe(true);
  });

  it('reads all three at once', async () => {
    render(<TranscriptsPage />, {
      wrapperOptions: {
        user: mockAdminUser,
        route: '/transcripts?scope=shared&status=failed&q=budget',
      },
    });

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].searchParams.get('scope')).toBe('shared');
    expect(requests[0].searchParams.get('status')).toBe('failed');
    // `q` went to the search endpoint instead — see the test above.
    await waitFor(() => expect(searchRequests.length).toBeGreaterThan(0));
    expect(searchRequests[0].searchParams.get('q')).toBe('budget');
  });

  it('starts unfiltered when the URL carries nothing', async () => {
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts' },
    });

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].searchParams.get('status')).toBeNull();
    expect(requests[0].searchParams.get('q')).toBeNull();
  });

  it('SEEDS the state without binding to it — a later change sticks', async () => {
    // The decision this records: the URL is an entry point, not a two-way
    // binding. Switching tabs after arriving on `?scope=shared` must move the
    // view, and must not be undone by the query string it arrived with.
    const user = userEvent.setup();
    render(<TranscriptsPage />, {
      wrapperOptions: { user: mockAdminUser, route: '/transcripts?scope=shared' },
    });
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));

    await user.click(screen.getByRole('tab', { name: 'Mine' }));

    await waitFor(() =>
      expect(requests[requests.length - 1].searchParams.get('scope')).toBe('owned'),
    );
    expect(screen.getByRole('tab', { name: 'Mine' })).toHaveAttribute('aria-selected', 'true');
  });
});
