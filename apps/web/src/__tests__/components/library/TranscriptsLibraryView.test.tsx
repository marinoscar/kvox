/**
 * `TranscriptsLibraryView`'s row structure (issue #98, epic #19).
 *
 * `TranscriptRowActions.test.tsx` covers the action cluster in isolation;
 * this file covers what only exists once it is mounted BESIDE the card's
 * `CardActionArea` rather than mocked away — the regression the restructure
 * (two siblings, not one nested action area) exists to prevent, and the axe
 * pass that is the actual proof neither control is nested inside the other.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { server } from '../../mocks/server';
import { render, mockAdminUser } from '../../utils/test-utils';
import TranscriptsLibraryView from '../../../components/library/TranscriptsLibraryView';
import type { TranscriptAudio, TranscriptListItem } from '../../../services/transcripts';

const API_BASE = 'http://localhost:3000/api';

/** jsdom performs no layout, so `color-contrast` is a known false-negative trap. */
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

/**
 * For the PORTALLED menu, checked against `document.body` — see
 * `TranscriptCorrections.test.tsx`'s own constant of the same name for why
 * `region` is also off there: a portal root is a sibling of the app shell
 * that owns the landmarks, not a violation of the rule that wants one.
 */
const AXE_PORTAL_OPTIONS = {
  rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
};

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

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
    ownerName: 'Admin User',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function respondWith(items: TranscriptListItem[], nextCursor: string | null = null) {
  server.use(
    http.get(`${API_BASE}/transcripts`, () => HttpResponse.json({ data: { items, nextCursor } })),
  );
}

function respondWithAudio(audio: TranscriptAudio) {
  server.use(
    http.get(`${API_BASE}/transcripts/:id/audio`, () => HttpResponse.json({ data: audio })),
  );
}

beforeEach(() => {
  localStorage.setItem('theme_mode', 'light');
  mockNavigate.mockReset();
  respondWith([item()]);
  respondWithAudio({
    url: 'https://storage.example/signed-1',
    kind: 'playback',
    mimeType: 'audio/mp4',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
});

function renderView() {
  return render(<TranscriptsLibraryView />, { wrapperOptions: { user: mockAdminUser } });
}

describe('TranscriptsLibraryView — the row is two siblings, not one', () => {
  it('does not navigate when the Play button is pressed', async () => {
    const user = userEvent.setup();
    renderView();

    const play = await screen.findByRole('button', { name: 'Play "Weekly standup"' });
    await user.click(play);

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('DOES navigate when the card body itself is pressed', async () => {
    const user = userEvent.setup();
    renderView();

    // The title sits inside the `CardActionArea`; a click on it bubbles up to
    // the area's own handler exactly as it would for a real pointer click.
    await user.click(await screen.findByText('Weekly standup'));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/transcripts/t1'));
  });

  it('opening the ⋮ menu does not navigate either', async () => {
    const user = userEvent.setup();
    renderView();

    const moreButton = await screen.findByRole('button', {
      name: 'More options for "Weekly standup"',
    });
    await user.click(moreButton);

    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('hides the Play control for a row with no playable audio', async () => {
    respondWith([item({ status: 'processing', playbackStatus: 'processing' })]);
    renderView();

    await screen.findByText('Weekly standup');
    expect(screen.queryByRole('button', { name: /play|pause/i })).not.toBeInTheDocument();
    // The overflow menu is still there — Open/Export/etc. do not depend on
    // whether the row has audio.
    expect(screen.getByRole('button', { name: /more options/i })).toBeInTheDocument();
  });
});

describe('TranscriptsLibraryView — playback and the inline row error', () => {
  it('plays a row, and shows its failure inline on THAT row only, not on others', async () => {
    respondWith([item({ id: 't1', title: 'Weekly standup' }), item({ id: 't2', title: 'Retro' })]);
    server.use(
      http.get(`${API_BASE}/transcripts/:id/audio`, () => new HttpResponse(null, { status: 500 })),
    );
    const user = userEvent.setup();
    renderView();

    await screen.findByText('Retro');
    await user.click(screen.getByRole('button', { name: 'Play "Weekly standup"' }));

    // NOT a plain `screen.findByText`: the same sentence also reaches the
    // list's one `role="status"` live region (see `TranscriptsLibraryView`'s
    // own comment on why), so a query that did not scope to a single row
    // would find two matches and fail for the wrong reason.
    const cards = await waitFor(() => {
      const rows = screen.getAllByRole('listitem');
      expect(within(rows[0]).getByText(/could not be loaded/i)).toBeInTheDocument();
      return rows;
    });
    expect(within(cards[1]).queryByText(/could not be loaded/i)).not.toBeInTheDocument();
  });
});

describe('TranscriptsLibraryView — accessibility', () => {
  it('has no axe violations with both the Play button and the overflow menu present', async () => {
    const { container } = renderView();
    await screen.findByText('Weekly standup');
    // No nested-interactive violation from the CardActionArea/cluster split.
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('has no axe violations once the overflow menu is open', async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(
      await screen.findByRole('button', { name: 'More options for "Weekly standup"' }),
    );
    await screen.findByRole('menu');

    // The menu portals to `document.body`, outside the rendered `container`.
    expect(await axe(document.body, AXE_PORTAL_OPTIONS)).toHaveNoViolations();
  });
});
