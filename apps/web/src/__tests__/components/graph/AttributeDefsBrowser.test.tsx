/**
 * `AttributeDefsBrowser` (issue #369, docs/specs/ontology.md §17.3).
 *
 * MSW-driven against #355's attribute-definition routes, so a deprecate is
 * asserted as the DELETE that left the page. The ontology fixture is computed
 * by the real shared package (`mocks/graphData.ts`), so the built-in
 * attributes listed here are the ones the API would send.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import { mockAttributeDef, mockGraphOntology } from '../../mocks/graphData';
import { AttributeDefsBrowser } from '../../../components/graph/settings/AttributeDefsBrowser';
import type { AttributeDef } from '../../../services/graph';

const API_BASE = '*/api';
const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const NICKNAME = mockAttributeDef();
const OLD_FIELD = mockAttributeDef({
  id: '66666666-6666-4666-8666-666666666666',
  key: 'u_oldfield01',
  label: 'Old field',
  extractable: false,
  extractionHint: null,
  deprecatedAt: '2026-09-02T00:00:00.000Z',
});
const INDUSTRY = mockAttributeDef({
  id: '77777777-7777-4777-8777-777777777777',
  entityType: 'Organization',
  key: 'u_industry01',
  label: 'Industry',
  kind: 'select',
  options: { choices: [{ value: 'saas', label: 'SaaS' }] },
  extractable: false,
  extractionHint: null,
  sensitivity: 'business',
});

let defs: AttributeDef[];
let deletes: string[];
let patches: Array<{ id: string; body: unknown }>;

beforeEach(() => {
  defs = [NICKNAME, OLD_FIELD, INDUSTRY];
  deletes = [];
  patches = [];
  server.use(
    http.get(`${API_BASE}/graph/attribute-defs`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('includeDeprecated')).toBe('true');
      return HttpResponse.json({ data: { items: defs } });
    }),
    http.delete(`${API_BASE}/graph/attribute-defs/:id`, ({ params }) => {
      deletes.push(params.id as string);
      const row = defs.find((d) => d.id === params.id)!;
      return HttpResponse.json({ data: { ...row, deprecatedAt: '2026-09-26T00:00:00.000Z' } });
    }),
    http.patch(`${API_BASE}/graph/attribute-defs/:id`, async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push({ id: params.id as string, body });
      const row = defs.find((d) => d.id === params.id)!;
      return HttpResponse.json({
        data: { ...row, ...(body.deprecated === false ? { deprecatedAt: null } : {}) },
      });
    }),
  );
});

function renderBrowser() {
  return render(<AttributeDefsBrowser ontology={mockGraphOntology()} />);
}

const section = (name: string) => screen.getByRole('region', { name });

describe('AttributeDefsBrowser', () => {
  it('lists built-in attributes read-only above the user\'s own, per type', async () => {
    renderBrowser();
    await screen.findByText('Nickname');

    const person = section('Person');
    const builtins = within(person).getByRole('list', { name: 'Built-in Person attributes' });
    expect(within(builtins).getByText('Job title')).toBeInTheDocument();
    // Read-only: no action on a built-in.
    expect(within(person).queryByRole('button', { name: /edit job title/i })).not.toBeInTheDocument();

    const own = within(person).getByRole('list', { name: 'Your Person attributes' });
    expect(within(own).getByText('Nickname')).toBeInTheDocument();
    expect(within(own).getByText('Extracted')).toBeInTheDocument();
    expect(within(own).getByRole('button', { name: 'Edit Nickname' })).toBeInTheDocument();
  });

  it('marks a deprecated definition and offers Restore instead of Deprecate', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await screen.findByText('Old field');

    const row = screen.getByText('Old field').closest('li')!;
    expect(within(row).getByText('Deprecated')).toBeInTheDocument();
    expect(row).toHaveStyle({ opacity: '0.6' });
    expect(within(row).queryByRole('button', { name: /deprecate/i })).not.toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Restore Old field' }));
    await waitFor(() =>
      expect(patches).toEqual([{ id: OLD_FIELD.id, body: { deprecated: false } }]),
    );
  });

  it('filters by entity type with a Select, not tabs', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await screen.findByText('Nickname');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Entity type' }));
    await user.click(screen.getByRole('option', { name: 'Organization' }));

    expect(screen.getByText('Industry')).toBeInTheDocument();
    expect(screen.queryByText('Nickname')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Person' })).not.toBeInTheDocument();
  });

  it('deprecating asks first, then sends DELETE and shows the row as deprecated', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await screen.findByText('Nickname');

    await user.click(screen.getByRole('button', { name: 'Deprecate Nickname' }));
    const dialog = await screen.findByRole('dialog', { name: /deprecate nickname/i });
    expect(
      within(dialog).getByText('Hidden from new proposals and forms. Existing values are kept.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Deprecate' }));

    await waitFor(() => expect(deletes).toEqual([NICKNAME.id]));
    const row = screen.getByText('Nickname').closest('li')!;
    await waitFor(() => expect(within(row).getByText('Deprecated')).toBeInTheDocument());
  });

  it('cancelling the deprecate confirmation sends nothing', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await screen.findByText('Nickname');

    await user.click(screen.getByRole('button', { name: 'Deprecate Nickname' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deletes).toEqual([]);
  });

  it('shows the empty state when the user has no attributes of their own', async () => {
    defs = [];
    renderBrowser();

    expect(await screen.findByText('No attributes of your own yet.')).toBeInTheDocument();
    // Built-ins still listed, so the user sees what exists before adding.
    expect(screen.getByText('Job title')).toBeInTheDocument();
  });

  it('shows an error with Retry, and retries', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/graph/attribute-defs`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ message: 'Database unavailable' }, { status: 500 })
          : HttpResponse.json({ data: { items: [NICKNAME] } });
      }),
    );
    renderBrowser();

    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Nickname')).toBeInTheDocument();
  });

  it('opens the add dialog preselected to the filtered type', async () => {
    const user = userEvent.setup();
    renderBrowser();
    await screen.findByText('Nickname');

    await user.click(screen.getByRole('combobox', { name: 'Entity type' }));
    await user.click(screen.getByRole('option', { name: 'Organization' }));
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));

    const dialog = await screen.findByRole('dialog', { name: 'Add attribute' });
    expect(within(dialog).getByRole('combobox', { name: 'Entity type' })).toHaveTextContent(
      'Organization',
    );
  });

  it('has no axe violations', async () => {
    const { container } = renderBrowser();
    await screen.findByText('Nickname');

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
