import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { EntityConnectionsList, groupConnections } from '../../../components/graph/EntityConnectionsList';
import type { GraphSlice } from '../../../services/graph';
import { server } from '../../mocks/server';
import { ACME_ID, JOE_ID, graphOntologyFixture, neighborhoodFixture } from '../../mocks/graphData';
import { render } from '../../utils/test-utils';

/** #442: an edge's own props (HAS_ROLE's role and business unit) on its connection row. */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function withRole(props: Record<string, unknown>): GraphSlice {
  const base = neighborhoodFixture();
  return {
    ...base,
    edges: [
      ...base.edges,
      {
        id: '00000000-0000-4000-8000-000000000499',
        type: 'HAS_ROLE',
        source: JOE_ID,
        target: ACME_ID,
        valid: null,
        confidence: 0.9,
        virtual: false,
        props,
      },
    ],
  };
}

function useSlice(slice: GraphSlice) {
  server.use(http.get('*/api/graph/entities/:id/neighborhood', () => HttpResponse.json({ data: slice })));
}

function renderList() {
  return render(<EntityConnectionsList entityId={JOE_ID} entityLabel="Joe Rivera" ontology={graphOntologyFixture} />);
}

async function roleGroup() {
  const heading = await screen.findByRole('heading', { level: 3, name: 'Has role' });
  return heading.parentElement as HTMLElement;
}

describe('EntityConnectionsList — relation props', () => {
  it('shows role · business unit after the entity, with labelled text for assistive tech', async () => {
    useSlice(withRole({ title: 'Managing Director', businessUnit: 'Consulting' }));
    const { container } = renderList();
    const group = await roleGroup();
    const row = within(group).getByRole('listitem');

    expect(within(row).getByRole('link', { name: 'Acme Corp' })).toBeInTheDocument();
    expect(row).toHaveTextContent('Acme Corp — Managing Director · Consulting');
    expect(within(row).getByText(', Role: Managing Director, Business unit: Consulting')).toBeInTheDocument();
    expect(within(row).getByTestId('connection-props')).toHaveAttribute(
      'title',
      'Role: Managing Director, Business unit: Consulting',
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('shows nothing extra for an edge with {} props', async () => {
    useSlice(withRole({}));
    renderList();
    const row = within(await roleGroup()).getByRole('listitem');
    expect(row).toHaveTextContent(/^Acme Corp$/);
    expect(within(row).queryByTestId('connection-props')).not.toBeInTheDocument();
  });

  it('shows nothing extra for an older response with no props field', async () => {
    useSlice(neighborhoodFixture());
    renderList();
    const heading = await screen.findByRole('heading', { level: 3, name: 'Works for' });
    const row = within(heading.parentElement as HTMLElement).getByRole('listitem');
    expect(row).toHaveTextContent(/^Acme Corp$/);
  });

  it('keeps two roles at one organization as two rows', () => {
    const slice = withRole({ title: 'Managing Director' });
    slice.edges.push({ ...slice.edges.at(-1)!, id: 'second-role', props: { title: 'Board member' } });
    const group = groupConnections(slice, JOE_ID, 'Joe Rivera', graphOntologyFixture).find((g) => g.title === 'Has role')!;
    expect(group.entries.map((entry) => entry.props.map((p) => p.value).join(' · '))).toEqual([
      'Managing Director',
      'Board member',
    ]);
  });
});
