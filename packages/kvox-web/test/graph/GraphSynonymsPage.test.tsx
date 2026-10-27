import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import { http, HttpResponse, server } from './msw-compat.js';
import { render } from './helpers.js';
import type { MockUser } from './helpers.js';
import { graphReader, graphWriter } from './graphTestUsers.js';
import { gid } from './graphData.js';
import type { SynonymGroup } from '../../src/graph/headless/clients/graph.js';
import { SYNONYM_ERROR_COPY } from '../../src/graph/headless/hooks/useGraphSynonyms.js';
import {
  GraphSynonymsPage,
  SYNONYMS_SUBTITLE,
  synonymGroupText,
  synonymTypeLabel,
} from '../../src/graph/ui/pages/GraphSynonymsPage.js';
import { GraphDuplicatesPage } from '../../src/graph/ui/pages/GraphDuplicatesPage.js';
import { GraphIndexPage } from '../../src/graph/ui/pages/GraphIndexPage.js';

/**
 * #767 — the personal synonyms page: the list, add (names as chips, the
 * type, local validation and the API's reasons), edit, delete, the read-only
 * view, and the entry links from Possible duplicates and the Knowledge index.
 */

const EY_GROUP: SynonymGroup = {
  id: gid(701),
  terms: ['EY', 'Ernst & Young'],
  entityType: 'Organization',
  createdAt: '2026-10-26T10:00:00.000Z',
  updatedAt: '2026-10-26T10:00:00.000Z',
};
const BOB_GROUP: SynonymGroup = {
  id: gid(702),
  terms: ['Bob', 'Robert', 'Rob'],
  entityType: null,
  createdAt: '2026-10-26T10:00:00.000Z',
  updatedAt: '2026-10-26T10:00:00.000Z',
};

let groups: SynonymGroup[];
let writes: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  groups = [EY_GROUP, BOB_GROUP];
  writes = [];
  server.use(
    http.get('*/api/graph/synonyms', () => HttpResponse.json({ data: { groups } })),
    http.post('*/api/graph/synonyms', async ({ request }) => {
      const body = (await request.json()) as { terms: string[]; entityType?: string | null };
      writes.push({ method: 'POST', path: '/graph/synonyms', body });
      return HttpResponse.json(
        {
          data: {
            id: gid(799),
            terms: body.terms,
            entityType: body.entityType ?? null,
            createdAt: '2026-10-26T11:00:00.000Z',
            updatedAt: '2026-10-26T11:00:00.000Z',
          },
        },
        { status: 201 },
      );
    }),
    http.patch('*/api/graph/synonyms/:id', async ({ request, params }) => {
      const body = (await request.json()) as { terms: string[]; entityType?: string | null };
      writes.push({ method: 'PATCH', path: `/graph/synonyms/${params.id}`, body });
      return HttpResponse.json({
        data: {
          id: params.id,
          terms: body.terms,
          entityType: body.entityType ?? null,
          createdAt: '2026-10-26T10:00:00.000Z',
          updatedAt: '2026-10-26T11:00:00.000Z',
        },
      });
    }),
    http.delete('*/api/graph/synonyms/:id', ({ params }) => {
      writes.push({ method: 'DELETE', path: `/graph/synonyms/${params.id}`, body: null });
      return new HttpResponse(null, { status: 204 });
    }),
  );
});

function renderPage(user: MockUser = graphWriter) {
  return render(
    <Routes>
      <Route path="/graph/synonyms" element={<GraphSynonymsPage />} />
    </Routes>,
    { wrapperOptions: { route: '/graph/synonyms', user } },
  );
}

const row = (name: string) => screen.findByRole('listitem', { name });
const EY_ROW = 'EY = Ernst & Young';
const BOB_ROW = 'Bob = Robert = Rob';

async function openAdd(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add synonyms' }));
  return screen.findByRole('dialog', { name: 'Add synonyms' });
}

function refuse(status: number, reason: string) {
  server.use(
    http.post('*/api/graph/synonyms', () =>
      HttpResponse.json({ statusCode: status, message: 'Refused', details: { reason } }, { status }),
    ),
  );
}

describe('GraphSynonymsPage — list', () => {
  it('renders the title, subtitle and each group as names joined by "=", with its type', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Synonyms' })).toBeInTheDocument();
    expect(screen.getByText(SYNONYMS_SUBTITLE)).toBeInTheDocument();

    const ey = await row(EY_ROW);
    const names = within(ey).getByRole('list', { name: 'Names' });
    expect(within(names).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['EY', '=Ernst & Young']);
    expect(within(ey).getByText('Organizations')).toBeInTheDocument();
    expect(within(ey).getByRole('button', { name: `Edit ${EY_ROW}` })).toBeInTheDocument();
    expect(within(ey).getByRole('button', { name: `Delete ${EY_ROW}` })).toBeInTheDocument();

    const bob = await row(BOB_ROW);
    expect(within(bob).getByText('Any type')).toBeInTheDocument();
  });

  it('shows an empty state with an example', async () => {
    groups = [];
    renderPage();
    expect(await screen.findByText('No synonyms yet')).toBeInTheDocument();
    expect(within(screen.getByTestId('synonyms-example')).getByText('Ernst & Young')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add synonyms' })).toBeInTheDocument();
  });

  it('shows a load failure with Retry', async () => {
    server.use(
      http.get('*/api/graph/synonyms', () =>
        HttpResponse.json({ statusCode: 500, message: 'Boom' }, { status: 500 }),
      ),
    );
    renderPage();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a read-only viewer sees the list without add, edit or delete', async () => {
    renderPage(graphReader);
    const ey = await row(EY_ROW);
    expect(within(ey).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add synonyms' })).not.toBeInTheDocument();
  });

  it('a read-only viewer sees the empty state without the add button', async () => {
    groups = [];
    renderPage(graphReader);
    expect(await screen.findByText('No synonyms yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add synonyms' })).not.toBeInTheDocument();
  });

  it('synonymGroupText and synonymTypeLabel', () => {
    expect(synonymGroupText(['EY', 'Ernst & Young'])).toBe('EY = Ernst & Young');
    expect(synonymTypeLabel(null, null)).toBe('Any type');
    expect(synonymTypeLabel('Organization', null)).toBe('Organization');
  });
});

describe('GraphSynonymsPage — add', () => {
  it('collects names as chips on Enter and comma, with an optional type, and adds the group', async () => {
    const user = userEvent.setup();
    renderPage();
    await row(EY_ROW);
    const dialog = await openAdd(user);
    const input = within(dialog).getByRole('textbox', { name: 'Add a name' });
    await user.type(input, 'KPMG{Enter}Klynveld Peat,');
    await user.type(input, 'kpmg,');
    const chips = within(dialog).getByRole('list', { name: 'Names to save' });
    // A repeat (case ignored) is not added twice.
    expect(within(chips).getAllByRole('listitem').map((chip) => chip.textContent)).toEqual(['KPMG', 'Klynveld Peat']);

    await user.click(within(dialog).getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: 'Organizations' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes).toEqual([
      { method: 'POST', path: '/graph/synonyms', body: { terms: ['KPMG', 'Klynveld Peat'], entityType: 'Organization' } },
    ]);
    expect(await row('KPMG = Klynveld Peat')).toBeInTheDocument();
    expect(await screen.findByText('Synonyms added')).toBeInTheDocument();
  });

  it('counts the name still being typed and sends Any type as null', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openAdd(user);
    const input = within(dialog).getByRole('textbox', { name: 'Add a name' });
    await user.type(input, 'Bill{Enter}William');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toEqual({ terms: ['Bill', 'William'], entityType: null });
  });

  it('removes a chip', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Add a name' }), 'A,B,C,');
    await user.click(within(dialog).getByLabelText('Remove B'));
    const chips = within(dialog).getByRole('list', { name: 'Names to save' });
    expect(within(chips).getAllByRole('listitem').map((chip) => chip.textContent)).toEqual(['A', 'C']);
  });

  it('asks for at least two names before sending', async () => {
    const user = userEvent.setup();
    renderPage();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Add a name' }), 'Solo{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(SYNONYM_ERROR_COPY.synonyms_too_few!)).toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it.each([
    [400, 'synonyms_too_few'],
    [400, 'synonyms_invalid_term'],
    [400, 'unknown_entity_type'],
    [409, 'synonyms_limit'],
  ])('explains a %i %s refusal and keeps the dialog open', async (status, reason) => {
    refuse(status, reason);
    const user = userEvent.setup();
    renderPage();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByRole('textbox', { name: 'Add a name' }), 'EY,Ernst & Young,');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText(SYNONYM_ERROR_COPY[reason]!)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add synonyms' })).toBeInTheDocument();
  });
});

describe('GraphSynonymsPage — edit and delete', () => {
  it('edits a group: names and type prefilled, the change saved in place', async () => {
    const user = userEvent.setup();
    renderPage();
    const ey = await row(EY_ROW);
    await user.click(within(ey).getByRole('button', { name: `Edit ${EY_ROW}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit synonyms' });
    const chips = within(dialog).getByRole('list', { name: 'Names to save' });
    expect(within(chips).getAllByRole('listitem').map((chip) => chip.textContent)).toEqual(['EY', 'Ernst & Young']);
    expect(within(dialog).getByRole('combobox', { name: 'Type' })).toHaveTextContent('Organizations');

    await user.type(within(dialog).getByRole('textbox', { name: 'Add a name' }), 'E&Y{Enter}');
    await user.click(within(dialog).getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: 'Any type' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes).toEqual([
      {
        method: 'PATCH',
        path: `/graph/synonyms/${EY_GROUP.id}`,
        body: { terms: ['EY', 'Ernst & Young', 'E&Y'], entityType: null },
      },
    ]);
    const edited = await row('EY = Ernst & Young = E&Y');
    expect(within(edited).getByText('Any type')).toBeInTheDocument();
    expect(await screen.findByText('Synonyms saved')).toBeInTheDocument();
  });

  it('deletes a group after confirming', async () => {
    const user = userEvent.setup();
    renderPage();
    const bob = await row(BOB_ROW);
    await user.click(within(bob).getByRole('button', { name: `Delete ${BOB_ROW}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete these synonyms?' });
    expect(within(dialog).getByText(/stop treating Bob = Robert = Rob as the same name/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('listitem', { name: BOB_ROW })).not.toBeInTheDocument();
    expect(writes).toEqual([{ method: 'DELETE', path: `/graph/synonyms/${BOB_GROUP.id}`, body: null }]);
    expect(screen.getByRole('listitem', { name: EY_ROW })).toBeInTheDocument();
    expect(await screen.findByText('Synonyms deleted')).toBeInTheDocument();
  });

  it('Cancel on the delete confirmation sends nothing', async () => {
    const user = userEvent.setup();
    renderPage();
    const bob = await row(BOB_ROW);
    await user.click(within(bob).getByRole('button', { name: `Delete ${BOB_ROW}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete these synonyms?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes).toEqual([]);
    expect(screen.getByRole('listitem', { name: BOB_ROW })).toBeInTheDocument();
  });
});

describe('Synonyms entry points', () => {
  it('Possible duplicates links to Synonyms, for a read-only viewer too', async () => {
    render(
      <Routes>
        <Route path="/graph/duplicates" element={<GraphDuplicatesPage />} />
      </Routes>,
      { wrapperOptions: { route: '/graph/duplicates', user: graphReader } },
    );
    await screen.findByRole('heading', { level: 1, name: 'Possible duplicates' });
    expect(screen.getByRole('link', { name: 'Synonyms' })).toHaveAttribute('href', '/graph/synonyms');
  });

  it('the Knowledge index menu links to Synonyms', async () => {
    const user = userEvent.setup();
    render(
      <Routes>
        <Route path="/graph/entities" element={<GraphIndexPage />} />
      </Routes>,
      { wrapperOptions: { route: '/graph/entities', user: graphWriter } },
    );
    await user.click(await screen.findByRole('button', { name: /More knowledge actions|Knowledge actions/ }));
    expect(await screen.findByRole('menuitem', { name: 'Synonyms' })).toHaveAttribute('href', '/graph/synonyms');
  });
});
