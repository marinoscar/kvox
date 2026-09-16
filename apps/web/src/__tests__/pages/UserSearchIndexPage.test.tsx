/**
 * `/settings/search-index` (issue #191, epic #165).
 *
 * THE SERVICE MODULE IS MOCKED, NOT THE HOOK — the house pattern
 * `UserDangerZonePage.test.tsx` and `UserAiPage.test.tsx` both follow.
 * `useSearchIndex`'s polling contract (started by STATE rather than by the
 * click, silent on a tick, and STOPPED the moment nothing is pending) is one of
 * this page's acceptance criteria, so the real hook has to sit between the
 * mocked transport and the rendered page. `importOriginal` keeps the display
 * helpers real, because the page renders through them.
 *
 * ⚠ THE COST SENTENCE ASSERTIONS SPELL THE WORDS OUT rather than importing a
 * constant from the page. That is deliberate and is the entire point of those
 * two tests: a test that compared the page against its own string would keep
 * passing while somebody quietly rewrote "billed to you" into "usage may
 * apply". Whose account pays is the one fact on this page that must not be
 * softened.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/searchIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/searchIndex')>();
  return {
    ...actual,
    getSearchIndexStatus: vi.fn(),
    requestSearchIndex: vi.fn(),
  };
});

import { render } from '../utils/test-utils';
import UserSearchIndexPage from '../../pages/UserSearchIndexPage';
import { SEARCH_INDEX_POLL_INTERVAL_MS } from '../../hooks/useSearchIndex';
import { getSearchIndexStatus, requestSearchIndex } from '../../services/searchIndex';
import type { SearchIndexStatus, SearchIndexTypeCounts } from '../../services/searchIndex';

const mockGetStatus = vi.mocked(getSearchIndexStatus);
const mockRequestIndex = vi.mocked(requestSearchIndex);

function counts(
  type: SearchIndexTypeCounts['type'],
  overrides: Partial<SearchIndexTypeCounts> = {},
): SearchIndexTypeCounts {
  return {
    type,
    indexed: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
    unindexed: 0,
    total: 0,
    ...overrides,
  };
}

function status(overrides: Partial<SearchIndexStatus> = {}): SearchIndexStatus {
  return {
    types: [counts('transcript'), counts('note')],
    model: 'text-embedding-3-small',
    hasKey: true,
    available: true,
    reason: null,
    failures: [],
    ...overrides,
  };
}

/** A library with one document in every state, including the one with no row. */
const MIXED: SearchIndexStatus = status({
  types: [
    counts('transcript', {
      indexed: 3,
      pending: 2,
      failed: 1,
      skipped: 4,
      unindexed: 5,
      total: 15,
    }),
    counts('note', { indexed: 1, unindexed: 7, total: 8 }),
  ],
});

async function renderPage() {
  const result = render(<UserSearchIndexPage />);
  await screen.findByRole('heading', { level: 1, name: /search indexing/i });
  return result;
}

describe('UserSearchIndexPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStatus.mockResolvedValue(status());
    mockRequestIndex.mockResolvedValue({ queued: 5, remaining: 0, cap: 200 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // The cost sentence — the assertions that stop it being softened
  // ==========================================================================

  describe('the cost sentence', () => {
    it("names the user's OWN provider account, in the page body", async () => {
      await renderPage();

      expect(screen.getByText(/your own AI provider account/i)).toBeInTheDocument();
    });

    it('says the usage is billed to the user, not to the deployment', async () => {
      await renderPage();

      expect(screen.getByText(/billed to you/i)).toBeInTheDocument();
      expect(screen.getByText(/not to\s+this deployment/i)).toBeInTheDocument();
    });

    it('states it even when indexing is unavailable — the cost does not depend on readiness', async () => {
      mockGetStatus.mockResolvedValue(status({ hasKey: false, reason: 'ai_key_missing' }));
      await renderPage();

      expect(screen.getByText(/your own AI provider account/i)).toBeInTheDocument();
      expect(screen.getByText(/billed to you/i)).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // The status table
  // ==========================================================================

  describe('the status table', () => {
    it('renders every state per document type, including the one with no index row', async () => {
      mockGetStatus.mockResolvedValue(MIXED);
      await renderPage();

      const table = screen.getByRole('table', { name: /indexing status by document type/i });
      const recordings = within(table).getByRole('row', { name: /^Recordings/ });

      expect(
        within(recordings).getByLabelText('Recordings Indexed'),
      ).toHaveTextContent('3');
      expect(
        within(recordings).getByLabelText('Recordings In progress'),
      ).toHaveTextContent('2');
      expect(within(recordings).getByLabelText('Recordings Failed')).toHaveTextContent('1');
      expect(within(recordings).getByLabelText('Recordings Skipped')).toHaveTextContent('4');
      // ⚠ THE ONE THAT HAS NO DATABASE ROW BEHIND IT. Without this column a
      // wholly unsearchable library renders as three reassuring zeroes.
      expect(
        within(recordings).getByLabelText('Recordings Not indexed'),
      ).toHaveTextContent('5');

      const notes = within(table).getByRole('row', { name: /^Notes/ });
      expect(within(notes).getByLabelText('Notes Not indexed')).toHaveTextContent('7');
    });

    it('names the embedding model the documents were indexed with', async () => {
      mockGetStatus.mockResolvedValue(MIXED);
      await renderPage();

      expect(screen.getByText(/text-embedding-3-small/)).toBeInTheDocument();
    });

    it('summarises how many documents are still waiting', async () => {
      mockGetStatus.mockResolvedValue(MIXED);
      await renderPage();

      // 5 + 4 + 1 unindexed/skipped/failed transcripts, plus 7 unindexed notes.
      expect(screen.getByText(/17 documents not indexed yet/i)).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // The action, and the two reasons it is off
  // ==========================================================================

  describe('the "Index my library" action', () => {
    it('is enabled, and queues on press, when the deployment is ready and the user has a key', async () => {
      const user = userEvent.setup();
      mockGetStatus.mockResolvedValue(MIXED);
      await renderPage();

      const button = screen.getByRole('button', { name: /index my library/i });
      expect(button).toBeEnabled();

      await user.click(button);

      expect(mockRequestIndex).toHaveBeenCalledTimes(1);
      expect(await screen.findByText(/queued 5 documents for indexing/i)).toBeInTheDocument();
    });

    it('is DISABLED with a reason, and a link to the key page, when the user has no key', async () => {
      mockGetStatus.mockResolvedValue(status({ hasKey: false, reason: 'ai_key_missing' }));
      await renderPage();

      expect(screen.getByRole('button', { name: /index my library/i })).toBeDisabled();
      expect(
        screen.getByText(/you have not saved an AI provider key/i),
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /add your AI provider key/i })).toHaveAttribute(
        'href',
        '/settings/ai',
      );
    });

    it('is DISABLED with a DIFFERENT reason — and no key link — when the deployment has no provider', async () => {
      mockGetStatus.mockResolvedValue(
        status({ available: false, hasKey: false, model: null, reason: 'ai_not_configured' }),
      );
      await renderPage();

      expect(screen.getByRole('button', { name: /index my library/i })).toBeDisabled();
      expect(
        screen.getByText(/this deployment has no AI provider configured yet/i),
      ).toBeInTheDocument();
      // Their key is not the missing piece, so they are not sent to go and get one.
      expect(
        screen.queryByRole('link', { name: /add your AI provider key/i }),
      ).not.toBeInTheDocument();
    });

    it('reports the per-call cap when more documents are left over', async () => {
      const user = userEvent.setup();
      mockGetStatus.mockResolvedValue(MIXED);
      mockRequestIndex.mockResolvedValue({ queued: 200, remaining: 300, cap: 200 });
      await renderPage();

      await user.click(screen.getByRole('button', { name: /index my library/i }));

      expect(await screen.findByText(/300 more will be queued/i)).toBeInTheDocument();
      expect(screen.getByText(/at most 200/i)).toBeInTheDocument();
    });

    it("surfaces the API's own 409 message rather than a generic failure", async () => {
      const user = userEvent.setup();
      const { ApiError } = await import('../../services/api');
      mockGetStatus.mockResolvedValue(MIXED);
      mockRequestIndex.mockRejectedValue(
        new ApiError('You have not saved an AI provider key.', 409, 'CONFLICT'),
      );
      await renderPage();

      await user.click(screen.getByRole('button', { name: /index my library/i }));

      expect(
        await screen.findByText('You have not saved an AI provider key.'),
      ).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Failures, in plain language
  // ==========================================================================

  it('explains a failure in words, and still shows an unrecognised reason rather than dropping it', async () => {
    mockGetStatus.mockResolvedValue(
      status({
        types: [counts('transcript', { failed: 2, total: 2 }), counts('note')],
        failures: [
          {
            type: 'transcript',
            id: 't-1',
            title: 'Board meeting',
            reason: 'ai_key_invalid',
            lastError: '401 Unauthorized',
          },
          {
            type: 'note',
            id: 'n-1',
            title: 'Follow-ups',
            // A token this build has never seen — the failure worth reading.
            reason: 'some_future_reason',
            lastError: null,
          },
        ],
      }),
    );
    await renderPage();

    expect(screen.getByText('Board meeting')).toBeInTheDocument();
    expect(
      screen.getByText(/your AI provider refused the key that was saved/i),
    ).toBeInTheDocument();
    expect(screen.getByText('401 Unauthorized')).toBeInTheDocument();
    expect(screen.getByText(/Indexing reported: some_future_reason/)).toBeInTheDocument();
  });

  // ==========================================================================
  // The poll
  // ==========================================================================

  describe('polling', () => {
    it('re-reads while anything is pending, and STOPS the moment nothing is', async () => {
      vi.useFakeTimers();
      let call = 0;
      mockGetStatus.mockImplementation(async () => {
        call += 1;
        return call < 3
          ? status({ types: [counts('transcript', { pending: 2, total: 2 }), counts('note')] })
          : status({ types: [counts('transcript', { indexed: 2, total: 2 }), counts('note')] });
      });

      render(<UserSearchIndexPage />);
      await vi.waitFor(() =>
        expect(screen.getByText(/indexing is running/i)).toBeInTheDocument(),
      );
      expect(mockGetStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_INDEX_POLL_INTERVAL_MS);
      });
      expect(mockGetStatus).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_INDEX_POLL_INTERVAL_MS);
      });
      expect(mockGetStatus).toHaveBeenCalledTimes(3);
      await vi.waitFor(() =>
        expect(screen.queryByText(/indexing is running/i)).not.toBeInTheDocument(),
      );

      // Nothing pending — no further reads on the same clock. This is the
      // assertion that matters: the poll is derived from state, so it has to
      // stop on its own rather than because something cleared a timer.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_INDEX_POLL_INTERVAL_MS * 5);
      });
      expect(mockGetStatus).toHaveBeenCalledTimes(3);
    });

    it('never polls at all for a library with nothing in flight', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      // ⚠ NOT `MIXED`, which carries `pending: 2` — a library with work in
      // flight is the case the test above covers. Here nothing is pending, so
      // `useSearchIndex` passes `0` to `useVisiblePolling`, which is that
      // hook's own "do not poll" value.
      mockGetStatus.mockResolvedValue(
        status({ types: [counts('transcript', { unindexed: 4, total: 4 }), counts('note')] }),
      );

      render(<UserSearchIndexPage />);
      await screen.findByRole('heading', { level: 1, name: /search indexing/i });
      expect(mockGetStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_INDEX_POLL_INTERVAL_MS * 4);
      });
      expect(mockGetStatus).toHaveBeenCalledTimes(1);
    });
  });
});
