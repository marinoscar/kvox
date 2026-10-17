import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { http, HttpResponse } from './msw-compat.js';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { EntityConnectionsList } from '../../src/graph/ui/components/EntityConnectionsList.js';
import { server } from './msw-compat.js';
import { ACME_ID, DANA_ID, JOE_ID, gid, graphOntologyFixture } from './graphData.js';
import { render } from './helpers.js';
import { graphWriter } from './graphTestUsers.js';

/**
 * The manual relation edits on an entity page (#586): "Set manager", "Set
 * employer", "Add role" and Remove, by role and accessible name — the names a
 * host's end-to-end test drives.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
const NEW_EDGE = gid(498);

let posted: Array<{ path: string; body: unknown }>;
let deleted: string[];
let neighborhoodReads: number;

const setResponse = (type: string, toId: string) => ({
  data: {
    relation: {
      id: NEW_EDGE,
      type,
      fromId: JOE_ID,
      toId,
      props: {},
      valid: { from: '2026-10-17T00:00:00.000Z', to: null, precision: 'day' },
      reviewStatus: 'edited',
    },
    created: true,
    evidenceId: gid(799),
    closedRelationIds: [],
    flags: [],
  },
});

beforeEach(() => {
  posted = [];
  deleted = [];
  neighborhoodReads = 0;
  server.events.removeAllListeners();
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname.endsWith('/neighborhood')) neighborhoodReads += 1;
  });
  server.use(
    http.post('*/api/graph/entities/:id/relations', async ({ request, params }) => {
      const body = (await request.json()) as { type: string; toId: string };
      posted.push({ path: `/graph/entities/${params.id}/relations`, body });
      return HttpResponse.json(setResponse(body.type, body.toId));
    }),
    http.delete('*/api/graph/entities/:id/relations/:relationId', ({ params }) => {
      deleted.push(`/graph/entities/${params.id}/relations/${params.relationId}`);
      return HttpResponse.json({ data: { relationId: params.relationId, reviewStatus: 'rejected', reopenedRelationIds: [] } });
    }),
  );
});

function renderList(props: { canEdit?: boolean; entityType?: string } = {}) {
  return render(
    <EntityConnectionsList
      entityId={JOE_ID}
      entityLabel="Joe Rivera"
      ontology={graphOntologyFixture}
      entityType={props.entityType ?? 'Person'}
      canEdit={props.canEdit ?? true}
    />,
    { wrapperOptions: { user: graphWriter } },
  );
}

async function pick(user: ReturnType<typeof userEvent.setup>, field: string, query: string, option: RegExp) {
  const dialog = screen.getByRole('dialog');
  await user.type(within(dialog).getByRole('combobox', { name: field }), query);
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('EntityConnectionsList — manual relation edits (#586)', () => {
  it('offers Set manager, Set employer and Add role on a Person, with no a11y violations', async () => {
    const { container } = renderList();
    await screen.findByRole('heading', { level: 3, name: 'Works for' });
    for (const name of ['Set manager', 'Set employer', 'Add role']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('offers nothing without graph:write, or on an entity that is not a Person', async () => {
    const reader = renderList({ canEdit: false });
    await screen.findByRole('heading', { level: 3, name: 'Works for' });
    expect(screen.queryByRole('button', { name: 'Set manager' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    reader.unmount();

    renderList({ entityType: 'Organization' });
    await screen.findByRole('heading', { level: 3, name: 'Works for' });
    expect(screen.queryByRole('button', { name: 'Set manager' })).not.toBeInTheDocument();
  });

  it('sets a manager: pick a Person, Save, and the list reloads', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(await screen.findByRole('button', { name: 'Set manager' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set manager' });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    await pick(user, 'Manager', 'Dana', /Dana Li/);
    const before = neighborhoodReads;
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ path: `/graph/entities/${JOE_ID}/relations`, body: { type: 'REPORTS_TO', toId: DANA_ID } });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Set manager' })).not.toBeInTheDocument());
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    await waitFor(() => expect(neighborhoodReads).toBeGreaterThan(before));
  });

  it('offers only Organizations as an employer, and sends the optional start date', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(await screen.findByRole('button', { name: 'Set employer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set employer' });
    await user.type(within(dialog).getByRole('combobox', { name: 'Employer' }), 'a');
    const options = await screen.findAllByRole('option');
    expect(options.every((o) => /· Organization$/.test(o.textContent ?? ''))).toBe(true);
    await user.click(screen.getByRole('option', { name: /Acme Corp/ }));
    await user.type(within(dialog).getByLabelText('Since'), '2026-03-01');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].body).toEqual({ type: 'WORKS_FOR', toId: ACME_ID, validFrom: '2026-03-01' });
  });

  it('adds a role: the title is required, the business unit optional', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(await screen.findByRole('button', { name: 'Add role' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add role' });
    await pick(user, 'Organization', 'Acme', /Acme Corp/);
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: /^Title/ }), 'VP');
    await user.type(within(dialog).getByRole('textbox', { name: 'Business unit' }), 'Finance');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].body).toEqual({ type: 'HAS_ROLE', toId: ACME_ID, props: { title: 'VP', businessUnit: 'Finance' } });
  });

  it('shows the API error in the dialog and keeps it open', async () => {
    server.use(
      http.post('*/api/graph/entities/:id/relations', () =>
        HttpResponse.json({ code: 'BAD_REQUEST', message: "'REPORTS_TO' cannot point at a Organization." }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    renderList();
    await user.click(await screen.findByRole('button', { name: 'Set manager' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set manager' });
    await pick(user, 'Manager', 'Dana', /Dana Li/);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('cannot point at');
    expect(screen.getByRole('dialog', { name: 'Set manager' })).toBeInTheDocument();
  });

  it('removes a wrong manager after asking, and never offers Remove on other relations', async () => {
    const user = userEvent.setup();
    renderList();
    await screen.findByRole('heading', { level: 3, name: 'Reports to' });
    expect(screen.queryByRole('button', { name: /^Remove Attended/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove Reports to Ana Diaz' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove this connection?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deleted).toEqual([`/graph/entities/${JOE_ID}/relations/${gid(411)}`]));
    expect(await screen.findByText('Removed.')).toBeInTheDocument();
  });
});
