import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import { http, HttpResponse, server } from './msw-compat.js';
import { render } from './helpers.js';
import type { MockUser } from './helpers.js';
import { graphReader, graphWriter } from './graphTestUsers.js';
import { gid } from './graphData.js';
import type { DuplicatePair } from '../../src/graph/headless/clients/graph.js';
import { duplicatePairKey } from '../../src/graph/headless/hooks/useGraphDuplicates.js';
import { GraphDuplicatesPage, defaultDuplicateSurvivor } from '../../src/graph/ui/pages/GraphDuplicatesPage.js';
import { GraphIndexPage } from '../../src/graph/ui/pages/GraphIndexPage.js';
import { duplicatesBadgeText } from '../../src/graph/ui/components/DuplicatesLink.js';

/**
 * #766 — the Possible duplicates page: reasons, merge with a survivor choice,
 * Undo, "Not the same", Skip, "Find more duplicates", the read-only view, the
 * type filter, and the entry-point badge on the Knowledge index.
 */

const OAC = { id: gid(601), type: 'Organization', label: 'OAC', aliases: [], mentionCount: 2 };
const ORG_ALPHA = { id: gid(602), type: 'Organization', label: 'Org Alpha Consulting', aliases: ['O&C'], mentionCount: 9 };
const JOSS = { id: gid(603), type: 'Person', label: 'Joss Dummyson', aliases: [], mentionCount: 4 };
const JORY = { id: gid(604), type: 'Person', label: 'Jory Dummyson', aliases: ['Jorry'], mentionCount: 1 };
const MERGE_ID = gid(690);

const ORG_PAIR: DuplicatePair = {
  a: OAC,
  b: ORG_ALPHA,
  score: 0.9,
  reasons: ['initials', 'resolution_proposal'],
  source: 'resolution_proposal',
  proposalItemId: gid(680),
};
const PERSON_PAIR: DuplicatePair = {
  a: JOSS,
  b: JORY,
  score: 0.7,
  reasons: ['similar_name', 'alias_match', 'name_contained'],
  source: 'name_pass',
};

let pairs: DuplicatePair[];
let posts: { path: string; body: unknown }[];
let listUrls: URL[];

beforeEach(() => {
  window.sessionStorage.clear();
  pairs = [ORG_PAIR, PERSON_PAIR];
  posts = [];
  listUrls = [];
  server.use(
    http.get('*/api/graph/duplicates', ({ request }) => {
      listUrls.push(new URL(request.url));
      return HttpResponse.json({ data: { pairs } });
    }),
    http.post('*/api/graph/entities/:id/merge', async ({ request, params }) => {
      const body = (await request.json()) as { intoId: string };
      posts.push({ path: `/graph/entities/${params.id}/merge`, body });
      return HttpResponse.json({
        data: {
          merge: { id: MERGE_ID, survivorId: body.intoId, mergedId: params.id, createdAt: '2026-10-26T10:00:00.000Z' },
          survivor: { id: body.intoId, type: 'Organization', label: 'Org Alpha Consulting', aliasCount: 2 },
        },
      });
    }),
    http.post('*/api/graph/merges/:id/reverse', async ({ request, params }) => {
      posts.push({ path: `/graph/merges/${params.id}/reverse`, body: await request.json() });
      return HttpResponse.json({
        data: {
          merge: { id: params.id, survivorId: ORG_ALPHA.id, mergedId: OAC.id, reversedAt: '2026-10-26T10:05:00.000Z' },
          restored: { id: OAC.id, type: 'Organization', label: 'OAC' },
          skipped: [],
        },
      });
    }),
    http.post('*/api/graph/distinct-pairs', async ({ request }) => {
      const body = (await request.json()) as { aId: string; bId: string };
      posts.push({ path: '/graph/distinct-pairs', body });
      return HttpResponse.json({ data: { aId: body.aId, bId: body.bId, created: true } });
    }),
  );
});

function renderPage(user: MockUser = graphWriter) {
  return render(
    <Routes>
      <Route path="/graph/duplicates" element={<GraphDuplicatesPage />} />
    </Routes>,
    { wrapperOptions: { route: '/graph/duplicates', user } },
  );
}

const card = (name: string) => screen.findByRole('article', { name });
const ORG_CARD = 'OAC and Org Alpha Consulting';
const PERSON_CARD = 'Joss Dummyson and Jory Dummyson';

describe('GraphDuplicatesPage — list', () => {
  it('renders each pair with names linking to entity pages, types, aliases, mentions and human reasons', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Possible duplicates' })).toBeInTheDocument();
    const org = await card(ORG_CARD);
    expect(within(org).getByRole('link', { name: 'OAC' })).toHaveAttribute('href', `/graph/entities/${OAC.id}`);
    expect(within(org).getByRole('link', { name: 'Org Alpha Consulting' })).toHaveAttribute('href', `/graph/entities/${ORG_ALPHA.id}`);
    expect(within(org).getByText('Organization · 9 mentions')).toBeInTheDocument();
    expect(within(org).getByRole('list', { name: 'Other names of Org Alpha Consulting' })).toHaveTextContent('O&C');
    const reasons = within(org).getByRole('list', { name: 'Why these may be the same' });
    expect(within(reasons).getByText('Initials match')).toBeInTheDocument();
    expect(within(reasons).getByText('Suggested by KVox')).toBeInTheDocument();

    const person = await card(PERSON_CARD);
    const personReasons = within(person).getByRole('list', { name: 'Why these may be the same' });
    expect(within(personReasons).getByText('Similar spelling')).toBeInTheDocument();
    expect(within(personReasons).getByText('Same alias')).toBeInTheDocument();
    expect(within(personReasons).getByText('Name contained in the other')).toBeInTheDocument();
    expect(listUrls[0]?.searchParams.get('limit')).toBe('200');
  });

  it('filters by type with the ontology plural labels of the types present, plus All', async () => {
    const user = userEvent.setup();
    renderPage();
    await card(ORG_CARD);
    const group = screen.getByRole('group', { name: 'Filter by type' });
    const chips = within(group).getAllByRole('button').map((chip) => chip.textContent);
    expect(chips).toEqual(['All', 'People', 'Organizations']);

    await user.click(within(group).getByRole('button', { name: 'People' }));
    expect(screen.queryByRole('article', { name: ORG_CARD })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: PERSON_CARD })).toBeInTheDocument();

    await user.click(within(group).getByRole('button', { name: 'All' }));
    expect(screen.getByRole('article', { name: ORG_CARD })).toBeInTheDocument();
  });

  it('shows the empty state with Find more duplicates', async () => {
    pairs = [];
    renderPage();
    expect(await screen.findByText('No duplicates found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find more duplicates' })).toBeInTheDocument();
  });
});

describe('GraphDuplicatesPage — actions', () => {
  it('merges with the survivor the person keeps, removes the pair, and Undo reverses and reloads', async () => {
    const user = userEvent.setup();
    renderPage();
    const org = await card(ORG_CARD);
    await user.click(within(org).getByRole('button', { name: 'Merge' }));

    const dialog = await screen.findByRole('dialog', { name: 'Merge these entities?' });
    // Default: the side with more mentions (Org Alpha Consulting, 9) is kept.
    expect(within(dialog).getByRole('radio', { name: /Org Alpha Consulting/ })).toBeChecked();
    expect(within(dialog).getByText('“OAC” will become an alias of “Org Alpha Consulting”.')).toBeInTheDocument();

    // Choose to keep OAC instead.
    await user.click(within(dialog).getByRole('radio', { name: /^OAC/ }));
    expect(within(dialog).getByText('“Org Alpha Consulting” will become an alias of “OAC”.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('article', { name: ORG_CARD })).not.toBeInTheDocument();
    expect(posts).toEqual([{ path: `/graph/entities/${ORG_ALPHA.id}/merge`, body: { intoId: OAC.id } }]);
    expect(screen.getByRole('article', { name: PERSON_CARD })).toBeInTheDocument();
    expect(await screen.findByText('Merged “Org Alpha Consulting” into “OAC”')).toBeInTheDocument();

    const before = listUrls.length;
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ path: `/graph/merges/${MERGE_ID}/reverse`, body: {} }));
    expect(await screen.findByText('Merge undone')).toBeInTheDocument();
    await waitFor(() => expect(listUrls.length).toBe(before + 1));
    expect(await card(ORG_CARD)).toBeInTheDocument();
  });

  it('records "Not the same", removes the pair and says so', async () => {
    const user = userEvent.setup();
    renderPage();
    const person = await card(PERSON_CARD);
    await user.click(within(person).getByRole('button', { name: 'Not the same' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: PERSON_CARD })).not.toBeInTheDocument());
    expect(posts).toEqual([{ path: '/graph/distinct-pairs', body: { aId: JOSS.id, bId: JORY.id } }]);
    expect(await screen.findByText('Marked “Joss Dummyson” and “Jory Dummyson” as not the same')).toBeInTheDocument();
  });

  it('Skip hides the pair for the session without a request', async () => {
    const user = userEvent.setup();
    const first = renderPage();
    const org = await card(ORG_CARD);
    await user.click(within(org).getByRole('button', { name: 'Skip' }));
    expect(screen.queryByRole('article', { name: ORG_CARD })).not.toBeInTheDocument();
    expect(posts).toEqual([]);

    first.unmount();
    renderPage();
    await card(PERSON_CARD);
    expect(screen.queryByRole('article', { name: ORG_CARD })).not.toBeInTheDocument();
  });

  it.each([
    [false, 'Looking for duplicates… results appear here when the scan finishes'],
    [true, 'Already looking for duplicates… results appear here when the scan finishes'],
  ])('Find more duplicates queues the scan (alreadyRunning %s)', async (alreadyRunning, message) => {
    server.use(
      http.post('*/api/graph/duplicates/scan', () =>
        HttpResponse.json({ data: { queued: true, alreadyRunning, jobId: gid(670) } }, { status: 202 }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await card(ORG_CARD);
    await user.click(screen.getByRole('button', { name: 'Find more duplicates' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it('says so when connected knowledge is off', async () => {
    server.use(
      http.post('*/api/graph/duplicates/scan', () =>
        HttpResponse.json(
          { statusCode: 409, message: 'off', details: { reason: 'graph_disabled' } },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await card(ORG_CARD);
    await user.click(screen.getByRole('button', { name: 'Find more duplicates' }));
    expect(await screen.findByText('Connected knowledge is switched off on this deployment.')).toBeInTheDocument();
  });

  it('shows a read-only viewer the list without any action', async () => {
    renderPage(graphReader);
    const org = await card(ORG_CARD);
    expect(within(org).getByText('Initials match')).toBeInTheDocument();
    for (const name of ['Merge', 'Not the same', 'Skip']) {
      expect(within(org).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Find more duplicates' })).not.toBeInTheDocument();
  });
});

describe('duplicates helpers', () => {
  it('keeps the side with more mentions; a tie keeps a', () => {
    expect(defaultDuplicateSurvivor(ORG_PAIR).id).toBe(ORG_ALPHA.id);
    expect(defaultDuplicateSurvivor(PERSON_PAIR).id).toBe(JOSS.id);
    expect(defaultDuplicateSurvivor({ a: OAC, b: { ...ORG_ALPHA, mentionCount: 2 } }).id).toBe(OAC.id);
  });

  it('keys a pair the same whichever side is a', () => {
    expect(duplicatePairKey({ a: OAC, b: ORG_ALPHA })).toBe(duplicatePairKey({ a: ORG_ALPHA, b: OAC }));
  });

  it('reads the badge as a count, nothing for none, and "50+" at the limit', () => {
    expect(duplicatesBadgeText(0)).toBeNull();
    expect(duplicatesBadgeText(3)).toBe('3');
    expect(duplicatesBadgeText(50)).toBe('50+');
  });
});

describe('Possible duplicates entry point on the Knowledge index', () => {
  function renderIndex() {
    return render(
      <Routes>
        <Route path="/graph/entities" element={<GraphIndexPage />} />
      </Routes>,
      { wrapperOptions: { route: '/graph/entities', user: graphWriter } },
    );
  }

  it('links to the page with the count from one limit=50 read', async () => {
    renderIndex();
    const link = await screen.findByRole('link', { name: 'Possible duplicates (2)' });
    expect(link).toHaveAttribute('href', '/graph/duplicates');
    expect(listUrls).toHaveLength(1);
    expect(listUrls[0]?.searchParams.get('limit')).toBe('50');
  });

  it('reads "50+" when the answer is full', async () => {
    pairs = Array.from({ length: 50 }, (_, n) => ({
      ...PERSON_PAIR,
      a: { ...JOSS, id: gid(1000 + n) },
      b: { ...JORY, id: gid(2000 + n) },
    }));
    renderIndex();
    expect(await screen.findByRole('link', { name: 'Possible duplicates (50+)' })).toBeInTheDocument();
  });
});
