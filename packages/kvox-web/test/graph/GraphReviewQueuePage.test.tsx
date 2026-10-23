/**
 * `/graph/review-queue` (#721): drafts grouped by library and import, the
 * safe-policy batch commit, and the helpers behind them.
 */

import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { describe, expect, it } from 'vitest';

import { createFakeKvoxWebHost, fakeApiError, renderWithKvoxHost } from '../../src/core/testing/index.js';
import type { FakeKvoxWebHost, FakeRoute } from '../../src/core/testing/index.js';
import type {
  CommitBatchResult,
  ReviewQueueGroup,
  ReviewQueueProposal,
  ReviewQueueResponse,
} from '../../src/graph/headless/index.js';
import {
  commitOutcomeMessage,
  reviewGroupLabel,
  summarizeCommitBatch,
  waitReasonCopy,
  SAFE_POLICY_WAIT_REASON_ORDER,
} from '../../src/graph/headless/index.js';
import { GraphReviewQueuePage, reviewGroupTarget } from '../../src/graph/ui/index.js';
import { resolveActiveDestination, shellDestinationRoutes } from '@marinoscar/platform-web/shell/headless';

import { createKvoxNavigation } from '../../src/shell/index.js';
import { gid } from './graphData.js';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
const LIBRARY_ID = gid(701);
const BATCH_ID = gid(702);

function proposal(n: number, over: Partial<ReviewQueueProposal> = {}): ReviewQueueProposal {
  return {
    proposalId: gid(800 + n),
    noteId: gid(900 + n),
    noteTitle: `Note ${n}`,
    noteVersion: 2,
    stale: false,
    counts: { total: 10, safe: 8, waiting: 2 },
    createdAt: '2026-10-23T14:02:00.000Z',
    ...over,
  };
}

function group(key: ReviewQueueGroup['key'], proposals: ReviewQueueProposal[]): ReviewQueueGroup {
  const sum = (pick: (p: ReviewQueueProposal) => number) => proposals.reduce((n, p) => n + pick(p), 0);
  return {
    key,
    proposals,
    totals: {
      proposals: proposals.length,
      stale: proposals.filter((p) => p.stale).length,
      total: sum((p) => p.counts.total),
      safe: sum((p) => p.counts.safe),
      waiting: sum((p) => p.counts.waiting),
    },
  };
}

function queueOf(groups: ReviewQueueGroup[], truncated = false): ReviewQueueResponse {
  const all = groups.flatMap((g) => g.proposals);
  return {
    groups,
    totals: {
      proposals: all.length,
      stale: all.filter((p) => p.stale).length,
      total: all.reduce((n, p) => n + p.counts.total, 0),
      safe: all.reduce((n, p) => n + p.counts.safe, 0),
      waiting: all.reduce((n, p) => n + p.counts.waiting, 0),
    },
    minConfidence: 0.7,
    truncated,
  };
}

const libraryGroup = () =>
  group({ type: 'library', id: LIBRARY_ID, label: 'Work notes' }, [proposal(1), proposal(2, { stale: true })]);
const batchGroup = () => group({ type: 'batch', id: BATCH_ID, label: 'Import 2026-10-23' }, [proposal(3)]);
const otherGroup = () => group({ type: 'other', id: null, label: 'Individual notes' }, [proposal(4)]);

function makeHost(
  permissions: string[],
  queue: ReviewQueueResponse | (() => ReviewQueueResponse),
  commit?: FakeRoute,
): FakeKvoxWebHost {
  return createFakeKvoxWebHost({
    viewer: { userId: 'u1', permissions },
    routes: {
      'GET /graph/review-queue': () => (typeof queue === 'function' ? queue() : queue),
      ...(commit === undefined ? {} : { 'POST /graph/proposals/commit-batch': commit }),
    },
  });
}

function renderPage(host: FakeKvoxWebHost, route = '/graph/review-queue') {
  return renderWithKvoxHost(
    <Routes>
      <Route path="/graph/review-queue" element={<GraphReviewQueuePage />} />
      <Route path="*" element={<p>elsewhere</p>} />
    </Routes>,
    host,
    { route },
  );
}

const WRITER = ['graph:read', 'graph:write'];

describe('GraphReviewQueuePage', () => {
  it('renders the totals and one card per group with its label and counts', async () => {
    const host = makeHost(WRITER, queueOf([libraryGroup(), batchGroup(), otherGroup()]));
    const { container } = renderPage(host);

    expect(await screen.findByText('4 drafts · 32 safe rows · 8 need you')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Review Queue' })).toBeInTheDocument();
    const work = screen.getByRole('region', { name: 'Work notes' });
    expect(within(work).getByText('2 drafts · 16 safe rows · 4 need you · 1 stale')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Import of Oct 23, 2026' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Other notes' })).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('expands a group into its drafts, with a stale chip, note links and Review links', async () => {
    const user = userEvent.setup();
    renderPage(makeHost(WRITER, queueOf([libraryGroup()])));
    const work = await screen.findByRole('region', { name: 'Work notes' });
    await user.click(within(work).getByRole('button', { name: 'Show 2 notes' }));

    const table = within(work).getByRole('table', { name: 'Drafts of Work notes' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByRole('link', { name: 'Note 1' })).toHaveAttribute('href', `/notes/${gid(901)}`);
    expect(within(rows[1]!).getByRole('link', { name: 'Review Note 1' })).toHaveAttribute(
      'href',
      `/notes/${gid(901)}?review=1`,
    );
    expect(within(rows[1]!).queryByText('Stale')).not.toBeInTheDocument();
    expect(within(rows[2]!).getByText('Stale')).toBeInTheDocument();
  });

  it('confirms, commits a library and reports partial failures and the rows still waiting', async () => {
    const user = userEvent.setup();
    let committed = false;
    const bodies: unknown[] = [];
    const results: CommitBatchResult[] = [
      { proposalId: gid(801), status: 'committed', accepted: 8, waiting: 2, remainderProposalId: gid(850) },
      { proposalId: gid(802), status: 'skipped', accepted: 0, waiting: 0, reason: 'stale' },
      { proposalId: gid(803), status: 'failed', accepted: 0, waiting: 3, reason: 'graph_conflict' },
    ];
    const host = makeHost(
      WRITER,
      () => (committed ? queueOf([]) : queueOf([libraryGroup()])),
      ({ body }) => {
        bodies.push(body);
        committed = true;
        return { results };
      },
    );
    renderPage(host);

    await user.click(await screen.findByRole('button', { name: 'Accept & commit safe rows of Work notes' }));
    const dialog = screen.getByRole('dialog', { name: 'Accept & commit safe rows?' });
    expect(dialog).toHaveTextContent('16 safe rows across 1 note will be accepted');
    expect(dialog).toHaveTextContent('4 rows stay here for you to review. 1 stale note is skipped.');
    expect(bodies).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Accept & commit' }));

    const outcome = await screen.findByText(
      'Committed 1 note · 5 rows waiting for you · 1 skipped (stale) · 1 failed.',
    );
    expect(bodies).toEqual([{ libraryId: LIBRARY_ID, policy: 'safe' }]);
    const alert = outcome.closest('[role="status"]') as HTMLElement;
    expect(alert).toHaveTextContent('The rows waiting for you are in 1 new draft in this queue.');
    expect(within(alert).getByRole('list', { name: 'Failed notes' })).toHaveTextContent(
      'A note: It could not be committed (graph_conflict).',
    );
    // The queue was re-read after the commit: the group is gone, its outcome stays.
    expect(await screen.findByText('Nothing to review — your graph is up to date')).toBeInTheDocument();
  });

  it('commits the notes outside any batch by their non-stale ids', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const other = group({ type: 'other', id: null, label: 'Individual notes' }, [
      proposal(4),
      proposal(5, { stale: true }),
    ]);
    renderPage(
      makeHost(WRITER, queueOf([other]), ({ body }) => {
        bodies.push(body);
        return { results: [] };
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Accept & commit safe rows of Other notes' }));
    await user.click(screen.getByRole('button', { name: 'Accept & commit' }));
    await waitFor(() => expect(bodies).toEqual([{ proposalIds: [gid(804)], policy: 'safe' }]));
  });

  it('shows the request failure when the commit is refused', async () => {
    const user = userEvent.setup();
    renderPage(
      makeHost(WRITER, queueOf([batchGroup()]), () => {
        throw fakeApiError(409, 'Another commit is running');
      }),
    );
    await user.click(await screen.findByRole('button', { name: /^Accept & commit safe rows of Import of/ }));
    await user.click(screen.getByRole('button', { name: 'Accept & commit' }));
    expect(await screen.findByText('Another commit is running')).toBeInTheDocument();
  });

  it('draws no commit button without graph:write', async () => {
    renderPage(makeHost(['graph:read'], queueOf([libraryGroup()])));
    await screen.findByRole('region', { name: 'Work notes' });
    expect(screen.queryByRole('button', { name: /Accept & commit/ })).not.toBeInTheDocument();
  });

  it('shows the empty state with a link to the libraries', async () => {
    renderPage(makeHost(WRITER, queueOf([])));
    expect(await screen.findByText('Nothing to review — your graph is up to date')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Libraries' })).toHaveAttribute('href', '/notes/libraries');
  });

  it('says the list was cut at 500', async () => {
    renderPage(makeHost(WRITER, queueOf([libraryGroup()], true)));
    expect(await screen.findByText(/Showing the first 500 drafts/)).toBeInTheDocument();
  });

  it('focuses one library from ?libraryId=, opened, with Show all', async () => {
    renderPage(makeHost(WRITER, queueOf([libraryGroup(), batchGroup()])), `/graph/review-queue?libraryId=${LIBRARY_ID}`);
    const work = await screen.findByRole('region', { name: 'Work notes' });
    expect(within(work).getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Import of/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Show all' })).toHaveAttribute('href', '/graph/review-queue');
  });

  it('explains the waiting reasons in the What is safe? popover', async () => {
    const user = userEvent.setup();
    renderPage(makeHost(WRITER, queueOf([libraryGroup()])));
    await user.click(await screen.findByRole('button', { name: 'What is safe?' }));
    const list = await screen.findByRole('list', { name: 'Why a row waits for you' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(SAFE_POLICY_WAIT_REASON_ORDER.length);
    expect(list).toHaveTextContent('less sure than your minimum confidence (70%)');
  });
});

describe('review queue helpers', () => {
  it('labels groups', () => {
    expect(reviewGroupLabel({ type: 'other', id: null, label: 'Individual notes' })).toBe('Other notes');
    expect(reviewGroupLabel({ type: 'library', id: LIBRARY_ID, label: 'Work notes' })).toBe('Work notes');
    expect(reviewGroupLabel({ type: 'batch', id: BATCH_ID, label: 'Import 2026-10-23' })).toBe('Import of Oct 23, 2026');
  });

  it('targets a group by library, batch or non-stale ids', () => {
    expect(reviewGroupTarget(libraryGroup())).toEqual({ libraryId: LIBRARY_ID });
    expect(reviewGroupTarget(batchGroup())).toEqual({ batchId: BATCH_ID });
    expect(reviewGroupTarget(group({ type: 'other', id: null, label: '' }, [proposal(9, { stale: true })]))).toBeNull();
  });

  it('summarizes outcomes and words every reason', () => {
    const summary = summarizeCommitBatch([
      { proposalId: gid(1), status: 'committed', accepted: 3, waiting: 0, remainderProposalId: null },
      { proposalId: gid(2), status: 'skipped', accepted: 0, waiting: 4, reason: 'nothing_to_commit' },
    ]);
    expect(summary).toMatchObject({ committed: 1, accepted: 3, waiting: 4, remainders: 0, stale: 0, skipped: 1 });
    expect(commitOutcomeMessage('stale')).toMatch(/changed/);
    for (const reason of SAFE_POLICY_WAIT_REASON_ORDER) expect(waitReasonCopy(reason).body.length).toBeGreaterThan(10);
  });

  it('lets Review own the queue when a host lists it (Desktop)', () => {
    const { navigation } = createKvoxNavigation({ include: ['graph', 'review'], settingsPath: '/settings' });
    const routes = shellDestinationRoutes(navigation);
    expect(resolveActiveDestination(routes, '/graph/review-queue')).toBe('review');
    expect(resolveActiveDestination(routes, '/graph/review')).toBe('review');
  });
});
