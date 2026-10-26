import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';

import { http, HttpResponse, server } from './msw-compat.js';
import { render } from './helpers.js';
import type { MockUser } from './helpers.js';
import { graphReader, graphWriter } from './graphTestUsers.js';
import { ACME_ID, ANA_ID, BEN_ID, JOE_ID, entityDetail, gid, graphEntitySummaries } from './graphData.js';
import { GraphEntityPage } from '../../src/graph/ui/pages/GraphEntityPage.js';
import { defaultSurvivorId, mergeConfirmation } from '../../src/graph/ui/components/MergeEntityDialog.js';
import { clearEvidenceCache } from '../../src/graph/headless/hooks/useGraphEvidence.js';
import {
  MERGE_REVERT_CONFLICT_MESSAGE,
  MERGE_TYPE_MISMATCH_MESSAGE,
} from '../../src/graph/headless/hooks/useEntityMerges.js';
import type { EntityMergeRow } from '../../src/graph/headless/clients/graph.js';

/**
 * #765 — merging graph entities from the entity page: "Merge into…", the
 * dialog's search and preview, the survivor choice, the merge call, the
 * navigation and Undo, the tombstone redirect, "Merged from" and its Undo.
 */

const MERGE_ID = gid(990);

let requests: { method: string; url: URL }[];
let posts: { path: string; body: unknown }[];

beforeEach(() => {
  clearEvidenceCache();
  requests = [];
  posts = [];
  server.events.removeAllListeners();
  server.events.on('request:start', ({ request }) => {
    requests.push({ method: request.method, url: new URL(request.url) });
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function renderEntity(id = JOE_ID, user: MockUser = graphWriter) {
  return render(
    <>
      <Routes>
        <Route path="/graph/entities/:id" element={<GraphEntityPage />} />
      </Routes>
      <LocationProbe />
    </>,
    { wrapperOptions: { route: `/graph/entities/${id}`, user } },
  );
}

const location = () => screen.getByTestId('location').textContent;

/** Merging and reversing answer as the API would, and record what was sent. */
function useMergeApi() {
  server.use(
    http.post('*/api/graph/entities/:id/merge', async ({ request, params }) => {
      const body = (await request.json()) as { intoId: string };
      posts.push({ path: `/graph/entities/${params.id}/merge`, body });
      const survivor = entityDetail(body.intoId);
      return HttpResponse.json({
        data: {
          merge: { id: MERGE_ID, survivorId: body.intoId, mergedId: params.id, createdAt: '2026-10-26T10:00:00.000Z' },
          survivor: { id: survivor.id, type: survivor.type, label: survivor.label, aliasCount: 3 },
        },
      });
    }),
    http.post('*/api/graph/merges/:id/reverse', async ({ request, params }) => {
      posts.push({ path: `/graph/merges/${params.id}/reverse`, body: await request.json() });
      return HttpResponse.json({
        data: {
          merge: { id: params.id, survivorId: JOE_ID, mergedId: ANA_ID, reversedAt: '2026-10-26T10:05:00.000Z' },
          restored: { id: ANA_ID, type: 'Person', label: 'Ana Diaz' },
          skipped: [],
        },
      });
    }),
  );
}

async function openMergeDialog(user: ReturnType<typeof userEvent.setup>, label = 'Joe Rivera') {
  await screen.findByRole('heading', { level: 1, name: label });
  await user.click(screen.getByRole('button', { name: `More actions for ${label}` }));
  await user.click(await screen.findByRole('menuitem', { name: 'Merge into…' }));
  return screen.findByRole('dialog', { name: `Merge “${label}” into…` });
}

async function pick(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, query: string, option: string) {
  await user.type(within(dialog).getByRole('combobox', { name: /Search/ }), query);
  await user.click(await screen.findByRole('option', { name: new RegExp(option) }));
}

describe('EntityHeader — Merge into…', () => {
  it('is offered for every type to a writer', async () => {
    const user = userEvent.setup();
    renderEntity(ACME_ID);
    expect(await openMergeDialog(user, 'Acme Corp')).toBeInTheDocument();
  });

  it('is hidden from a read-only viewer, like Edit', async () => {
    renderEntity(JOE_ID, graphReader);
    await screen.findByRole('heading', { level: 1, name: 'Joe Rivera' });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /More actions for/ })).not.toBeInTheDocument();
  });
});

describe('MergeEntityDialog', () => {
  it('searches the same type only, and never offers the entity itself', async () => {
    // A server that ignores `type` — the dialog still filters.
    server.use(
      http.get('*/api/graph/entities', () =>
        HttpResponse.json({
          data: {
            items: graphEntitySummaries.filter((row) => [JOE_ID, ANA_ID, ACME_ID].includes(row.id)),
            nextCursor: null,
          },
        }),
      ),
    );
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    await user.type(within(dialog).getByRole('combobox', { name: 'Search Person' }), 'a');

    expect(await screen.findByRole('option', { name: /Ana Diaz/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Joe Rivera/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Acme Corp/ })).not.toBeInTheDocument();
    const search = requests.find((r) => r.url.pathname.endsWith('/graph/entities') && r.url.searchParams.get('q'));
    expect(search?.url.searchParams.get('type')).toBe('Person');
  });

  it('previews both side by side and keeps the one with more mentions by default', async () => {
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeDisabled();
    await pick(user, dialog, 'Ana', 'Ana Diaz');

    const joe = await within(dialog).findByTestId(`merge-preview-${JOE_ID}`);
    const ana = within(dialog).getByTestId(`merge-preview-${ANA_ID}`);
    expect(within(joe).getByText('Joseph Rivera')).toBeInTheDocument();
    expect(within(joe).getByText('14 mentions · 5 connections')).toBeInTheDocument();
    expect(within(ana).getByText('No other names')).toBeInTheDocument();
    expect(within(ana).getByText('9 mentions · 5 connections')).toBeInTheDocument();

    // Joe (14 mentions) beats Ana (9).
    expect(within(dialog).getByRole('radio', { name: 'Keep “Joe Rivera”' })).toBeChecked();
    expect(within(dialog).getByText('“Ana Diaz” will become an alias of “Joe Rivera”.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('radio', { name: 'Keep “Ana Diaz”' }));
    expect(within(dialog).getByText('“Joe Rivera” will become an alias of “Ana Diaz”.')).toBeInTheDocument();
  });

  it('defaultSurvivorId and mergeConfirmation', () => {
    const joe = entityDetail(JOE_ID);
    const ana = entityDetail(ANA_ID);
    expect(defaultSurvivorId(joe, ana)).toBe(JOE_ID);
    expect(defaultSurvivorId(ana, joe)).toBe(JOE_ID);
    // A tie keeps the entity picked in the search ("into").
    expect(defaultSurvivorId(joe, entityDetail(BEN_ID, { counts: joe.counts }))).toBe(BEN_ID);
    expect(mergeConfirmation('Oscar', 'Oscar Marin')).toBe('“Oscar” will become an alias of “Oscar Marin”.');
  });

  it('merges the other entity into the kept one and opens the survivor, replacing the tombstone', async () => {
    useMergeApi();
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    await pick(user, dialog, 'Ana', 'Ana Diaz');
    await user.click(await within(dialog).findByRole('radio', { name: 'Keep “Ana Diaz”' }));
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    await waitFor(() => expect(location()).toBe(`/graph/entities/${ANA_ID}`));
    expect(posts[0]).toEqual({ path: `/graph/entities/${JOE_ID}/merge`, body: { intoId: ANA_ID } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Ana Diaz' })).toBeInTheDocument();
    expect(await screen.findByText('Merged')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('stays on the page when the page’s own entity is kept', async () => {
    useMergeApi();
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    await pick(user, dialog, 'Ana', 'Ana Diaz');
    await within(dialog).findByTestId(`merge-preview-${ANA_ID}`);
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    expect(await screen.findByText('Merged')).toBeInTheDocument();
    expect(posts[0]).toEqual({ path: `/graph/entities/${ANA_ID}/merge`, body: { intoId: JOE_ID } });
    expect(location()).toBe(`/graph/entities/${JOE_ID}`);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Undo reverses the merge and opens the restored entity', async () => {
    useMergeApi();
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    await pick(user, dialog, 'Ana', 'Ana Diaz');
    await within(dialog).findByTestId(`merge-preview-${ANA_ID}`);
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(location()).toBe(`/graph/entities/${ANA_ID}`));
    expect(posts[1]).toEqual({ path: `/graph/merges/${MERGE_ID}/reverse`, body: {} });
    expect(await screen.findByRole('heading', { level: 1, name: 'Ana Diaz' })).toBeInTheDocument();
    expect(await screen.findByText('Merge undone. “Ana Diaz” is back.')).toBeInTheDocument();
  });

  it('explains a type mismatch', async () => {
    server.use(
      http.post('*/api/graph/entities/:id/merge', () =>
        HttpResponse.json(
          { statusCode: 400, message: 'Bad Request', details: { reason: 'type_mismatch' } },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    await pick(user, dialog, 'Ana', 'Ana Diaz');
    await within(dialog).findByTestId(`merge-preview-${ANA_ID}`);
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    expect(await within(dialog).findByText(MERGE_TYPE_MISMATCH_MESSAGE)).toBeInTheDocument();
    expect(location()).toBe(`/graph/entities/${JOE_ID}`);
  });
});

describe('GraphEntityPage — merged tombstone', () => {
  it('redirects (replacing) to the survivor', async () => {
    server.use(
      http.get('*/api/graph/entities/:id', ({ params }) =>
        HttpResponse.json({
          data:
            params.id === JOE_ID
              ? entityDetail(JOE_ID, { reviewStatus: 'merged', mergedIntoId: ANA_ID })
              : entityDetail(String(params.id), { mergedIntoId: null }),
        }),
      ),
    );
    renderEntity();
    expect(await screen.findByRole('heading', { level: 1, name: 'Ana Diaz' })).toBeInTheDocument();
    expect(location()).toBe(`/graph/entities/${ANA_ID}`);
    expect(screen.queryByRole('heading', { level: 1, name: 'Joe Rivera' })).not.toBeInTheDocument();
  });
});

describe('GraphEntityPage — Merged from', () => {
  const rows: EntityMergeRow[] = [
    {
      mergeId: MERGE_ID,
      mergedEntity: { id: ANA_ID, label: 'Ana Diaz', type: 'Person' },
      createdAt: '2026-10-20T10:00:00.000Z',
      reversedAt: null,
      reversible: true,
    },
    {
      mergeId: gid(991),
      mergedEntity: { id: BEN_ID, label: 'Ben Okafor', type: 'Person' },
      createdAt: '2026-10-01T10:00:00.000Z',
      reversedAt: '2026-10-02T10:00:00.000Z',
      reversible: false,
    },
  ];

  function useMerges(list: EntityMergeRow[]) {
    server.use(http.get('*/api/graph/entities/:id/merges', () => HttpResponse.json({ data: { merges: list } })));
  }

  it('is absent when nothing was merged in', async () => {
    renderEntity();
    await screen.findByRole('heading', { level: 1, name: 'Joe Rivera' });
    await waitFor(() => expect(requests.some((r) => r.url.pathname.endsWith('/merges'))).toBe(true));
    expect(screen.queryByRole('heading', { level: 2, name: 'Merged from' })).not.toBeInTheDocument();
  });

  it('lists the standing merges, with Undo for a reversible one', async () => {
    useMerges(rows);
    renderEntity();
    const list = await screen.findByRole('list', { name: 'Merged from' });
    expect(within(list).getByText('Ana Diaz')).toBeInTheDocument();
    // A merge already undone is not "merged from" any more.
    expect(within(list).queryByText('Ben Okafor')).not.toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Undo merge of Ana Diaz' })).toBeInTheDocument();
  });

  it('offers no Undo to a read-only viewer', async () => {
    useMerges(rows);
    renderEntity(JOE_ID, graphReader);
    const list = await screen.findByRole('list', { name: 'Merged from' });
    expect(within(list).queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument();
  });

  it('Undo reverses the merge and reads the page again', async () => {
    useMergeApi();
    useMerges(rows);
    const user = userEvent.setup();
    renderEntity();
    const list = await screen.findByRole('list', { name: 'Merged from' });
    const mergeReads = () => requests.filter((r) => r.url.pathname.endsWith('/merges')).length;
    const before = mergeReads();
    useMerges([]);
    await user.click(within(list).getByRole('button', { name: 'Undo merge of Ana Diaz' }));

    expect(await screen.findByText('Merge undone. “Ana Diaz” is back.')).toBeInTheDocument();
    expect(posts).toEqual([{ path: `/graph/merges/${MERGE_ID}/reverse`, body: {} }]);
    await waitFor(() => expect(mergeReads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Merged from' })).not.toBeInTheDocument());
    expect(location()).toBe(`/graph/entities/${JOE_ID}`);
  });

  it('explains a revert conflict', async () => {
    useMerges(rows);
    server.use(
      http.post('*/api/graph/merges/:id/reverse', () =>
        HttpResponse.json(
          { statusCode: 409, message: 'Conflict', details: { reason: 'revert_conflict' } },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderEntity();
    const list = await screen.findByRole('list', { name: 'Merged from' });
    await user.click(within(list).getByRole('button', { name: 'Undo merge of Ana Diaz' }));
    expect(await screen.findByText(MERGE_REVERT_CONFLICT_MESSAGE)).toBeInTheDocument();
  });
});

describe('EntityHeader — aliases', () => {
  it('shows every alias after "Also known as", and a name opens the edit dialog', async () => {
    const user = userEvent.setup();
    renderEntity();
    await screen.findByRole('heading', { level: 1, name: 'Joe Rivera' });
    const aliases = screen.getByRole('list', { name: 'Also known as' });
    expect(within(aliases).getAllByRole('listitem')).toHaveLength(2);
    await user.click(within(aliases).getByRole('button', { name: 'Joe R. (edit names)' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows the names, not as buttons, to a read-only viewer', async () => {
    renderEntity(JOE_ID, graphReader);
    await screen.findByRole('heading', { level: 1, name: 'Joe Rivera' });
    const aliases = screen.getByRole('list', { name: 'Also known as' });
    expect(within(aliases).getByText('Joseph Rivera')).toBeInTheDocument();
    expect(within(aliases).queryByRole('button')).not.toBeInTheDocument();
  });
});
