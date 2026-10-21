import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { GraphLegend, useLegendTypeFilter } from '../../src/graph/ui/components/explorer/GraphLegend.js';
import {
  createExplorerState,
  legendModel,
  mergeSlice,
  type ExplorerState,
} from '../../src/graph/ui/components/explorer/explorerModel.js';
import { nodeTypeOptions, relationTypeOptions } from '../../src/graph/headless/utils/explorerFilters.js';
import { JOE_ID, expandFixture, graphOntologyFixture } from './graphData.js';
import { render } from './helpers.js';

/**
 * `GraphLegend` (#667): a list of toggle buttons with `aria-pressed`, counts
 * announced, a relation section, the stance key — and the `types` URL parameter
 * round-trip through `useLegendTypeFilter`.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const NODE_TYPES = nodeTypeOptions(graphOntologyFixture);
const RELATION_TYPES = relationTypeOptions(graphOntologyFixture);
const ALL_KEYS = NODE_TYPES.map((t) => t.key);

function loaded(hidden: string[] = []): ExplorerState {
  const state = createExplorerState();
  const slice = expandFixture({ nodeIds: [JOE_ID], cap: 300 })!;
  state.seedIds = [JOE_ID];
  mergeSlice(state, slice);
  state.hiddenTypes = new Set(hidden);
  return state;
}

function modelFor(state: ExplorerState, mode: 'light' | 'dark' = 'light') {
  return legendModel(state, NODE_TYPES, RELATION_TYPES, mode);
}

describe('GraphLegend', () => {
  it('lists each type on the canvas as a toggle button with aria-pressed, named by its label', () => {
    const state = loaded();
    render(<GraphLegend model={modelFor(state)} onToggleType={() => {}} />);

    const types = screen.getByRole('list', { name: 'Types' });
    const people = within(types).getByRole('button', { name: 'People' });
    expect(people).toHaveAttribute('aria-pressed', 'true');
    for (const button of within(types).getAllByRole('button')) {
      expect(button).toHaveAttribute('aria-pressed');
    }
    // A type that is not on the canvas and not hidden has no row.
    expect(within(types).queryByRole('button', { name: 'Interests' })).not.toBeInTheDocument();
  });

  it('announces the count as the button description, and "hidden" for a hidden type', () => {
    const state = loaded(['Meeting']);
    render(<GraphLegend model={modelFor(state)} onToggleType={() => {}} />);

    const people = screen.getByRole('button', { name: 'People' });
    const peopleCount = modelFor(state).types.find((t) => t.key === 'Person')!.count;
    expect(people).toHaveAccessibleDescription(`${peopleCount} on the canvas`);

    const meetings = screen.getByRole('button', { name: 'Meetings' });
    expect(meetings).toHaveAttribute('aria-pressed', 'false');
    expect(meetings).toHaveAccessibleDescription('hidden');
  });

  it('reports a click with the type key', async () => {
    const user = userEvent.setup();
    const onToggleType = vi.fn();
    render(<GraphLegend model={modelFor(loaded())} onToggleType={onToggleType} />);

    await user.click(screen.getByRole('button', { name: 'Organizations' }));
    expect(onToggleType).toHaveBeenCalledWith('Organization');
  });

  it('a toggle is reachable and operable from the keyboard', async () => {
    const user = userEvent.setup();
    const onToggleType = vi.fn();
    render(<GraphLegend model={modelFor(loaded())} onToggleType={onToggleType} />);

    await user.tab();
    expect(screen.getAllByRole('button')[0]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onToggleType).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(onToggleType).toHaveBeenCalledTimes(2);
  });

  it('shows the relation section as toggles when a handler is given, and as plain rows without one', async () => {
    const user = userEvent.setup();
    const onToggleRelation = vi.fn();
    const state = loaded();
    const { rerender } = render(
      <GraphLegend model={modelFor(state)} onToggleType={() => {}} onToggleRelation={onToggleRelation} />,
    );
    const relations = screen.getByRole('list', { name: 'Relations' });
    await user.click(within(relations).getByRole('button', { name: 'Works for' }));
    expect(onToggleRelation).toHaveBeenCalledWith('WORKS_FOR');

    rerender(<GraphLegend model={modelFor(state)} onToggleType={() => {}} />);
    expect(within(screen.getByRole('list', { name: 'Relations' })).queryAllByRole('button')).toHaveLength(0);
  });

  it('shows the stance key only when a stance is on the canvas', () => {
    const state = loaded();
    const { rerender } = render(<GraphLegend model={modelFor(state)} onToggleType={() => {}} />);
    expect(screen.queryByRole('list', { name: 'Stance' })).not.toBeInTheDocument();

    state.graph.setEdgeAttribute(state.graph.edges()[0], 'stance', 'champion');
    rerender(<GraphLegend model={modelFor(state)} onToggleType={() => {}} />);
    const stance = screen.getByRole('list', { name: 'Stance' });
    expect(within(stance).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'champion',
      'supportive',
      'neutral',
      'skeptical',
      'resistant',
    ]);
  });

  it('says so when the canvas is empty', () => {
    render(<GraphLegend model={modelFor(createExplorerState())} onToggleType={() => {}} />);
    expect(screen.getByText('Nothing on the canvas yet.')).toBeInTheDocument();
  });

  it('draws each type with the colour of its node, in both variants', () => {
    const state = loaded();
    const light = modelFor(state, 'light').types[0];
    const dark = modelFor(state, 'dark').types[0];
    expect(light.color).not.toBe(dark.color);
    const { container } = render(<GraphLegend model={modelFor(state, 'dark')} mode="dark" onToggleType={() => {}} />);
    expect(container.querySelector(`circle[fill="${dark.color}"]`)).not.toBeNull();
  });

  it('has no axe violations, with and without the stance key and hidden rows', async () => {
    const state = loaded(['Meeting']);
    state.graph.setEdgeAttribute(state.graph.edges()[0], 'stance', 'resistant');
    const { container } = render(
      <GraphLegend model={modelFor(state)} mode="dark" onToggleType={() => {}} onToggleRelation={() => {}} />,
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('useLegendTypeFilter — the `types` URL parameter', () => {
  function Harness({ state }: { state: ExplorerState }) {
    const location = useLocation();
    const { hiddenTypes, toggleType } = useLegendTypeFilter(ALL_KEYS);
    state.hiddenTypes = new Set(hiddenTypes);
    return (
      <>
        <output data-testid="search">{location.search}</output>
        <GraphLegend model={modelFor(state)} onToggleType={toggleType} />
      </>
    );
  }
  const search = () => screen.getByTestId('search').textContent;

  it('writes the SHOWN types when a type is hidden, and drops the parameter when all are shown again', async () => {
    const user = userEvent.setup();
    render(<Harness state={loaded()} />, { wrapperOptions: { route: '/graph/explore' } });
    expect(search()).toBe('');

    await user.click(screen.getByRole('button', { name: 'Meetings' }));
    expect(screen.getByRole('button', { name: 'Meetings' })).toHaveAttribute('aria-pressed', 'false');
    const shown = new URLSearchParams(search()!).get('types')!.split(',');
    expect(shown).not.toContain('Meeting');
    expect(shown).toContain('Person');
    expect(shown.sort()).toEqual(ALL_KEYS.filter((k) => k !== 'Meeting').sort());

    await user.click(screen.getByRole('button', { name: 'Meetings' }));
    expect(screen.getByRole('button', { name: 'Meetings' })).toHaveAttribute('aria-pressed', 'true');
    expect(search()).toBe('');
  });

  it('reads the parameter back: a reload with ?types= hides everything not listed', () => {
    render(<Harness state={loaded()} />, { wrapperOptions: { route: '/graph/explore?types=Person,Organization' } });
    expect(screen.getByRole('button', { name: 'People' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Organizations' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Meetings' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps the other search parameters', async () => {
    const user = userEvent.setup();
    render(<Harness state={loaded()} />, { wrapperOptions: { route: `/graph/explore?seed=${JOE_ID}&asOf=2026-06-01` } });
    await user.click(screen.getByRole('button', { name: 'Meetings' }));
    const params = new URLSearchParams(search()!);
    expect(params.get('seed')).toBe(JOE_ID);
    expect(params.get('asOf')).toBe('2026-06-01');
    expect(params.get('types')).toBeTruthy();
  });
});
