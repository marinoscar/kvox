import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { TAGLINE } from '@app/shared';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useUploadManager', () => ({ useUploadManager: vi.fn() }));

import { server } from '../mocks/server';
import { render, mockAdminUser, mockUser, type MockUser } from '../utils/test-utils';
import HomePage from '../../pages/HomePage';
import { useUploadManager } from '../../hooks/useUploadManager';
import type { NoteSummary } from '../../services/notes';
import type { TranscriptSummary } from '../../services/transcripts';
import type { TranscriptionConfig } from '../../services/transcription';
import {
  AXE_OPTIONS,
  TRANSCRIPTION_AVAILABLE,
  TRANSCRIPTION_UNAVAILABLE,
  homeUser,
  manager,
  noNotesUser,
  note,
  noteSummary,
  session,
  summary,
  transcript,
  upload,
} from '../components/home/homeFixtures';

/**
 * The signed-in home page, over the REAL data hooks and MSW.
 *
 * Not a mocked `useTranscriptSummary`/`useNoteSummary`: the thing most likely
 * to be wrong on this page is the wiring between ONE SUMMARY REQUEST PER
 * CONTENT TYPE, the capability probe that runs beside them, and which of the
 * six sections that combination is supposed to render — and mocked hooks assert
 * nothing about any of it.
 *
 * `useUploadManager` IS mocked, for the reason its own header gives: it owns
 * `XMLHttpRequest`s, IndexedDB sessions and a wake lock, none of which this
 * page's behaviour depends on.
 */

const API_BASE = 'http://localhost:3000/api';

const mockUseUploadManager = vi.mocked(useUploadManager);

/**
 * Every summary request this render made, per content type.
 *
 * TWO COUNTERS, not one: the page's rule is "one request PER CONTENT TYPE",
 * which a single total cannot distinguish from "two requests for transcripts
 * and none for notes".
 */
let summaryRequests = 0;
let noteSummaryRequests = 0;

/**
 * When each summary request STARTED, relative to the first of them.
 *
 * Recorded because "fired in parallel" is a claim about ordering that a call
 * count cannot make: a page that awaited the transcript summary before asking
 * for notes would produce exactly the same two counts.
 */
let requestOrder: string[] = [];

/**
 * EVERY path this render touched, whoever made the request — issue #170, epic
 * #166.
 *
 * `summaryRequests` and `noteSummaryRequests` are per endpoint and only count
 * the two routes this file installs handlers for, so they can only ever say
 * "the two I know about answered once each": a section that grew a fetch of
 * its own would be invisible to them — it would hit a default handler in
 * `mocks/handlers.ts`, answer 200, and both counters would still read 1. This
 * listener is attached to MSW itself, so it sees the ACTUAL network the page
 * produces, which is what the page's one-request-per-content-type rule is a
 * claim about, and it is the only way to assert that a new section added no
 * fourth call of its own.
 */
const observedRequests: string[] = [];
server.events.on('request:start', ({ request }) => {
  observedRequests.push(new URL(request.url).pathname);
});

/**
 * ⚠ THIS IS THE FILE'S ONE AND ONLY REQUEST OBSERVER, REGISTERED ONCE AT
 * MODULE SCOPE AND NEVER TORN DOWN.
 *
 * A test must NEVER declare a second `request:start` listener of its own, and
 * must NEVER call `server.events.removeAllListeners()`. Two suites here
 * used to attach their own listener and remove all of them again in a
 * `finally` — which removes EVERY listener on the shared server, including the
 * one above, so `observedRequests` silently stops collecting anything for every
 * test that runs afterward. The assertion then either passes vacuously against
 * an empty array or fails in a way that looks unrelated to this file. If a test
 * needs a request log of its own, read `observedRequests` (emptied every test
 * in `respondWith`, called from the one outer `beforeEach` below) instead of
 * registering a second listener.
 */

/**
 * The three calls a home-page load is allowed to make, sorted — and no fourth.
 *
 * One summary per CONTENT TYPE plus the one deployment capability probe — the
 * rule `HomePage`'s header states. Every section on this page renders from what
 * these already returned, so this list growing is the review question, not an
 * incidental detail of whichever test noticed.
 *
 * ⚠ THE HAZARD THIS PARAGRAPH USED TO DESCRIBE IS GONE — issue #192, and the
 * history is worth keeping because it explains why this constant is policed so
 * hard. `RecentNotes` used to hand `notes.recent` straight to
 * `useNoteSourceNames`, an ASYNC lookup firing its OWN `GET
 * /api/transcripts/:id` per distinct source a recent note named. That was a
 * genuine fourth request, and it was INTERMITTENT: it passed locally and on
 * most CI shards because the lookup usually had not started before the
 * assertion ran, and failed once it had — exactly as it did in PR #205.
 *
 * #192 denormalises `sourceName` onto every note row, so the lookup and its
 * hook are deleted and no fixture's `notes.recent` can add a request here any
 * more. The rule this paragraph replaces is therefore no longer a constraint on
 * fixtures; the rule that REMAINS is the one above: this list growing is a
 * review question, and it is never to be loosened to accommodate a page that
 * started fetching more.
 */
const EXPECTED_REQUESTS = [
  '/api/notes/summary',
  '/api/transcription/config',
  '/api/transcripts/summary',
];

interface RespondOptions {
  config?: TranscriptionConfig;
  notes?: NoteSummary;
  /** Resolve the transcript summary only when this settles — for the race test. */
  gate?: Promise<void>;
}

function respondWith(data: TranscriptSummary, options: RespondOptions = {}) {
  const { config = TRANSCRIPTION_AVAILABLE, notes = noteSummary(), gate } = options;
  summaryRequests = 0;
  noteSummaryRequests = 0;
  requestOrder = [];
  observedRequests.length = 0;
  server.use(
    http.get(`${API_BASE}/transcripts/summary`, async () => {
      summaryRequests += 1;
      requestOrder.push('transcripts');
      if (gate) await gate;
      return HttpResponse.json({ data });
    }),
    // ⚠ BEFORE any `/notes/:id` route, always: `summary` is a legal note id as
    // far as a path pattern is concerned.
    http.get(`${API_BASE}/notes/summary`, () => {
      noteSummaryRequests += 1;
      requestOrder.push('notes');
      return HttpResponse.json({ data: notes });
    }),
    http.get(`${API_BASE}/transcription/config`, () => HttpResponse.json({ data: config })),
  );
}

function renderHome(user: MockUser = homeUser) {
  return render(<HomePage />, { wrapperOptions: { user } });
}

/** The greeting only appears once the first summary read has settled. */
async function waitForLoaded() {
  await screen.findByRole('heading', { level: 1 });
}

beforeEach(() => {
  mockNavigate.mockClear();
  observedRequests.length = 0;
  mockUseUploadManager.mockReturnValue(manager());
  // Module-level and shared by every mount, so it would otherwise leak resolved
  // source names (and resolved negatives) between the suites below.
  // `respondWith` resets `observedRequests.length = 0` (among the other
  // counters) and runs before every test in every `describe` block below,
  // because this is the file's OUTER `beforeEach` — Vitest runs it ahead of
  // any nested `describe`'s own `beforeEach`, which may call `respondWith`
  // again but never skips this one. Without that reset, `observedRequests`
  // would just keep growing across the whole file and an assertion like
  // `expect(observedRequests).toHaveLength(3)` would be meaningless past the
  // first test that reads it.
  respondWith(summary({ recent: [transcript()] }));
});

// =============================================================================
// Loading
// =============================================================================

describe('HomePage — while the summary is loading', () => {
  it('shows a skeleton rather than a spinner', () => {
    // This is the app's landing screen: its loading frame is the most-seen
    // frame in the product, and a spinner throws the layout away and rebuilds
    // it a moment later.
    renderHome();

    expect(screen.getByLabelText('Loading your transcripts')).toBeInTheDocument();
  });

  it('marks the skeleton busy for assistive technology', () => {
    renderHome();

    expect(screen.getByLabelText('Loading your transcripts')).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('shows no greeting until the data has landed', () => {
    renderHome();

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('replaces the skeleton once the summary answers', async () => {
    renderHome();

    await waitForElementToBeRemoved(() => screen.queryByLabelText('Loading your transcripts'));

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('has no accessibility violations while loading', async () => {
    const { container } = renderHome();

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// One request per content type
// =============================================================================

describe('HomePage — data', () => {
  it('makes exactly ONE request per content type', async () => {
    // Each summary endpoint exists so a phone makes a single round trip for a
    // whole content type — three lists and four counts each — instead of one
    // request per section racing the others. An aggregate `/home/summary` was
    // rejected because the two are gated on different permissions; see the
    // page's header.
    renderHome();
    await waitForLoaded();

    await waitFor(() => expect(noteSummaryRequests).toBe(1));
    expect(summaryRequests).toBe(1);
  });

  it('fires both in parallel, with neither waiting on the other', async () => {
    // The transcript summary is held open until `release()`; if the page
    // awaited it before asking for notes, the notes request would never be
    // recorded here at all.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    respondWith(summary({ recent: [transcript()] }), { gate });
    renderHome();

    await waitFor(() => expect(noteSummaryRequests).toBe(1));
    expect(summaryRequests).toBe(1);
    // Both were in flight before either answered.
    expect(requestOrder).toHaveLength(2);

    release();
    await waitForLoaded();
  });

  it('asks for NO notes at all without notes:read', async () => {
    // `enabled: false` issues no request rather than spending a guaranteed 403
    // on every visit by a user the deployment has not given notes to.
    renderHome(noNotesUser);
    await waitForLoaded();

    // Awaited through a full poll's worth of settling, so this is not just
    // "the request had not landed yet".
    await waitFor(() => expect(summaryRequests).toBe(1));
    expect(noteSummaryRequests).toBe(0);
  });

  it('shows no notes section at all without notes:read', async () => {
    renderHome(noNotesUser);
    await waitForLoaded();

    expect(screen.queryByRole('heading', { name: 'Recent notes' })).not.toBeInTheDocument();
  });

  it('does not poll while nothing is in flight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderHome();
      await waitForLoaded();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(summaryRequests).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls while something IS in flight', async () => {
    respondWith(
      summary({ inProgress: [transcript({ id: 'p1', status: 'processing' })] }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderHome();
      await waitForLoaded();

      await vi.advanceTimersByTimeAsync(11_000);

      await waitFor(() => expect(summaryRequests).toBeGreaterThan(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed summary read without going blank', async () => {
    server.use(
      http.get(`${API_BASE}/transcripts/summary`, () => HttpResponse.error()),
      http.get(`${API_BASE}/transcription/config`, () =>
        HttpResponse.json({ data: TRANSCRIPTION_AVAILABLE }),
      ),
    );
    renderHome();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // The hero is still there — an error is not a reason to remove the one
    // action on the page.
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('does not claim the user has no transcripts when the read simply failed', async () => {
    // Every list is empty because nothing was ever read, not because nothing
    // exists — rendering the first-run walkthrough there tells a user with a
    // hundred recordings that they have none.
    server.use(
      http.get(`${API_BASE}/transcripts/summary`, () => HttpResponse.error()),
      http.get(`${API_BASE}/transcription/config`, () =>
        HttpResponse.json({ data: TRANSCRIPTION_AVAILABLE }),
      ),
    );
    renderHome();
    await screen.findByRole('alert');

    expect(screen.queryByRole('heading', { name: 'Start here' })).not.toBeInTheDocument();
  });

  it('treats 403 as a permission problem in words the user can act on', async () => {
    server.use(
      http.get(`${API_BASE}/transcripts/summary`, () =>
        HttpResponse.json({ message: 'no' }, { status: 403 }),
      ),
      http.get(`${API_BASE}/transcription/config`, () =>
        HttpResponse.json({ data: TRANSCRIPTION_AVAILABLE }),
      ),
    );
    renderHome();

    expect(await screen.findByRole('alert')).toHaveTextContent(/permission/i);
  });
});

// =============================================================================
// The hero
// =============================================================================

describe('HomePage — the hero', () => {
  it('greets the user by first name', async () => {
    renderHome({ ...homeUser, displayName: 'Ana Ruiz' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Hi, Ana' })).toBeInTheDocument();
  });

  it('greets a user with no display name', async () => {
    renderHome({ ...homeUser, displayName: null });

    expect(await screen.findByRole('heading', { level: 1, name: 'Hi there' })).toBeInTheDocument();
  });

  it('renders the tagline from the shared identity file', async () => {
    renderHome();
    await waitForLoaded();

    expect(screen.getByText(TAGLINE)).toBeInTheDocument();
  });

  it('offers New transcript', async () => {
    renderHome();
    await waitForLoaded();

    expect(await screen.findByRole('button', { name: 'New transcript' })).toBeEnabled();
  });
});

// =============================================================================
// The New note hero action — issue #173, epic #166
// =============================================================================

describe('HomePage — the New note hero action', () => {
  /**
   * Scoped to the hero's own region, ALWAYS.
   *
   * `RecentNotes`' `total === 0` zero-state renders its own "New note" button
   * for the same user, deliberately and unchanged by #173 — so a bare
   * `getByRole('button', { name: 'New note' })` would either find two nodes and
   * throw, or (worse, once the fixtures change) silently assert the wrong one.
   */
  function hero() {
    return within(screen.getByRole('region', { name: 'Hi, Test' }));
  }

  it('offers New note to a user holding notes:write', async () => {
    renderHome();
    await waitForLoaded();

    expect(hero().getByRole('button', { name: 'New note' })).toBeEnabled();
  });

  it('sends that user to the New-note flow', async () => {
    const user = userEvent.setup();
    renderHome();
    await waitForLoaded();

    await user.click(hero().getByRole('button', { name: 'New note' }));

    expect(mockNavigate).toHaveBeenCalledWith('/notes/new');
  });

  it('withholds it from a user who may READ notes but not write them', async () => {
    // The exact string, isolated: `notes.controller.ts` enforces `notes:write`
    // on `POST /api/notes` and `App.tsx` guards `/notes/new` with it, so
    // `notes:read` alone must not reach this action.
    renderHome({
      ...homeUser,
      permissions: homeUser.permissions.filter((permission) => permission !== 'notes:write'),
    });
    await waitForLoaded();

    expect(hero().queryByRole('button', { name: 'New note' })).not.toBeInTheDocument();
  });

  it('withholds it from a user with no notes permissions at all', async () => {
    renderHome(noNotesUser);
    await waitForLoaded();

    expect(hero().queryByRole('button', { name: 'New note' })).not.toBeInTheDocument();
  });

  it('keeps New transcript as the hero primary beside it', async () => {
    renderHome();
    await waitForLoaded();

    expect(hero().getByRole('button', { name: 'New transcript' })).toHaveClass(
      'MuiButton-contained',
    );
    expect(hero().getByRole('button', { name: 'New note' })).toHaveClass('MuiButton-outlined');
  });

  it('leaves RecentNotes\' own zero-state button in place', async () => {
    // NOT a duplicate to be tidied away: the zero-state button sits in a card
    // that explains what a note IS to the one account that has never generated
    // one. Removing it would take the action away from exactly the user who
    // needs the explanation attached to it.
    respondWith(summary({ recent: [transcript()] }), { notes: noteSummary() });
    renderHome();
    await screen.findByRole('heading', { name: 'Turn a transcript into a note' });

    expect(
      within(screen.getByRole('region', { name: 'Recent notes' })).getByRole('button', {
        name: 'New note',
      }),
    ).toBeInTheDocument();
    expect(hero().getByRole('button', { name: 'New note' })).toBeInTheDocument();
  });

  it('fires NO additional network request of its own', async () => {
    // The action costs nothing: there is no `GET /api/ai/config` probe behind
    // it and no fourth call on the landing screen. The page's rule stays "one
    // summary request per content type, plus the one capability probe".
    renderHome();
    await waitForLoaded();
    await waitFor(() => expect(noteSummaryRequests).toBe(1));
    expect(hero().getByRole('button', { name: 'New note' })).toBeInTheDocument();

    expect([...new Set(observedRequests)].sort()).toEqual(EXPECTED_REQUESTS);
    expect(observedRequests).toHaveLength(3);
  });

  it('has no accessibility violations with both hero actions present', async () => {
    const { container } = renderHome();
    await waitForLoaded();
    await screen.findByRole('button', { name: 'New transcript' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// The template placeholder is gone
// =============================================================================

describe('HomePage — the old placeholder', () => {
  it('no longer says "Welcome back"', async () => {
    renderHome();
    await waitForLoaded();

    expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument();
  });

  it('no longer calls itself a dashboard overview', async () => {
    renderHome();
    await waitForLoaded();

    expect(screen.queryByText(/your dashboard overview/i)).not.toBeInTheDocument();
  });

  it('no longer renders Quick Actions', async () => {
    renderHome();
    await waitForLoaded();

    expect(screen.queryByText(/quick actions/i)).not.toBeInTheDocument();
  });

  it('no longer restates the signed-in user’s own email back at them', async () => {
    renderHome();
    await waitForLoaded();

    expect(screen.queryByText(homeUser.email)).not.toBeInTheDocument();
  });

  it('no longer shows a "Member since" line', async () => {
    renderHome();
    await waitForLoaded();

    expect(screen.queryByText(/member since/i)).not.toBeInTheDocument();
  });

  it('does not link to settings from the page body', async () => {
    // Settings stay reachable from the user menu and the navigation, which is
    // where a settings link belongs.
    renderHome(mockAdminUser);
    await waitForLoaded();

    expect(screen.queryByRole('button', { name: /account settings/i })).not.toBeInTheDocument();
  });
});

// =============================================================================
// Empty (the journey)
// =============================================================================

describe('HomePage — a brand-new account', () => {
  beforeEach(() => {
    respondWith(summary());
  });

  it('explains the journey instead of showing an empty list', async () => {
    renderHome();

    expect(await screen.findByRole('heading', { name: 'Start here' })).toBeInTheDocument();
  });

  it('draws all four stages', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Start here' });

    for (const label of ['Capture', 'Correct', 'Transform', 'Find']) {
      expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
    }
  });

  it('marks the ONE unbuilt stage "Coming soon"', async () => {
    // Was two. Epic #45 shipped Transform and issue #107 — which put notes on
    // this very page — took its `comingSoon` flag off, so only Find is left.
    renderHome();
    await screen.findByRole('heading', { name: 'Start here' });

    expect(screen.getAllByText('Coming soon')).toHaveLength(1);
  });

  it('no longer calls Transform "Coming soon"', async () => {
    renderHome();
    const transform = await screen.findByRole('heading', { name: 'Transform' });

    // The chip is a sibling of the stage heading inside the same card.
    expect(within(transform.closest('div')!).queryByText('Coming soon')).not.toBeInTheDocument();
  });

  it('shows the New transcript button twice — hero and journey', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Start here' });

    expect(screen.getAllByRole('button', { name: 'New transcript' })).toHaveLength(2);
  });

  it('shows no Recent section', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Start here' });

    expect(screen.queryByRole('heading', { name: 'Recent' })).not.toBeInTheDocument();
  });

  it('shows no Shared with me section', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Start here' });

    expect(screen.queryByRole('heading', { name: 'Shared with me' })).not.toBeInTheDocument();
  });

  it('shows no In progress section', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Start here' });

    expect(screen.queryByRole('heading', { name: 'In progress' })).not.toBeInTheDocument();
  });

  it('does NOT show the journey to somebody whose first upload is processing', async () => {
    // A first-run walkthrough three inches above a recording that is visibly
    // transcoding is the page contradicting itself.
    respondWith(summary({ inProgress: [transcript({ id: 'p1', status: 'processing' })] }));
    renderHome();
    await waitForLoaded();

    expect(screen.queryByRole('heading', { name: 'Start here' })).not.toBeInTheDocument();
  });

  it('does NOT show the journey to somebody who only has shares', async () => {
    respondWith(summary({ sharedWithMe: [transcript({ id: 's1', access: 'viewer' })] }));
    renderHome();
    await waitForLoaded();

    expect(screen.queryByRole('heading', { name: 'Start here' })).not.toBeInTheDocument();
  });

  it('does NOT show the journey to somebody who has notes but no transcripts', async () => {
    // A note can be generated from an uploaded document without the account
    // ever recording anything. Showing that user "You have no transcripts yet.
    // Here is what happens once you do" over the top of the notes they wrote
    // last week is the page telling them their work does not count.
    respondWith(summary(), { notes: noteSummary({ recent: [note()] }) });
    renderHome();

    await screen.findByRole('heading', { name: 'Recent notes' });
    expect(screen.queryByRole('heading', { name: 'Start here' })).not.toBeInTheDocument();
  });

  it('still shows the journey to an account with neither', async () => {
    respondWith(summary(), { notes: noteSummary() });
    renderHome();

    expect(await screen.findByRole('heading', { name: 'Start here' })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderHome();
    await screen.findByRole('heading', { name: 'Start here' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// In progress
// =============================================================================

describe('HomePage — in progress', () => {
  beforeEach(() => {
    mockUseUploadManager.mockReturnValue(manager({ uploads: [upload()] }));
    respondWith(
      summary({
        recent: [transcript()],
        inProgress: [
          transcript({
            id: 'p1',
            title: 'Customer discovery',
            status: 'processing',
            transcriptionStatus: 'processing',
          }),
        ],
      }),
    );
  });

  it('shows the section', async () => {
    renderHome();

    expect(await screen.findByRole('heading', { name: 'In progress' })).toBeInTheDocument();
  });

  it('lists the local upload with its progress', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'In progress' });

    expect(screen.getByRole('heading', { name: 'interview.m4a' })).toBeInTheDocument();
    expect(screen.getByText(/Uploading · 10 MB of 40 MB/)).toBeInTheDocument();
  });

  it('lists the server-side item with its stage', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'In progress' });

    expect(screen.getByRole('heading', { name: 'Customer discovery' })).toBeInTheDocument();
    expect(screen.getByText('Transcribing')).toBeInTheDocument();
  });

  it('offers pause on the local upload', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'In progress' });

    expect(
      screen.getByRole('button', { name: 'Pause uploading interview.m4a' }),
    ).toBeInTheDocument();
  });

  it('opens a processing item when it is tapped', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('heading', { name: 'In progress' });

    await user.click(screen.getByRole('heading', { name: 'Customer discovery' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/p1');
  });

  it('prompts to resume a session a reload interrupted', async () => {
    mockUseUploadManager.mockReturnValue(
      manager({ uploads: [upload()], sessions: [session()] }),
    );
    renderHome();
    await screen.findByRole('heading', { name: 'In progress' });

    expect(screen.getByRole('button', { name: 'Resume upload' })).toBeInTheDocument();
  });

  it('still shows Recent below it', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'In progress' });

    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument();
  });

  it('lists a generating note in the same section', async () => {
    // One question ("what am I waiting on?"), one section — not one per source.
    respondWith(summary({ recent: [transcript()] }), {
      notes: noteSummary({
        inProgress: [note({ id: 'n-gen', title: 'Board minutes', status: 'generating' })],
      }),
    });
    renderHome();
    await screen.findByRole('heading', { name: 'In progress' });

    expect(await screen.findByText('Generating…')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Board minutes' })).toBeInTheDocument();
  });

  it('opens a generating note when it is tapped', async () => {
    respondWith(summary({ recent: [transcript()] }), {
      notes: noteSummary({
        inProgress: [note({ id: 'n-gen', title: 'Board minutes', status: 'generating' })],
      }),
    });
    const user = userEvent.setup();
    renderHome();

    await user.click(await screen.findByRole('heading', { name: 'Board minutes' }));

    expect(mockNavigate).toHaveBeenCalledWith('/notes/n-gen');
  });

  it('has no accessibility violations', async () => {
    const { container } = renderHome();
    await screen.findByRole('heading', { name: 'In progress' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// Needs attention
// =============================================================================

const FAILED_TRANSCRIPT = transcript({
  id: 't-failed',
  title: 'Board meeting',
  status: 'failed',
  transcriptionStatus: 'failed',
  failureReason: 'The provider rejected the audio.',
});

const FAILED_NOTE = note({
  id: 'n-failed',
  title: 'Board minutes',
  status: 'failed',
  failureReason: 'Your API key was rejected.',
});

describe('HomePage — needs attention', () => {
  beforeEach(() => {
    respondWith(summary({ recent: [transcript()], failed: [FAILED_TRANSCRIPT] }), {
      notes: noteSummary({ recent: [note()], failed: [FAILED_NOTE] }),
    });
    // The two retry endpoints, answered for real rather than spied on: which
    // endpoint each button reaches is the thing most likely to be wrong, and a
    // mocked service function asserts nothing about it.
    server.use(
      http.post(`${API_BASE}/transcripts/:id/retry`, () =>
        HttpResponse.json({ data: { ...FAILED_TRANSCRIPT, status: 'processing' } }),
      ),
      http.post(`${API_BASE}/notes/:id/regenerate`, () =>
        HttpResponse.json({
          data: {
            note: { ...FAILED_NOTE, status: 'generating' },
            generationId: 'gen-1',
            jobId: 'job-1',
            providerId: 'openai',
            model: 'gpt-4o-mini',
          },
        }),
      ),
    );
  });

  it('shows the section', async () => {
    renderHome();

    expect(
      await screen.findByRole('heading', { name: 'Needs attention' }),
    ).toBeInTheDocument();
  });

  it('lists the failed transcript AND the failed note', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Needs attention' });

    const region = screen.getByRole('region', { name: 'Needs attention' });
    expect(within(region).getAllByRole('listitem')).toHaveLength(2);
    expect(within(region).getByRole('heading', { name: 'Board meeting' })).toBeInTheDocument();
    expect(within(region).getByRole('heading', { name: 'Board minutes' })).toBeInTheDocument();
  });

  it('sits under In progress and above Recent', async () => {
    // THE ORDERING IS THE DECISION, not an accident of where the JSX landed —
    // see the comment on the mount in `HomePage`. "What is happening right
    // now?" keeps the top of the page because its rows stop being actionable
    // (a live upload's controls exist only in this tab); "what went wrong two
    // hours ago?" still outranks "what was I working on?", because a failed
    // recording is not recent work to revisit, it is work that never happened.
    mockUseUploadManager.mockReturnValue(manager({ uploads: [upload()] }));
    renderHome();
    await screen.findByRole('heading', { name: 'Needs attention' });

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings.indexOf('In progress')).toBeLessThan(headings.indexOf('Needs attention'));
    expect(headings.indexOf('Needs attention')).toBeLessThan(headings.indexOf('Recent'));
  });

  it('is ABSENT on a healthy account', async () => {
    // Not an empty box, not a "nothing needs attention" card. The steady state
    // of this app is that nothing is broken.
    respondWith(summary({ recent: [transcript()] }), { notes: noteSummary({ recent: [note()] }) });
    renderHome();
    await waitForLoaded();

    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
  });

  it('is ABSENT in the first-run journey state', async () => {
    // Not reachable through the API — `isNewUser` needs `recent` empty and a
    // failed transcript is in `recent` too — but the section is mounted inside
    // the non-new-user branch so that it cannot become reachable either.
    respondWith(
      summary({
        failed: [FAILED_TRANSCRIPT],
        counts: { owned: 0, shared: 0, inProgress: 0, failed: 1 },
      }),
    );
    renderHome();
    await screen.findByRole('heading', { name: 'Start here' });

    expect(screen.queryByRole('heading', { name: 'Needs attention' })).not.toBeInTheDocument();
  });

  it('shows no note rows without notes:read', async () => {
    // The hook is disabled entirely for that user, so the page hands the
    // section an empty notes list rather than gating a button inside it.
    renderHome(noNotesUser);
    await screen.findByRole('heading', { name: 'Needs attention' });

    expect(screen.queryByRole('heading', { name: 'Board minutes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Regenerate/ })).not.toBeInTheDocument();
  });

  it('withholds the transcript retry without transcripts:write', async () => {
    renderHome({
      ...homeUser,
      permissions: homeUser.permissions.filter((p) => p !== 'transcripts:write'),
    });
    await screen.findByRole('heading', { name: 'Needs attention' });

    expect(
      screen.queryByRole('button', { name: 'Retry Board meeting' }),
    ).not.toBeInTheDocument();
    // The ROW is still there — the news is not gated, only the action.
    expect(screen.getByRole('heading', { name: 'Board meeting' })).toBeInTheDocument();
  });

  it('fires NO additional request when the page loads', async () => {
    // ⚠ THE EPIC-LEVEL CRITERION. The rows come from the two summaries the page
    // already makes; a `GET /api/transcripts?status=failed` for one section
    // would be this page's "one request per content type" rule broken.
    //
    // ⚠ ROOT CAUSE OF A REAL CI FAILURE — PR #205, `Web Tests` shard 2/4. Read
    // this before touching the fixture below. This describe block's own
    // `beforeEach` puts `note()` — `sourceType: 'transcript'`,
    // `sourceTranscriptId: 't1'` — in `notes.recent`, and `RecentNotes` hands
    // that array straight to `useNoteSourceNames` (issue #57/#107): a real,
    // documented, ASYNC per-source lookup (see that hook's header for why it
    // exists and why the actual fix belongs in the API, not here) that fires
    // its OWN `GET /api/transcripts/t1` to resolve "from *Weekly standup*".
    // That is a genuine, legitimate fourth request whenever a recent note has
    // a source — it is simply not part of what THIS test is pinning. The old
    // assertion here passed locally and on 3 of 4 CI shards only because the
    // lookup usually had not started before the assertion ran, and failed
    // once CI load let it start in time — an order/timing-dependent failure,
    // not a flake to retry away. So this test asks for a notes summary whose
    // `recent` list is EMPTY: no source to resolve, no async request to race,
    // while `failed: [FAILED_NOTE]` keeps "Needs attention" rendering exactly
    // as truthfully as the shared fixture did (that section reads
    // `notes.summary.failed`, never `.recent` — see `HomePage.tsx`).
    respondWith(summary({ recent: [transcript()], failed: [FAILED_TRANSCRIPT] }), {
      notes: noteSummary({ failed: [FAILED_NOTE] }),
    });
    renderHome();
    await screen.findByRole('heading', { name: 'Needs attention' });
    await waitFor(() => expect(noteSummaryRequests).toBe(1));

    expect([...observedRequests].sort()).toEqual(EXPECTED_REQUESTS);
  });

  it('retries a transcript and re-reads the transcript summary', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('heading', { name: 'Needs attention' });
    await waitFor(() => expect(noteSummaryRequests).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Retry Board meeting' }));

    // The refreshed summary is what takes the row off the list.
    await waitFor(() => expect(summaryRequests).toBe(2));
    expect(
      observedRequests.filter((path) => path === '/api/transcripts/t-failed/retry'),
    ).toHaveLength(1);
    // AND NOT the notes summary: a transcript retry changed nothing about it.
    expect(noteSummaryRequests).toBe(1);
  });

  it('regenerates a note and re-reads the notes summary', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('heading', { name: 'Needs attention' });
    await waitFor(() => expect(noteSummaryRequests).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Regenerate Board minutes' }));

    await waitFor(() => expect(noteSummaryRequests).toBe(2));
    expect(summaryRequests).toBe(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = renderHome();
    await screen.findByRole('heading', { name: 'Needs attention' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// Recent
// =============================================================================

describe('HomePage — a populated recent list', () => {
  const EIGHT = Array.from({ length: 8 }, (_, index) =>
    transcript({ id: `t${index}`, title: `Recording ${index}` }),
  );

  beforeEach(() => {
    respondWith(summary({ recent: EIGHT }));
  });

  it('shows the Recent section', async () => {
    renderHome();

    expect(await screen.findByRole('heading', { name: 'Recent' })).toBeInTheDocument();
  });

  it('renders all eight', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Recent' });

    const list = within(screen.getByRole('region', { name: 'Recent' })).getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
  });

  it('shows title, date, duration and speaker count on each row', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Recent' });

    expect(screen.getByRole('heading', { name: 'Recording 0' })).toBeInTheDocument();
    expect(screen.getAllByText(/ago · 15 min · 3 speakers/)).toHaveLength(8);
  });

  it('shows the status of each row', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Recent' });

    expect(screen.getAllByText('Ready')).toHaveLength(8);
  });

  it('offers "View all"', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Recent' });

    expect(screen.getByRole('button', { name: /View all/ })).toBeInTheDocument();
  });

  it('sends "View all" to the library', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('heading', { name: 'Recent' });

    await user.click(screen.getByRole('button', { name: /View all/ }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts');
  });

  it('opens a transcript when its card is tapped', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('heading', { name: 'Recent' });

    await user.click(screen.getByRole('heading', { name: 'Recording 5' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/t5');
  });

  it('hides the journey once there is anything to show', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Recent' });

    expect(screen.queryByRole('heading', { name: 'Start here' })).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderHome();
    await screen.findByRole('heading', { name: 'Recent' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// Recent notes
// =============================================================================

describe('HomePage — recent notes', () => {
  beforeEach(() => {
    respondWith(summary({ recent: [transcript()] }), {
      notes: noteSummary({
        recent: [
          note({ id: 'n1', title: 'Standup minutes' }),
          note({ id: 'n2', title: 'Discovery brief' }),
        ],
      }),
    });
  });

  it('shows the section', async () => {
    renderHome();

    expect(await screen.findByRole('heading', { name: 'Recent notes' })).toBeInTheDocument();
  });

  it('lists the notes', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Recent notes' });

    const list = within(screen.getByRole('region', { name: 'Recent notes' })).getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('opens a note when its card is tapped', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('heading', { name: 'Recent notes' });

    await user.click(screen.getByRole('heading', { name: 'Discovery brief' }));

    expect(mockNavigate).toHaveBeenCalledWith('/notes/n2');
  });

  it('puts it BELOW the transcripts, and above Shared with me', async () => {
    // Capture → Correct → Transform, in that order, is the page's whole spine.
    respondWith(summary({ recent: [transcript()], sharedWithMe: [transcript({ id: 's1' })] }), {
      notes: noteSummary({ recent: [note()] }),
    });
    renderHome();
    await screen.findByRole('heading', { name: 'Recent notes' });

    const sections = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(sections).toEqual(['Recent', 'Recent notes', 'Shared with me']);
  });

  it('prompts an account with transcripts but no notes', async () => {
    respondWith(summary({ recent: [transcript()] }), { notes: noteSummary() });
    renderHome();

    expect(
      await screen.findByRole('heading', { name: 'Turn a transcript into a note' }),
    ).toBeInTheDocument();
  });

  it('reports a failed notes read in its own alert', async () => {
    server.use(
      http.get(`${API_BASE}/notes/summary`, () => HttpResponse.error()),
    );
    renderHome();
    await waitForLoaded();

    expect(await screen.findByRole('alert')).toHaveTextContent(/notes/i);
  });

  it('does NOT claim the user has no notes when the read simply failed', async () => {
    // Every list is empty because nothing was ever read — inviting a user with
    // forty notes to make their first one, directly under the alert saying the
    // read failed, is the same bug `isNewUser`'s `summary !== null` guards.
    server.use(
      http.get(`${API_BASE}/notes/summary`, () => HttpResponse.error()),
    );
    renderHome();
    await screen.findByRole('alert');

    expect(
      screen.queryByRole('heading', { name: 'Turn a transcript into a note' }),
    ).not.toBeInTheDocument();
  });

  it('still renders the transcripts when the notes read fails', async () => {
    server.use(
      http.get(`${API_BASE}/notes/summary`, () => HttpResponse.error()),
    );
    renderHome();
    await screen.findByRole('alert');

    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument();
  });

  it('names a note\u2019s source with NO request at all (#192)', async () => {
    // The strengthened form of the test this replaces. That one pinned
    // `useNoteSourceNames` — an async lookup firing one `GET` per distinct
    // source, deduped by a module-level cache — and asserted the dedup: ONE
    // request for two notes sharing a transcript.
    //
    // #192 denormalises `sourceName` onto the row, so the claim is now the
    // stronger one: ZERO. That also retires the intermittency this suite's
    // `EXPECTED_REQUESTS` comment describes at length — an async lookup that
    // had usually not started before an assertion ran.
    //
    // ⚠ An exact path, never `/transcripts/:id`: a param route would also match
    // `/transcripts/summary`, the `summary`-is-a-legal-id trap `respondWith`
    // warns about, and would shadow the `beforeEach`'s summary handler because
    // `server.use` here registers last.
    let transcriptRequests = 0;
    server.use(
      http.get(`${API_BASE}/transcripts/t1`, () => {
        transcriptRequests += 1;
        return HttpResponse.json({
          data: { id: 't1', title: 'Weekly sync recording', currentVersion: 1 },
        });
      }),
    );
    renderHome();
    await screen.findByRole('heading', { name: 'Recent notes' });

    // Both cards name the source, straight off the row the summary returned.
    expect(await screen.findAllByRole('link', { name: 'Weekly sync recording' })).toHaveLength(2);
    expect(transcriptRequests).toBe(0);
    expect(observedRequests.filter((path) => path === '/api/transcripts/t1')).toHaveLength(0);
  });

  it('has no accessibility violations', async () => {
    const { container } = renderHome();
    await screen.findByRole('heading', { name: 'Recent notes' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// Shared with me
// =============================================================================

describe('HomePage — shared with me', () => {
  beforeEach(() => {
    respondWith(
      summary({
        recent: [transcript()],
        sharedWithMe: [
          transcript({ id: 's1', title: 'Design review', access: 'viewer' }),
          transcript({ id: 's2', title: 'Roadmap sync', access: 'editor' }),
        ],
      }),
    );
  });

  it('shows the section', async () => {
    renderHome();

    expect(await screen.findByRole('heading', { name: 'Shared with me' })).toBeInTheDocument();
  });

  it('chips a viewer share', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Shared with me' });

    expect(screen.getByText('Viewer')).toBeInTheDocument();
  });

  it('chips an editor share', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Shared with me' });

    expect(screen.getByText('Editor')).toBeInTheDocument();
  });

  it('opens a shared transcript', async () => {
    const user = userEvent.setup();
    renderHome();
    await screen.findByRole('heading', { name: 'Shared with me' });

    await user.click(screen.getByRole('heading', { name: 'Design review' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts/s1');
  });

  it('hides the section when nobody has shared anything', async () => {
    respondWith(summary({ recent: [transcript()] }));
    renderHome();
    await waitForLoaded();

    expect(screen.queryByRole('heading', { name: 'Shared with me' })).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderHome();
    await screen.findByRole('heading', { name: 'Shared with me' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// Transcription not configured
// =============================================================================

describe('HomePage — transcription is not configured', () => {
  beforeEach(() => {
    respondWith(summary({ recent: [transcript()] }), { config: TRANSCRIPTION_UNAVAILABLE });
  });

  it('disables New transcript for an ordinary user', async () => {
    renderHome();
    await waitForLoaded();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'New transcript' })).toBeDisabled(),
    );
  });

  it('tells an ordinary user why', async () => {
    renderHome();

    expect(
      await screen.findByText(/transcription is not set up for this workspace yet/i),
    ).toBeInTheDocument();
  });

  it('offers an ordinary user no set-up link they cannot use', async () => {
    renderHome();
    await screen.findByText(/transcription is not set up/i);

    expect(screen.queryByRole('button', { name: 'Set up transcription' })).not.toBeInTheDocument();
  });

  it('offers an admin the set-up link', async () => {
    renderHome(mockAdminUser);

    expect(
      await screen.findByRole('button', { name: 'Set up transcription' }),
    ).toBeInTheDocument();
  });

  it('sends the admin to the transcription settings page', async () => {
    const user = userEvent.setup();
    renderHome(mockAdminUser);

    await user.click(await screen.findByRole('button', { name: 'Set up transcription' }));

    expect(mockNavigate).toHaveBeenCalledWith('/admin/settings/transcription');
  });

  it('treats a FAILED probe as "not available" rather than guessing', async () => {
    // An enabled button whose flow ends in a 409 is worse than a disabled one
    // that says why — the same posture `NewTranscriptPage` takes.
    server.use(
      http.get(`${API_BASE}/transcripts/summary`, () =>
        HttpResponse.json({ data: summary({ recent: [transcript()] }) }),
      ),
      http.get(`${API_BASE}/transcription/config`, () => HttpResponse.error()),
    );
    renderHome();

    expect(
      await screen.findByText(/transcription is not set up for this workspace yet/i),
    ).toBeInTheDocument();
  });

  it('still renders the rest of the page', async () => {
    renderHome();
    await waitForLoaded();

    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument();
  });

  it('hides the button entirely from a user without transcripts:write', async () => {
    renderHome({ ...mockUser, permissions: ['user_settings:read', 'transcripts:read'] });
    await waitForLoaded();

    expect(screen.queryByRole('button', { name: 'New transcript' })).not.toBeInTheDocument();
  });

  it('has no accessibility violations for an admin', async () => {
    const { container } = renderHome(mockAdminUser);
    await screen.findByRole('button', { name: 'Set up transcription' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// The counts strip (#170, epic #166)
// =============================================================================

describe('HomePage — the counts strip', () => {
  const POPULATED = () =>
    summary({
      recent: [transcript()],
      counts: { owned: 12, shared: 3, inProgress: 0, failed: 0 },
    });

  it('shows the strip with the counts the summaries already returned', async () => {
    respondWith(POPULATED(), {
      notes: noteSummary({ counts: { total: 7, ready: 7, inProgress: 0, failed: 0 } }),
    });
    renderHome();
    await waitForLoaded();

    const strip = await screen.findByRole('region', { name: 'Your library at a glance' });
    expect(within(strip).getByRole('link', { name: '12 Transcripts' })).toBeInTheDocument();
    expect(within(strip).getByRole('link', { name: '3 Shared with me' })).toBeInTheDocument();
    expect(await within(strip).findByRole('link', { name: '7 Notes' })).toBeInTheDocument();
  });

  it('FIRES NO REQUEST OF ITS OWN — the page still makes exactly three calls', async () => {
    // ⚠ THE SUCCESS CRITERION OF THIS ISSUE, and the reason `observedRequests`
    // watches MSW rather than this file's own handlers: a strip that asked for
    // its own `GET /api/transcripts?status=failed` to get an "accurate" failure
    // count would leave `summaryRequests` reading 1 and still have added a
    // third content request to the app's landing screen.
    respondWith(POPULATED(), {
      notes: noteSummary({ counts: { total: 7, ready: 7, inProgress: 0, failed: 2 } }),
    });
    renderHome();
    await waitForLoaded();
    await screen.findByRole('region', { name: 'Your library at a glance' });
    // Settled: both summaries answered and the probe resolved.
    await waitFor(() => expect(noteSummaryRequests).toBe(1));

    expect([...new Set(observedRequests)].sort()).toEqual(EXPECTED_REQUESTS);
    expect(observedRequests).toHaveLength(3);
  });

  it('adds no request when the attention entry is on screen either', async () => {
    // The one entry whose number is arithmetic over BOTH summaries — the most
    // tempting place to reach for a count of one's own.
    respondWith(
      summary({ recent: [transcript()], counts: { owned: 4, shared: 0, inProgress: 0, failed: 2 } }),
      { notes: noteSummary({ counts: { total: 1, ready: 0, inProgress: 0, failed: 1 } }) },
    );
    renderHome();
    await waitForLoaded();

    expect(
      await screen.findByRole('link', { name: '3 Needs attention' }),
    ).toHaveAttribute('href', '/transcripts?status=failed');
    expect(observedRequests).toHaveLength(3);
  });

  it('hides Needs attention when nothing has failed', async () => {
    respondWith(POPULATED());
    renderHome();
    await waitForLoaded();
    await screen.findByRole('region', { name: 'Your library at a glance' });

    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('shows no Notes entry for a user without notes:read', async () => {
    renderHome(noNotesUser);
    await waitForLoaded();

    const strip = await screen.findByRole('region', { name: 'Your library at a glance' });
    expect(within(strip).queryByText('Notes')).not.toBeInTheDocument();
    // And still no notes request, which is the point of the permission gate.
    expect(observedRequests).not.toContain('/api/notes/summary');
  });

  it('is absent on the first-run journey', async () => {
    // A strip of zeros above the walkthrough explaining how to stop it reading
    // zero. `HomePage` gates the mount on `!isNewUser` for exactly this.
    respondWith(summary());
    renderHome();
    await screen.findByRole('heading', { name: 'Start here' });

    expect(
      screen.queryByRole('region', { name: 'Your library at a glance' }),
    ).not.toBeInTheDocument();
  });

  it('is absent when the summary read FAILED', async () => {
    // Every count would be zero because nothing was ever read, not because
    // nothing exists — the same load-bearing reasoning as the journey gate.
    server.use(
      http.get(`${API_BASE}/transcripts/summary`, () => HttpResponse.error()),
      http.get(`${API_BASE}/transcription/config`, () =>
        HttpResponse.json({ data: TRANSCRIPTION_AVAILABLE }),
      ),
    );
    renderHome();
    await screen.findByRole('alert');

    expect(
      screen.queryByRole('region', { name: 'Your library at a glance' }),
    ).not.toBeInTheDocument();
  });

  it('sits between the hero and In progress', async () => {
    // Order is the whole design of this page — see its header's list of the
    // five questions and the order a phone screen can afford them.
    respondWith(
      summary({
        inProgress: [transcript({ id: 'p1', status: 'processing' })],
        recent: [transcript()],
        counts: { owned: 9, shared: 0, inProgress: 1, failed: 0 },
      }),
    );
    renderHome();
    await waitForLoaded();

    const strip = await screen.findByRole('region', { name: 'Your library at a glance' });
    const hero = screen.getByRole('heading', { level: 1 });
    const inProgress = screen.getByRole('heading', { name: /In progress/ });
    expect(hero.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      strip.compareDocumentPosition(inProgress) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('has no accessibility violations with the strip on screen', async () => {
    respondWith(POPULATED(), {
      notes: noteSummary({ counts: { total: 7, ready: 7, inProgress: 0, failed: 2 } }),
    });
    const { container } = renderHome();
    await waitForLoaded();
    await screen.findByRole('region', { name: 'Your library at a glance' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

// =============================================================================
// The search entry point — issue #172, epic #166
// =============================================================================

describe('HomePage — the search entry point', () => {
  /**
   * Scoped to the hero's own region, like the New-note suite above.
   *
   * The library views have their own search boxes, and `SettingsHub` has a
   * third; a bare `getByRole('searchbox')` on this page happens to be
   * unambiguous today and would stop being so the moment any section grew a
   * filter.
   */
  function hero() {
    return within(screen.getByRole('region', { name: 'Hi, Test' }));
  }

  function field() {
    return hero().getByRole('searchbox', { name: 'Search transcripts' });
  }

  it('offers a named search field on the landing screen', async () => {
    // The page's fourth question — "find it again later" — had no entry point
    // here at all before #172.
    renderHome();
    await waitForLoaded();

    expect(field()).toBeInTheDocument();
    expect(hero().getByRole('button', { name: 'Search' })).toBeInTheDocument();
  });

  it('sends a submitted term to the transcripts library', async () => {
    const user = userEvent.setup();
    renderHome();
    await waitForLoaded();

    await user.type(field(), 'standup{Enter}');

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts?q=standup');
  });

  it('sends the same term when the submit button is clicked', async () => {
    const user = userEvent.setup();
    renderHome();
    await waitForLoaded();

    await user.type(field(), 'standup');
    await user.click(hero().getByRole('button', { name: 'Search' }));

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts?q=standup');
  });

  it('encodes a term carrying URL-significant characters', async () => {
    // `&` would otherwise start a second query parameter and `#` would truncate
    // the term into a fragment.
    const user = userEvent.setup();
    renderHome();
    await waitForLoaded();

    await user.type(field(), 'budget & scope #4{Enter}');

    expect(mockNavigate).toHaveBeenCalledWith('/transcripts?q=budget%20%26%20scope%20%234');
  });

  it('does not navigate on an empty or whitespace-only term', async () => {
    const user = userEvent.setup();
    renderHome();
    await waitForLoaded();

    await user.click(field());
    await user.keyboard('{Enter}');
    await user.type(field(), '   {Enter}');
    await user.click(hero().getByRole('button', { name: 'Search' }));

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('withholds the field from a user without transcripts:read', async () => {
    renderHome({
      ...homeUser,
      permissions: homeUser.permissions.filter(
        (permission) => permission !== 'transcripts:read',
      ),
    });
    await waitForLoaded();

    expect(hero().queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('fires NO network request, not even while a term is being typed', async () => {
    // ⚠ THE EPIC-LEVEL CRITERION. A live-results dropdown would be a request
    // PER KEYSTROKE on the landing screen, which is precisely what this page's
    // "one request per content type, plus the one capability probe" rule
    // forbids. The control types locally and navigates once.
    const user = userEvent.setup();
    renderHome();
    await waitForLoaded();
    await waitFor(() => expect(noteSummaryRequests).toBe(1));

    await user.type(field(), 'standup');

    expect([...new Set(observedRequests)].sort()).toEqual(EXPECTED_REQUESTS);
    expect(observedRequests).toHaveLength(3);
  });

  it('has no accessibility violations with the field present', async () => {
    const { container } = renderHome();
    await waitForLoaded();
    await screen.findByRole('button', { name: 'New transcript' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
