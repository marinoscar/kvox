import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useImperativeHandle, type ReactElement } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import type { EvidenceLink, GraphEntityDetail, TimelineEvent } from '../../src/graph/headless/clients/graph.js';
import type { GraphCanvasProps } from '../../src/graph/ui/components/explorer/GraphCanvas.js';
import { GraphExplorerPage, type GraphExplorerPageSlots } from '../../src/graph/ui/pages/GraphExplorerPage.js';
import { setViewportWidth } from '../../src/core/testing/index.js';
import {
  ACME_ID,
  ANA_ID,
  EV_EDGE_GONE,
  EV_EDGE_NOTE,
  JOE_ID,
  NOTE_ID,
  entityDetail,
  expandFixture,
  gid,
  hubFixture,
  type ExpandFixtureRequest,
} from './graphData.js';
import { graphReader } from './graphTestUsers.js';
import { HttpResponse, http, server } from './msw-compat.js';
import { render } from './helpers.js';
import { mockTouchInput } from './shellMedia.js';

/**
 * The evidence-first inspector inside `/graph/explore` (GIC-11, #672). jsdom has
 * no WebGL, so the canvas is a fake with one button per node and edge; every rule
 * under test lives in the inspector and the explorer hook.
 */

const mocks = vi.hoisted(() => ({
  controls: {
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fit: vi.fn(),
    relayoutAll: vi.fn(),
    togglePin: vi.fn(),
    unpinAll: vi.fn(),
    isPinned: vi.fn(() => false),
  },
}));

vi.mock('../../src/graph/ui/components/explorer/webgl.js', () => ({
  isWebGLAvailable: () => true,
  resetWebGLDetection: () => undefined,
}));

vi.mock('../../src/graph/ui/components/explorer/GraphCanvas.js', () => ({
  GraphCanvas: function FakeGraphCanvas(props: GraphCanvasProps) {
    useImperativeHandle(props.controlsRef, () => mocks.controls, []);
    return (
      <div data-testid="fake-canvas">
        {[...props.visibleIds].sort().map((id) => (
          <button
            key={id}
            type="button"
            data-marked={props.markedIds?.has(id) ?? false}
            onClick={() =>
              props.graph.getNodeAttribute(id, 'isStub') === true ? props.onNodeDoubleClick(id) : props.onNodeClick(id)
            }
          >
            {String(props.graph.getNodeAttribute(id, 'label'))}
          </button>
        ))}
        {props.graph.edges().map((id) => (
          <button key={id} type="button" onClick={() => props.onEdgeClick?.(id)}>
            {`edge ${id}`}
          </button>
        ))}
        <button type="button" onClick={props.onStageClick}>
          stage
        </button>
      </div>
    );
  },
}));

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

let expandBodies: ExpandFixtureRequest[];

function useExpand(respond?: (body: ExpandFixtureRequest) => HttpResponse | Promise<HttpResponse>) {
  server.use(
    http.post('*/api/graph/explore/expand', async ({ request }) => {
      const body = (await request.json()) as ExpandFixtureRequest;
      expandBodies.push(body);
      if (respond) return respond(body);
      const slice = expandFixture(body);
      return slice
        ? HttpResponse.json({ data: slice })
        : HttpResponse.json({ message: 'Entity not found', statusCode: 404 }, { status: 404 });
    }),
  );
}

beforeEach(() => {
  expandBodies = [];
  useExpand();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function NotePage() {
  const navigate = useNavigate();
  return (
    <>
      <h1>Note page</h1>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  );
}

function currentUrl(): URL {
  return new URL(screen.getByTestId('location').textContent ?? '/', 'http://x');
}

function renderExplorer(options: { route?: string; slots?: GraphExplorerPageSlots; graphEnabled?: boolean } = {}) {
  const { route = `/graph/explore?seed=${JOE_ID}`, slots, graphEnabled } = options;
  const ui: ReactElement = (
    <>
      <Routes>
        <Route path="/graph/explore" element={<GraphExplorerPage slots={slots} />} />
        <Route path="/graph/entities/:id" element={<h1>Entity page</h1>} />
        <Route path="/notes/:id" element={<NotePage />} />
        <Route path="/transcripts/:id" element={<h1>Transcript page</h1>} />
      </Routes>
      <LocationProbe />
    </>
  );
  return render(ui, {
    wrapperOptions: { route, user: graphReader },
    ...(graphEnabled === undefined ? {} : { hostOptions: { features: { graphEnabled } } }),
  });
}

async function canvasReady() {
  const canvas = await screen.findByTestId('fake-canvas');
  await within(canvas).findByRole('button', { name: 'Acme Corp' });
  return canvas;
}

const REPORTS_TO_EDGE = `edge ${gid(411)}`;

/** Select the REPORTS_TO edge and return the inspector group. */
async function openEdge(user: ReturnType<typeof userEvent.setup>) {
  const canvas = await canvasReady();
  await user.click(within(canvas).getByRole('button', { name: REPORTS_TO_EDGE }));
  return { canvas, panel: await screen.findByRole('group', { name: 'Reports to' }) };
}

async function openNode(user: ReturnType<typeof userEvent.setup>, label: string) {
  const canvas = await canvasReady();
  await user.click(within(canvas).getByRole('button', { name: label }));
  return { canvas, panel: await screen.findByRole('group', { name: label }) };
}

/** A note-sourced citation with a title the test can name. */
function noteLink(id: string, n: number): EvidenceLink {
  return {
    id,
    subjectKind: 'item',
    subjectId: gid(1),
    quote: `Quote number ${n}`,
    createdAt: '2026-09-02T10:00:00.000Z',
    source: {
      kind: 'note',
      noteId: NOTE_ID,
      noteTitle: `Note ${n}`,
      noteVersion: 1,
      currentNoteVersion: 1,
      charStart: 0,
      charEnd: 5,
      versionChanged: false,
      available: true,
      href: `/notes/${NOTE_ID}?v=1`,
    },
  };
}

const evId = (n: number) => `00000000-0000-4000-8000-${String(900000 + n).padStart(12, '0')}`;

describe('the Evidence tab of an edge', () => {
  it('opens on the quotes, as articles named by source and date, with the unavailable badge', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const { panel } = await openEdge(user);

    const tab = within(panel).getByRole('tab', { name: 'Evidence', selected: true });
    expect(tab).toBeInTheDocument();
    const cards = await within(panel).findAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAccessibleName(/^Org changes, /);
    expect(within(cards[0]!).getByText('“Joe now reports to Ana.”')).toBeInTheDocument();
    // The second source is gone: the quote stays, the link does not.
    expect(within(cards[1]!).getByText('“Ana is taking over the platform group.”')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Source unavailable')).toBeInTheDocument();
    expect(within(cards[1]!).queryByRole('link', { name: /Open at source/ })).not.toBeInTheDocument();
  });

  it('"Open at source" navigates to the deep link, and Back returns to the same canvas state', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const { panel } = await openEdge(user);

    await user.click(await within(panel).findByRole('link', { name: 'Open at source: Org changes' }));
    expect(await screen.findByRole('heading', { name: 'Note page' })).toBeInTheDocument();
    expect(currentUrl().pathname).toBe(`/notes/${NOTE_ID}`);
    expect(currentUrl().search).toBe('?v=2');

    await user.click(screen.getByRole('button', { name: 'Back' }));
    // The same seeds, the same edge, the same tab — read back from the URL.
    const again = await screen.findByRole('group', { name: 'Reports to' });
    expect(within(again).getByRole('tab', { name: 'Evidence', selected: true })).toBeInTheDocument();
    expect(await within(again).findAllByRole('article')).toHaveLength(2);
    expect(currentUrl().searchParams.get('sel')).toBe(`e:${gid(411)}`);
  });

  it('keeps the selection and the tab in the URL, and drops the tab when another node is picked', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const { canvas, panel } = await openEdge(user);
    await waitFor(() => expect(currentUrl().searchParams.get('sel')).toBe(`e:${gid(411)}`));

    await user.click(within(panel).getByRole('tab', { name: 'Overview' }));
    await waitFor(() => expect(currentUrl().searchParams.get('tab')).toBe('overview'));

    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    await waitFor(() => expect(currentUrl().searchParams.get('sel')).toBe(`n:${ACME_ID}`));
    expect(currentUrl().searchParams.get('tab')).toBeNull();

    await user.click(within(canvas).getByRole('button', { name: 'stage' }));
    await waitFor(() => expect(currentUrl().searchParams.get('sel')).toBeNull());
  });

  it('restores a selection from the URL once the graph has arrived, and drops one that is not on it', async () => {
    renderExplorer({ route: `/graph/explore?seed=${JOE_ID}&sel=n:${ACME_ID}&tab=timeline` });
    const panel = await screen.findByRole('group', { name: 'Acme Corp' });
    expect(within(panel).getByRole('tab', { name: 'Timeline', selected: true })).toBeInTheDocument();
  });

  it('forgets a selection the graph does not contain', async () => {
    renderExplorer({ route: `/graph/explore?seed=${JOE_ID}&sel=n:${gid(9999)}&tab=evidence` });
    await canvasReady();
    await waitFor(() => expect(currentUrl().searchParams.get('sel')).toBeNull());
    expect(currentUrl().searchParams.get('tab')).toBeNull();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });
});

describe('the Evidence tab of an entity', () => {
  /** 30 timeline events of 5 ids each, over two pages: 150 ids. */
  function serveLongTimeline() {
    const asked: string[][] = [];
    const timelineCalls: Array<{ cursor: string | null; includeSensitive: string | null }> = [];
    const event = (n: number): TimelineEvent => ({
      id: `m${n}`,
      eventKind: 'meeting',
      at: null,
      precision: 'unknown',
      meeting: { id: gid(70), label: 'Weekly sync', type: 'Meeting' },
      evidenceIds: [0, 1, 2, 3, 4].map((k) => evId(n * 5 + k)),
      evidenceCount: 5,
    });
    server.use(
      http.get('*/api/graph/entities/:id/timeline', ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get('cursor');
        timelineCalls.push({ cursor, includeSensitive: url.searchParams.get('includeSensitive') });
        const first = cursor === null;
        return HttpResponse.json({
          data: {
            items: Array.from({ length: 15 }, (_, i) => event((first ? 0 : 15) + i)),
            nextCursor: first ? 'page-2' : null,
            asOf: '2026-09-26T00:00:00.000Z',
          },
        });
      }),
      http.get('*/api/graph/evidence', ({ request }) => {
        const ids = new URL(request.url).searchParams.get('ids')?.split(',') ?? [];
        asked.push(ids);
        return HttpResponse.json({ data: { items: ids.map((id, i) => noteLink(id, Number(id.slice(-6)) - 900000 + i * 0)) } });
      }),
    );
    return { asked, timelineCalls };
  }

  it('pages twenty at a time beyond 50 ids, resolving in chunks of at most 50', async () => {
    const { asked, timelineCalls } = serveLongTimeline();
    const user = userEvent.setup();
    renderExplorer();
    const { panel } = await openNode(user, 'Acme Corp');
    await user.click(within(panel).getByRole('tab', { name: 'Evidence' }));

    await waitFor(() => expect(within(panel).getAllByRole('article')).toHaveLength(20));
    // The first window is 50 ids, though only 20 show.
    expect(asked[0]).toHaveLength(50);

    await user.click(within(panel).getByRole('button', { name: 'Show more evidence' }));
    await waitFor(() => expect(within(panel).getAllByRole('article')).toHaveLength(40));
    await user.click(within(panel).getByRole('button', { name: 'Show more evidence' }));
    // 60 is past the first window of 50, so a second chunk is fetched.
    await waitFor(() => expect(within(panel).getAllByRole('article')).toHaveLength(60));
    expect(asked.length).toBeGreaterThanOrEqual(2);
    for (const ids of asked) expect(ids.length).toBeLessThanOrEqual(50);

    // All the way: the second timeline page is read, 150 distinct ids, never a sensitive request.
    for (let shown = 60; shown < 150; shown += 20) {
      await user.click(within(panel).getByRole('button', { name: 'Show more evidence' }));
      await waitFor(() => expect(within(panel).getAllByRole('article')).toHaveLength(Math.min(150, shown + 20)));
    }
    expect(timelineCalls.map((c) => c.cursor)).toEqual([null, 'page-2']);
    expect(timelineCalls.every((c) => c.includeSensitive === null)).toBe(true);
    expect(new Set(asked.flat()).size).toBe(150);
    expect(within(panel).queryByRole('button', { name: 'Show more evidence' })).not.toBeInTheDocument();
  });

  it('never requests the evidence of a sensitive person fact, even one a timeline lets through', async () => {
    const asked: string[][] = [];
    const bySubject: string[] = [];
    server.use(
      http.get('*/api/graph/entities/:id/timeline', () =>
        HttpResponse.json({
          data: {
            items: [
              {
                id: 'ok',
                eventKind: 'meeting',
                at: null,
                precision: 'unknown',
                meeting: { id: gid(70), label: 'Weekly sync', type: 'Meeting' },
                evidenceIds: [evId(1)],
                evidenceCount: 1,
              },
              {
                id: 'leak',
                eventKind: 'item',
                at: null,
                precision: 'unknown',
                item: {
                  id: gid(71),
                  kind: 'person_fact',
                  title: null,
                  statement: 'Hidden fact',
                  status: null,
                  dueAt: null,
                  ownerPerson: null,
                  counterparty: null,
                  sensitivity: 'sensitive',
                  superseded: false,
                  supersededById: null,
                },
                evidenceIds: [evId(666)],
                evidenceCount: 1,
              },
            ],
            nextCursor: null,
            asOf: '2026-09-26T00:00:00.000Z',
          },
        }),
      ),
      http.get('*/api/graph/evidence/by-subject', ({ request }) => {
        bySubject.push(new URL(request.url).search);
        return HttpResponse.json({ data: { items: [] } });
      }),
      http.get('*/api/graph/evidence', ({ request }) => {
        const ids = new URL(request.url).searchParams.get('ids')?.split(',') ?? [];
        asked.push(ids);
        return HttpResponse.json({ data: { items: ids.map((id) => noteLink(id, 1)) } });
      }),
    );
    const user = userEvent.setup();
    renderExplorer();
    const { panel } = await openNode(user, 'Acme Corp');
    await user.click(within(panel).getByRole('tab', { name: 'Evidence' }));
    expect(await within(panel).findAllByRole('article')).toHaveLength(1);
    expect(asked.flat()).toEqual([evId(1)]);
    expect(asked.flat()).not.toContain(evId(666));
    expect(bySubject).toHaveLength(1);
    expect(bySubject[0]).toContain('kind=entity');
  });

  it('asks nothing about a person fact node: there is no client path to its evidence', async () => {
    const factId = gid(72);
    const bySubject: string[] = [];
    const evidenceCalls: string[] = [];
    useExpand((body) => {
      const slice = expandFixture(body)!;
      return HttpResponse.json({
        data: {
          ...slice,
          nodes: [
            ...slice.nodes,
            { id: factId, nodeKind: 'item', type: 'person_fact', label: 'Likes sailing', depth: 1, degree: 1, status: null, occurredAt: null },
          ],
          edges: [
            ...slice.edges,
            { id: `virt:${factId}:ABOUT`, type: 'ABOUT', source: factId, target: JOE_ID, valid: null, confidence: null, virtual: true },
          ],
        },
      });
    });
    server.use(
      http.get('*/api/graph/evidence/by-subject', ({ request }) => {
        bySubject.push(new URL(request.url).search);
        return HttpResponse.json({ data: { items: [] } });
      }),
      http.get('*/api/graph/evidence', ({ request }) => {
        evidenceCalls.push(new URL(request.url).search);
        return HttpResponse.json({ data: { items: [] } });
      }),
    );
    const user = userEvent.setup();
    renderExplorer();
    const { canvas, panel } = await openNode(user, 'Likes sailing');
    await user.click(within(panel).getByRole('tab', { name: 'Evidence' }));
    expect(await within(panel).findByText('Evidence for personal facts is not shown on the canvas.')).toBeInTheDocument();

    // The edge to the fact is no different.
    await user.click(within(canvas).getByRole('button', { name: `edge virt:${factId}:ABOUT` }));
    const edgePanel = await screen.findByRole('group', { name: 'About' });
    expect(await within(edgePanel).findByText('Evidence for personal facts is not shown on the canvas.')).toBeInTheDocument();
    expect(bySubject).toEqual([]);
    expect(evidenceCalls).toEqual([]);
  });
});

describe('Expand by type', () => {
  function serveCounts(counts: Partial<GraphEntityDetail['counts']>) {
    server.use(
      http.get('*/api/graph/entities/:id', ({ params }) => {
        const id = String(params.id);
        const base = entityDetail(id);
        return HttpResponse.json({ data: { ...base, counts: { ...base.counts, ...counts } } });
      }),
    );
  }

  it('offers relation types and entity types with their counts, and Expand by relation adds only that relation', async () => {
    serveCounts({
      relationsByType: { WORKS_FOR: 3, PART_OF: 1 },
      relationsByNeighborType: { Person: 3, Project: 1 },
    });
    const user = userEvent.setup();
    renderExplorer();
    const { canvas, panel } = await openNode(user, 'Acme Corp');

    await user.click(await within(panel).findByRole('button', { name: 'Expand by type' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Works for (3)' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Part of (1)' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Person (3)' })).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitem', { name: 'Part of (1)' }));
    await waitFor(() => expect(expandBodies.at(-1)).toMatchObject({ nodeIds: [ACME_ID], relationTypes: ['PART_OF'] }));
    expect(expandBodies.at(-1)?.types).toBeUndefined();
    // Only that relation's neighbour arrived: Atlas, not Dana (who WORKS_FOR Acme).
    expect(await within(canvas).findByRole('button', { name: 'Project Atlas' })).toBeInTheDocument();
    expect(within(canvas).queryByRole('button', { name: 'Dana Li' })).not.toBeInTheDocument();
  });

  it('Expand by entity type asks for that type only', async () => {
    serveCounts({ relationsByType: { WORKS_FOR: 3, PART_OF: 1 }, relationsByNeighborType: { Person: 3, Project: 1 } });
    const user = userEvent.setup();
    renderExplorer();
    const { canvas, panel } = await openNode(user, 'Acme Corp');
    await user.click(await within(panel).findByRole('button', { name: 'Expand by type' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Person (3)' }));
    await waitFor(() => expect(expandBodies.at(-1)).toMatchObject({ nodeIds: [ACME_ID], types: ['Person'] }));
    expect(expandBodies.at(-1)?.relationTypes).toBeUndefined();
    expect(await within(canvas).findByRole('button', { name: 'Dana Li' })).toBeInTheDocument();
    expect(within(canvas).queryByRole('button', { name: 'Project Atlas' })).not.toBeInTheDocument();
  });

  it('has no menu without per-type counts (an older API), and plain Expand still expands everything', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const { panel } = await openNode(user, 'Acme Corp');
    await within(panel).findByRole('button', { name: 'Expand' });
    expect(within(panel).queryByRole('button', { name: 'Expand by type' })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Expand' }));
    await waitFor(() => expect(expandBodies.at(-1)).toMatchObject({ nodeIds: [ACME_ID] }));
    expect(expandBodies.at(-1)?.types).toBeUndefined();
    expect(expandBodies.at(-1)?.relationTypes).toBeUndefined();
  });

  it('a "+N more" stub and the menu share one type-filtered expand', async () => {
    useExpand((body) => HttpResponse.json({ data: hubFixture(body)! }));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await screen.findByTestId('fake-canvas');
    await user.click(await within(canvas).findByRole('button', { name: /^\+\d+ more Person$/ }));
    await waitFor(() => expect(expandBodies.at(-1)).toMatchObject({ nodeIds: [JOE_ID], types: ['Person'] }));
    expect(expandBodies.at(-1)?.relationTypes).toBeUndefined();
  });
});

describe('the Connections and Timeline tabs', () => {
  it('groups the neighbours on the canvas by relation, and "Show on canvas" rings the group', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const { canvas, panel } = await openNode(user, 'Joe Rivera');
    await user.click(within(panel).getByRole('tab', { name: 'Connections' }));
    const attended = within(panel).getByRole('region', { name: 'Attended' });
    expect(within(attended).getByRole('button', { name: /^Q3 planning, Meeting, outgoing/ })).toBeInTheDocument();
    expect(within(attended).getByRole('button', { name: /^Weekly sync/ })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Show Attended on canvas' }));
    await waitFor(() => expect(within(canvas).getByRole('button', { name: 'Q3 planning' })).toHaveAttribute('data-marked', 'true'));
    expect(within(canvas).getByRole('button', { name: 'Weekly sync' })).toHaveAttribute('data-marked', 'true');
    expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toHaveAttribute('data-marked', 'false');

    // A neighbour is selectable from the list.
    await user.click(within(attended).getByRole('button', { name: /^Weekly sync/ }));
    expect(await screen.findByRole('group', { name: 'Weekly sync' })).toBeInTheDocument();
  });

  it('shows the entity timeline without asking for sensitive facts', async () => {
    const calls: string[] = [];
    server.use(
      http.get('*/api/graph/entities/:id/timeline', ({ request }) => {
        calls.push(new URL(request.url).search);
        return HttpResponse.json({
          data: {
            items: [
              {
                id: 'm1',
                eventKind: 'meeting',
                at: '2026-09-20T15:00:00.000Z',
                precision: 'day',
                meeting: { id: gid(70), label: 'Q3 planning', type: 'Meeting' },
                evidenceIds: [evId(1)],
                evidenceCount: 2,
              },
            ],
            nextCursor: null,
            asOf: '2026-09-26T00:00:00.000Z',
          },
        });
      }),
    );
    const user = userEvent.setup();
    renderExplorer();
    const { panel } = await openNode(user, 'Joe Rivera');
    await user.click(within(panel).getByRole('tab', { name: 'Timeline' }));
    expect(await within(panel).findByText('Meeting: Q3 planning')).toBeInTheDocument();
    expect(within(panel).getByText(/2 quotes/)).toBeInTheDocument();
    expect(calls.every((search) => !search.includes('includeSensitive'))).toBe(true);
  });
});

describe('the node header and the Overview tab', () => {
  it('shows aliases (three, then +N), first and last seen, and mentions', async () => {
    server.use(
      http.get('*/api/graph/entities/:id', ({ params }) =>
        HttpResponse.json({
          data: entityDetail(String(params.id), {
            aliases: ['One', 'Two', 'Three', 'Four', 'Five'].map((alias, i) => ({ id: gid(600 + i), alias, source: 'extraction' as const })),
          }),
        }),
      ),
    );
    const user = userEvent.setup();
    renderExplorer();
    const { panel } = await openNode(user, 'Joe Rivera');
    expect(await within(panel).findByText('Also known as One, Two, Three +2')).toBeInTheDocument();
    expect(within(panel).getByText(/First seen .* · Last seen .* · 14 mentions/)).toBeInTheDocument();
    expect(within(panel).getByText('Person')).toBeInTheDocument();
  });

  it('reads the brief without marking the entity viewed', async () => {
    const searches: string[] = [];
    server.use(
      http.get('*/api/graph/entities/:id/brief', ({ request }) => {
        searches.push(new URL(request.url).search);
        return HttpResponse.json({
          data: {
            entity: { id: JOE_ID, label: 'Joe Rivera', type: 'Person' },
            window: { since: null, sinceSource: 'default', asOf: '2026-09-26T00:00:00.000Z', lastViewedAt: null },
            digest: null,
            digestStale: false,
            digestPending: false,
            digestUnavailable: null,
            sections: {
              whatChanged: [],
              decisions: [],
              openCommitments: { theirs: [], yours: [] },
              risksClaims: [],
              peopleChanges: [],
            },
            related: [],
          },
        });
      }),
    );
    const user = userEvent.setup();
    renderExplorer();
    const { panel } = await openNode(user, 'Joe Rivera');
    expect(await within(panel).findByRole('heading', { name: 'Brief' })).toBeInTheDocument();
    expect(searches).toEqual(['?markViewed=false']);
  });
});

describe('the Ask tab', () => {
  const AskPanel = vi.fn(({ entityLabel, open }: { entityLabel: string; open: boolean }) =>
    open ? <div data-testid="ask-panel">Ask panel for {entityLabel}</div> : null,
  );

  it('exists only when the host passes the slot', async () => {
    const user = userEvent.setup();
    renderExplorer();
    const { panel } = await openNode(user, 'Joe Rivera');
    expect(within(panel).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Overview',
      'Evidence',
      'Connections',
      'Timeline',
    ]);
    expect(within(panel).queryByRole('button', { name: 'Ask' })).not.toBeInTheDocument();
  });

  it('renders the host panel through the slot, for an entity', async () => {
    const user = userEvent.setup();
    renderExplorer({ slots: { AskPanel } });
    const { panel } = await openNode(user, 'Joe Rivera');
    await user.click(within(panel).getByRole('tab', { name: 'Ask' }));
    expect(AskPanel).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: JOE_ID, entityLabel: 'Joe Rivera', entityType: 'Person', open: false }),
      undefined,
    );
    await user.click(within(panel).getByRole('button', { name: 'Ask about Joe Rivera' }));
    expect(await screen.findByTestId('ask-panel')).toHaveTextContent('Ask panel for Joe Rivera');
  });

  it('the Ask action opens the Ask tab', async () => {
    const user = userEvent.setup();
    renderExplorer({ slots: { AskPanel } });
    const { panel } = await openNode(user, 'Joe Rivera');
    await user.click(within(panel).getByRole('button', { name: 'Ask' }));
    expect(within(panel).getByRole('tab', { name: 'Ask', selected: true })).toBeInTheDocument();
  });

  it('is hidden while connected knowledge is off, whatever the slot', async () => {
    const user = userEvent.setup();
    renderExplorer({ slots: { AskPanel }, graphEnabled: false });
    const { panel } = await openNode(user, 'Joe Rivera');
    expect(within(panel).queryByRole('tab', { name: 'Ask' })).not.toBeInTheDocument();
  });

  it('is not offered for an item, which has no Ask or Timeline of its own', async () => {
    const user = userEvent.setup();
    renderExplorer({ slots: { AskPanel } });
    const { panel } = await openNode(user, 'Ship the Atlas beta');
    expect(within(panel).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'Evidence', 'Connections']);
  });
});

describe('the Selection view', () => {
  async function markTwo(user: ReturnType<typeof userEvent.setup>) {
    mockTouchInput();
    act(() => setViewportWidth(820));
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    await user.click(within(canvas).getByRole('button', { name: 'Ana Diaz' }));
    const group = await screen.findByRole('group', { name: 'Selection' });
    return { canvas, group };
  }

  it('counts the marked nodes by type', async () => {
    const user = userEvent.setup();
    const { group } = await markTwo(user);
    expect(within(group).getByRole('heading', { name: '2 nodes selected' })).toBeInTheDocument();
    const types = within(group).getByRole('list', { name: 'Selected by type' });
    expect(within(types).getByText('Organization 1')).toBeInTheDocument();
    expect(within(types).getByText('Person 1')).toBeInTheDocument();
    act(() => setViewportWidth(1024));
  });

  it('Expand all expands each marked node, one request after the other', async () => {
    const user = userEvent.setup();
    const { group } = await markTwo(user);
    await user.click(within(group).getByRole('button', { name: 'Expand all' }));
    await waitFor(() => expect(expandBodies.map((b) => b.nodeIds).slice(-2)).toEqual([[ACME_ID], [ANA_ID]]));
    act(() => setViewportWidth(1024));
  });

  it('Hide removes the marked nodes from the canvas and closes the view', async () => {
    const user = userEvent.setup();
    const { canvas, group } = await markTwo(user);
    await user.click(within(group).getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(within(canvas).queryByRole('button', { name: 'Acme Corp' })).not.toBeInTheDocument());
    expect(within(canvas).queryByRole('button', { name: 'Ana Diaz' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Selection' })).not.toBeInTheDocument());
    act(() => setViewportWidth(1024));
  });

  it('its close button unmarks everything', async () => {
    const user = userEvent.setup();
    const { canvas, group } = await markTwo(user);
    await user.click(within(group).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Selection' })).not.toBeInTheDocument());
    expect(within(canvas).getByRole('button', { name: 'Acme Corp' })).toHaveAttribute('data-marked', 'false');
    act(() => setViewportWidth(1024));
  });
});

describe('the inspector on a phone', () => {
  it('shows only the header, three actions and the evidence count at peek; the tab strip starts at half height', async () => {
    act(() => setViewportWidth(390));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    const sheet = await screen.findByRole('region', { name: 'Inspector' });
    expect(sheet).toHaveAttribute('data-snap', 'peek');

    const group = within(sheet).getByRole('group', { name: 'Acme Corp' });
    for (const name of ['Focus', 'Expand']) {
      expect(within(group).getByRole('button', { name })).toBeInTheDocument();
    }
    // The third action is "Path to…" (GIC-13); Open page moves behind the overflow menu.
    expect(within(group).getByRole('button', { name: 'Path to…' })).toBeInTheDocument();
    expect(within(group).queryByRole('link', { name: 'Open page' })).not.toBeInTheDocument();
    // Pin and Hide sit behind the overflow menu on a phone.
    expect(within(group).queryByRole('button', { name: 'Hide' })).not.toBeInTheDocument();
    expect(await within(group).findByText('18 evidence')).toBeInTheDocument();
    expect(within(group).queryByRole('tab')).not.toBeInTheDocument();

    await user.click(within(group).getByRole('button', { name: 'Node actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Pin' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Hide' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open page' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // Half height: the scrollable tab strip.
    await user.click(within(sheet).getByRole('button', { name: /^Resize Inspector/ }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Inspector' })).toHaveAttribute('data-snap', 'half'));
    expect(within(sheet).getAllByRole('tab').length).toBeGreaterThanOrEqual(4);
    act(() => setViewportWidth(1024));
  });

  it('uses 44px targets on a coarse pointer', async () => {
    mockTouchInput();
    act(() => setViewportWidth(820));
    const user = userEvent.setup();
    renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    await user.click(within(canvas).getByRole('button', { name: 'Acme Corp' }));
    const group = await screen.findByRole('group', { name: 'Acme Corp' });
    expect(within(group).getByRole('button', { name: 'Focus' })).toHaveStyle({ minHeight: '44px' });
    expect(within(group).getByRole('tab', { name: 'Overview' })).toHaveStyle({ minHeight: '48px' });
    act(() => setViewportWidth(1024));
  });

  it('has no axe violations with the Evidence tab open at half height', async () => {
    act(() => setViewportWidth(390));
    const user = userEvent.setup();
    const { container } = renderExplorer();
    const canvas = await canvasReady();
    await user.click(within(canvas).getByRole('button', { name: REPORTS_TO_EDGE }));
    const sheet = await screen.findByRole('region', { name: 'Inspector' });
    await user.click(within(sheet).getByRole('button', { name: /^Resize Inspector/ }));
    await within(sheet).findAllByRole('article');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    act(() => setViewportWidth(1024));
  });
});

describe('the inspector on a roomy window', () => {
  it('clamps long quotes to two lines with a Show more button', async () => {
    act(() => setViewportWidth(1440));
    const long = 'A very long quote about the rollout and what everyone thinks of it. '.repeat(4);
    server.use(
      http.get('*/api/graph/evidence/by-subject', () =>
        HttpResponse.json({ data: { items: [{ ...noteLink(EV_EDGE_NOTE, 1), quote: long }] } }),
      ),
    );
    const user = userEvent.setup();
    renderExplorer();
    const { panel } = await openEdge(user);
    const card = (await within(panel).findAllByRole('article'))[0]!;
    const button = within(card).getByRole('button', { name: 'Show more' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(within(card).getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    act(() => setViewportWidth(1024));
  });

  it('follows the ARIA tabs pattern and is axe clean on a node and on an edge', async () => {
    const user = userEvent.setup();
    const { container } = renderExplorer();
    const { canvas, panel } = await openNode(user, 'Joe Rivera');
    const list = within(panel).getByRole('tablist');
    const selected = within(list).getByRole('tab', { selected: true });
    const tabpanel = within(panel).getByRole('tabpanel');
    expect(selected.getAttribute('aria-controls')).toBe(tabpanel.id);
    expect(tabpanel.getAttribute('aria-labelledby')).toBe(selected.id);
    // Arrow keys move between tabs.
    selected.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(panel).getByRole('tab', { name: 'Evidence' })).toHaveFocus();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();

    await user.click(within(canvas).getByRole('button', { name: REPORTS_TO_EDGE }));
    const edgePanel = await screen.findByRole('group', { name: 'Reports to' });
    await within(edgePanel).findAllByRole('article');
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('lists the quotes of an edge when the API has none', async () => {
    server.use(http.get('*/api/graph/evidence/by-subject', () => HttpResponse.json({ data: { items: [] } })));
    const user = userEvent.setup();
    renderExplorer();
    const { panel } = await openEdge(user);
    expect(await within(panel).findByText('No quotes are recorded for this yet.')).toBeInTheDocument();
  });

  it('names an error and retries the request', async () => {
    let fail = true;
    server.use(
      http.get('*/api/graph/evidence/by-subject', () =>
        fail
          ? HttpResponse.json({ message: 'Boom', statusCode: 500 }, { status: 500 })
          : HttpResponse.json({ data: { items: [noteLink(EV_EDGE_GONE, 1)] } }),
      ),
    );
    const user = userEvent.setup();
    renderExplorer();
    const { panel } = await openEdge(user);
    await within(panel).findByRole('alert');
    fail = false;
    await user.click(within(panel).getByRole('button', { name: 'Retry' }));
    expect(await within(panel).findAllByRole('article')).toHaveLength(1);
  });
});
