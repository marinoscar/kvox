import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';

import { http, HttpResponse, server } from './msw-compat.js';
import { render } from './helpers.js';
import type { MockUser } from './helpers.js';
import { graphReader, graphWriter } from './graphTestUsers.js';
import { KAPPA_ID, ANDERS_ID, BRAM_ID, JONTY_ID, entityDetail, gid, graphEntitySummaries } from './graphData.js';
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

function renderEntity(id = JONTY_ID, user: MockUser = graphWriter) {
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
          merge: { id: params.id, survivorId: JONTY_ID, mergedId: ANDERS_ID, reversedAt: '2026-10-26T10:05:00.000Z' },
          restored: { id: ANDERS_ID, type: 'Person', label: 'Anders Placeholder' },
          skipped: [],
        },
      });
    }),
  );
}

async function openMergeDialog(user: ReturnType<typeof userEvent.setup>, label = 'Jonty Placeholder') {
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
    renderEntity(KAPPA_ID);
    expect(await openMergeDialog(user, 'Org Kappa')).toBeInTheDocument();
  });

  it('is hidden from a read-only viewer, like Edit', async () => {
    renderEntity(JONTY_ID, graphReader);
    await screen.findByRole('heading', { level: 1, name: 'Jonty Placeholder' });
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
            items: graphEntitySummaries.filter((row) => [JONTY_ID, ANDERS_ID, KAPPA_ID].includes(row.id)),
            nextCursor: null,
          },
        }),
      ),
    );
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    await user.type(within(dialog).getByRole('combobox', { name: 'Search Person' }), 'a');

    expect(await screen.findByRole('option', { name: /Anders Placeholder/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Jonty Placeholder/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Org Kappa/ })).not.toBeInTheDocument();
    const search = requests.find((r) => r.url.pathname.endsWith('/graph/entities') && r.url.searchParams.get('q'));
    expect(search?.url.searchParams.get('type')).toBe('Person');
  });

  it('previews both side by side and keeps the one with more mentions by default', async () => {
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeDisabled();
    await pick(user, dialog, 'Anders', 'Anders Placeholder');

    const jonty = await within(dialog).findByTestId(`merge-preview-${JONTY_ID}`);
    const anders = within(dialog).getByTestId(`merge-preview-${ANDERS_ID}`);
    expect(within(jonty).getByText('Juno Placeholder')).toBeInTheDocument();
    expect(within(jonty).getByText('14 mentions · 5 connections')).toBeInTheDocument();
    expect(within(anders).getByText('No other names')).toBeInTheDocument();
    expect(within(anders).getByText('9 mentions · 5 connections')).toBeInTheDocument();

    // Jonty (14 mentions) beats Anders (9).
    expect(within(dialog).getByRole('radio', { name: 'Keep “Jonty Placeholder”' })).toBeChecked();
    expect(within(dialog).getByText('“Anders Placeholder” will become an alias of “Jonty Placeholder”.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('radio', { name: 'Keep “Anders Placeholder”' }));
    expect(within(dialog).getByText('“Jonty Placeholder” will become an alias of “Anders Placeholder”.')).toBeInTheDocument();
  });

  it('defaultSurvivorId and mergeConfirmation', () => {
    const jonty = entityDetail(JONTY_ID);
    const anders = entityDetail(ANDERS_ID);
    expect(defaultSurvivorId(jonty, anders)).toBe(JONTY_ID);
    expect(defaultSurvivorId(anders, jonty)).toBe(JONTY_ID);
    // A tie keeps the entity picked in the search ("into").
    expect(defaultSurvivorId(jonty, entityDetail(BRAM_ID, { counts: jonty.counts }))).toBe(BRAM_ID);
    expect(mergeConfirmation('Avery', 'Avery Example')).toBe('“Avery” will become an alias of “Avery Example”.');
  });

  it('merges the other entity into the kept one and opens the survivor, replacing the tombstone', async () => {
    useMergeApi();
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    await pick(user, dialog, 'Anders', 'Anders Placeholder');
    await user.click(await within(dialog).findByRole('radio', { name: 'Keep “Anders Placeholder”' }));
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    await waitFor(() => expect(location()).toBe(`/graph/entities/${ANDERS_ID}`));
    expect(posts[0]).toEqual({ path: `/graph/entities/${JONTY_ID}/merge`, body: { intoId: ANDERS_ID } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Anders Placeholder' })).toBeInTheDocument();
    expect(await screen.findByText('Merged')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('stays on the page when the page’s own entity is kept', async () => {
    useMergeApi();
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    await pick(user, dialog, 'Anders', 'Anders Placeholder');
    await within(dialog).findByTestId(`merge-preview-${ANDERS_ID}`);
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    expect(await screen.findByText('Merged')).toBeInTheDocument();
    expect(posts[0]).toEqual({ path: `/graph/entities/${ANDERS_ID}/merge`, body: { intoId: JONTY_ID } });
    expect(location()).toBe(`/graph/entities/${JONTY_ID}`);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Undo reverses the merge and opens the restored entity', async () => {
    useMergeApi();
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    await pick(user, dialog, 'Anders', 'Anders Placeholder');
    await within(dialog).findByTestId(`merge-preview-${ANDERS_ID}`);
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(location()).toBe(`/graph/entities/${ANDERS_ID}`));
    expect(posts[1]).toEqual({ path: `/graph/merges/${MERGE_ID}/reverse`, body: {} });
    expect(await screen.findByRole('heading', { level: 1, name: 'Anders Placeholder' })).toBeInTheDocument();
    expect(await screen.findByText('Merge undone. “Anders Placeholder” is back.')).toBeInTheDocument();
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
    await pick(user, dialog, 'Anders', 'Anders Placeholder');
    await within(dialog).findByTestId(`merge-preview-${ANDERS_ID}`);
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    expect(await within(dialog).findByText(MERGE_TYPE_MISMATCH_MESSAGE)).toBeInTheDocument();
    expect(location()).toBe(`/graph/entities/${JONTY_ID}`);
  });
});

describe('MergeEntityDialog — also add to synonyms (#767)', () => {
  function useSynonymsApi(fail = false) {
    const created: unknown[] = [];
    server.use(
      http.post('*/api/graph/synonyms', async ({ request }) => {
        const body = await request.json();
        created.push(body);
        if (fail) {
          return HttpResponse.json(
            { statusCode: 409, message: 'Conflict', details: { reason: 'synonyms_limit' } },
            { status: 409 },
          );
        }
        return HttpResponse.json(
          {
            data: {
              id: gid(995),
              terms: (body as { terms: string[] }).terms,
              entityType: 'Person',
              createdAt: '2026-10-26T10:00:00.000Z',
              updatedAt: '2026-10-26T10:00:00.000Z',
            },
          },
          { status: 201 },
        );
      }),
    );
    return created;
  }

  it('is unchecked by default, so a merge alone adds no synonyms', async () => {
    useMergeApi();
    const created = useSynonymsApi();
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    await pick(user, dialog, 'Anders', 'Anders Placeholder');
    const box = await within(dialog).findByRole('checkbox', { name: 'Also add these names to my synonyms' });
    expect(box).not.toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(await screen.findByText('Merged')).toBeInTheDocument();
    expect(created).toEqual([]);
  });

  it('when checked, creates a synonym group of the merged and kept names for the type', async () => {
    useMergeApi();
    const created = useSynonymsApi();
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    await pick(user, dialog, 'Anders', 'Anders Placeholder');
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Also add these names to my synonyms' }));
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    expect(await screen.findByText('Merged')).toBeInTheDocument();
    expect(posts[0]).toEqual({ path: `/graph/entities/${ANDERS_ID}/merge`, body: { intoId: JONTY_ID } });
    expect(created).toEqual([{ terms: ['Anders Placeholder', 'Jonty Placeholder'], entityType: 'Person' }]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a refused synonym keeps the merge and shows a non-blocking notice', async () => {
    useMergeApi();
    const created = useSynonymsApi(true);
    const user = userEvent.setup();
    renderEntity();
    const dialog = await openMergeDialog(user);
    await pick(user, dialog, 'Anders', 'Anders Placeholder');
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Also add these names to my synonyms' }));
    await user.click(within(dialog).getByRole('button', { name: 'Merge' }));

    expect(await screen.findByText('Merged')).toBeInTheDocument();
    expect(created).toHaveLength(1);
    expect(
      await screen.findByText(/Merged, but the names were not added to your synonyms\. You can keep up to 500 synonym groups/),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('GraphEntityPage — merged tombstone', () => {
  it('redirects (replacing) to the survivor', async () => {
    server.use(
      http.get('*/api/graph/entities/:id', ({ params }) =>
        HttpResponse.json({
          data:
            params.id === JONTY_ID
              ? entityDetail(JONTY_ID, { reviewStatus: 'merged', mergedIntoId: ANDERS_ID })
              : entityDetail(String(params.id), { mergedIntoId: null }),
        }),
      ),
    );
    renderEntity();
    expect(await screen.findByRole('heading', { level: 1, name: 'Anders Placeholder' })).toBeInTheDocument();
    expect(location()).toBe(`/graph/entities/${ANDERS_ID}`);
    expect(screen.queryByRole('heading', { level: 1, name: 'Jonty Placeholder' })).not.toBeInTheDocument();
  });
});

describe('GraphEntityPage — Merged from', () => {
  const rows: EntityMergeRow[] = [
    {
      mergeId: MERGE_ID,
      mergedEntity: { id: ANDERS_ID, label: 'Anders Placeholder', type: 'Person' },
      createdAt: '2026-10-20T10:00:00.000Z',
      reversedAt: null,
      reversible: true,
    },
    {
      mergeId: gid(991),
      mergedEntity: { id: BRAM_ID, label: 'Bram Example', type: 'Person' },
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
    await screen.findByRole('heading', { level: 1, name: 'Jonty Placeholder' });
    await waitFor(() => expect(requests.some((r) => r.url.pathname.endsWith('/merges'))).toBe(true));
    expect(screen.queryByRole('heading', { level: 2, name: 'Merged from' })).not.toBeInTheDocument();
  });

  it('lists the standing merges, with Undo for a reversible one', async () => {
    useMerges(rows);
    renderEntity();
    const list = await screen.findByRole('list', { name: 'Merged from' });
    expect(within(list).getByText('Anders Placeholder')).toBeInTheDocument();
    // A merge already undone is not "merged from" any more.
    expect(within(list).queryByText('Bram Example')).not.toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Undo merge of Anders Placeholder' })).toBeInTheDocument();
  });

  it('offers no Undo to a read-only viewer', async () => {
    useMerges(rows);
    renderEntity(JONTY_ID, graphReader);
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
    await user.click(within(list).getByRole('button', { name: 'Undo merge of Anders Placeholder' }));

    expect(await screen.findByText('Merge undone. “Anders Placeholder” is back.')).toBeInTheDocument();
    expect(posts).toEqual([{ path: `/graph/merges/${MERGE_ID}/reverse`, body: {} }]);
    await waitFor(() => expect(mergeReads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Merged from' })).not.toBeInTheDocument());
    expect(location()).toBe(`/graph/entities/${JONTY_ID}`);
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
    await user.click(within(list).getByRole('button', { name: 'Undo merge of Anders Placeholder' }));
    expect(await screen.findByText(MERGE_REVERT_CONFLICT_MESSAGE)).toBeInTheDocument();
  });
});

describe('EntityHeader — aliases', () => {
  it('shows every alias after "Also known as", and a name opens the edit dialog', async () => {
    const user = userEvent.setup();
    renderEntity();
    await screen.findByRole('heading', { level: 1, name: 'Jonty Placeholder' });
    const aliases = screen.getByRole('list', { name: 'Also known as' });
    expect(within(aliases).getAllByRole('listitem')).toHaveLength(2);
    await user.click(within(aliases).getByRole('button', { name: 'Jonty R. (edit names)' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows the names, not as buttons, to a read-only viewer', async () => {
    renderEntity(JONTY_ID, graphReader);
    await screen.findByRole('heading', { level: 1, name: 'Jonty Placeholder' });
    const aliases = screen.getByRole('list', { name: 'Also known as' });
    expect(within(aliases).getByText('Juno Placeholder')).toBeInTheDocument();
    expect(within(aliases).queryByRole('button')).not.toBeInTheDocument();
  });
});
