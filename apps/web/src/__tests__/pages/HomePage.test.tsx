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
import type { TranscriptSummary } from '../../services/transcripts';
import type { TranscriptionConfig } from '../../services/transcription';
import {
  AXE_OPTIONS,
  TRANSCRIPTION_AVAILABLE,
  TRANSCRIPTION_UNAVAILABLE,
  homeUser,
  manager,
  session,
  summary,
  transcript,
  upload,
} from '../components/home/homeFixtures';

/**
 * The signed-in home page, over the REAL data hook and MSW.
 *
 * Not a mocked `useTranscriptSummary`: the thing most likely to be wrong on
 * this page is the wiring between ONE summary request, the capability probe
 * that runs beside it, and which of the five sections that combination is
 * supposed to render — and a mocked hook asserts nothing about any of it.
 *
 * `useUploadManager` IS mocked, for the reason its own header gives: it owns
 * `XMLHttpRequest`s, IndexedDB sessions and a wake lock, none of which this
 * page's behaviour depends on.
 */

const API_BASE = 'http://localhost:3000/api';

const mockUseUploadManager = vi.mocked(useUploadManager);

/** Every summary request this render made — so "exactly one" is assertable. */
let summaryRequests = 0;

function respondWith(
  data: TranscriptSummary,
  config: TranscriptionConfig = TRANSCRIPTION_AVAILABLE,
) {
  summaryRequests = 0;
  server.use(
    http.get(`${API_BASE}/transcripts/summary`, () => {
      summaryRequests += 1;
      return HttpResponse.json({ data });
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
  mockUseUploadManager.mockReturnValue(manager());
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
// One request
// =============================================================================

describe('HomePage — data', () => {
  it('drives the whole page from ONE summary request', async () => {
    // The endpoint exists so a phone makes a single round trip for three lists
    // and four counts, instead of four requests racing each other.
    renderHome();
    await waitForLoaded();

    expect(summaryRequests).toBe(1);
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

  it('marks the two unbuilt stages "Coming soon"', async () => {
    renderHome();
    await screen.findByRole('heading', { name: 'Start here' });

    expect(screen.getAllByText('Coming soon')).toHaveLength(2);
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

  it('has no accessibility violations', async () => {
    const { container } = renderHome();
    await screen.findByRole('heading', { name: 'In progress' });

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
    respondWith(summary({ recent: [transcript()] }), TRANSCRIPTION_UNAVAILABLE);
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
