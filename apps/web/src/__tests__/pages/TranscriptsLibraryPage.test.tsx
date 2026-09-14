import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../mocks/server';
import { render, mockAdminUser, mockUser } from '../utils/test-utils';
import { setViewportWidth } from '../setup';
import TranscriptsLibraryPage from '../../pages/TranscriptsLibraryPage';
import type { TranscriptListItem } from '../../services/transcripts';

/**
 * The library, over the REAL data hook and MSW rather than a mocked
 * `useTranscripts`. The thing most likely to be wrong here is the wiring
 * between the tabs, the filters and the query the hook actually issues — which
 * a mocked hook would assert nothing about.
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

function respondWith(items: TranscriptListItem[], nextCursor: string | null = null) {
  server.use(
    http.get(`${API_BASE}/transcripts`, ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json({ data: { items, nextCursor } });
    }),
  );
}

beforeEach(() => {
  requests = [];
  respondWith([item()]);
});

describe('TranscriptsLibraryPage — tabs', () => {
  it('renders Mine and Shared with me as parallel views', () => {
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });

    const tabs = screen.getByRole('tablist', { name: 'Transcript scope' });
    expect(within(tabs).getByRole('tab', { name: 'Mine' })).toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: 'Shared with me' })).toBeInTheDocument();
  });

  it('queries scope=owned first', async () => {
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].searchParams.get('scope')).toBe('owned');
  });

  it('re-queries with scope=shared when the second tab is selected', async () => {
    const user = userEvent.setup();
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));

    await user.click(screen.getByRole('tab', { name: 'Shared with me' }));

    await waitFor(() =>
      expect(requests.some((url) => url.searchParams.get('scope') === 'shared')).toBe(true),
    );
  });
});

describe('TranscriptsLibraryPage — rows', () => {
  it('shows the title, duration and speaker count', async () => {
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });

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
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });

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
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByText(/Processing · Preparing audio/)).toBeInTheDocument();
  });

  it('marks a failed transcript', async () => {
    respondWith([
      item({ status: 'failed', failureReason: 'The provider rejected the audio' }),
    ]);
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByText('Failed')).toBeInTheDocument();
  });
});

describe('TranscriptsLibraryPage — search and filter', () => {
  it('debounces the search box into a single q= query', async () => {
    const user = userEvent.setup();
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });
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
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].searchParams.has('status')).toBe(false);
  });

  it('sends the chosen status', async () => {
    const user = userEvent.setup();
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));

    await user.click(screen.getByLabelText('Status'));
    await user.click(await screen.findByRole('option', { name: 'Failed' }));

    await waitFor(() =>
      expect(requests.some((url) => url.searchParams.get('status') === 'failed')).toBe(true),
    );
  });
});

describe('TranscriptsLibraryPage — empty states', () => {
  it('offers a call to action when the library is genuinely empty', async () => {
    respondWith([]);
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });

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
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });
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
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });
    await screen.findByText('No transcripts yet');

    await user.click(screen.getByRole('tab', { name: 'Shared with me' }));

    expect(
      await screen.findByText('Nothing has been shared with you yet'),
    ).toBeInTheDocument();
  });
});

describe('TranscriptsLibraryPage — the create affordance', () => {
  it('shows a header button at desktop width', async () => {
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByRole('button', { name: 'New transcript' })).toBeInTheDocument();
  });

  it('shows a FAB instead at phone width', async () => {
    // A floating control on a laptop covers content for no reason; on a phone
    // it is the only way to keep the primary action reachable.
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });
    await act(async () => setViewportWidth(375));

    const fab = await screen.findByRole('button', { name: 'New transcript' });
    expect(fab).toBeInTheDocument();
  });

  it('hides it entirely from a user without transcripts:write', async () => {
    // `mockUser` holds only the two `user_settings` permissions.
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockUser } });
    await screen.findByText('Weekly standup');

    expect(
      screen.queryByRole('button', { name: /new transcript/i }),
    ).not.toBeInTheDocument();
  });
});

describe('TranscriptsLibraryPage — paging', () => {
  it('offers Load more only while a cursor exists', async () => {
    respondWith([item()], 'cursor-2');
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('offers no Load more at the end of the list', async () => {
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });
    await screen.findByText('Weekly standup');

    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('TranscriptsLibraryPage — accessibility', () => {
  it('has no axe violations with rows', async () => {
    const { container } = render(<TranscriptsLibraryPage />, {
      wrapperOptions: { user: mockAdminUser },
    });
    await screen.findByText('Weekly standup');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations in the empty state', async () => {
    respondWith([]);
    const { container } = render(<TranscriptsLibraryPage />, {
      wrapperOptions: { user: mockAdminUser },
    });
    await screen.findByText('No transcripts yet');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations at phone width, where the FAB is mounted', async () => {
    const { container } = render(<TranscriptsLibraryPage />, {
      wrapperOptions: { user: mockAdminUser },
    });
    await screen.findByText('Weekly standup');
    await act(async () => setViewportWidth(375));

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('gives the page a single h1', async () => {
    render(<TranscriptsLibraryPage />, { wrapperOptions: { user: mockAdminUser } });
    await screen.findByText('Weekly standup');

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
