import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { ExplorerLensMenu, type ExplorerLensMenuProps } from '../../src/graph/ui/components/explorer/lenses/LensMenu.js';
import {
  LENS_LIMITS,
  TOO_MANY_LENSES,
  builtInLenses,
  type ExplorerLens,
} from '../../src/graph/ui/components/explorer/lenses/lensModel.js';
import { useExplorerLenses } from '../../src/graph/ui/components/explorer/lenses/useExplorerLenses.js';
import { http, HttpResponse, server } from './msw-compat.js';
import { render, renderHook } from './helpers.js';
import { graphOntologyFixture } from './graphData.js';
import { nodeTypeOptions, relationTypeOptions } from '../../src/graph/headless/utils/explorerFilters.js';

/**
 * Saved lenses through the per-user settings store (GIC-17, #678): save, rename and delete go to
 * `PATCH /api/user-settings` as the whole `graph.explorer.lenses` list; the limits are checked
 * first, with a friendly sentence; and the Lens menu is a dropdown or a full-screen list.
 */

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };
const lens = (id: string, name: string): ExplorerLens => ({
  id,
  name,
  seeds: [],
  types: ['Person'],
  relTypes: null,
  layout: 'force',
  pins: {},
});

let stored: { lenses: ExplorerLens[]; version: number };
let patches: Array<{ body: Record<string, unknown>; ifMatch: string | null }>;
let conflictsToServe = 0;

function useSettings(initial: ExplorerLens[] = []) {
  stored = { lenses: initial, version: 3 };
  patches = [];
  conflictsToServe = 0;
  const document = () => ({
    theme: 'system',
    ...(stored.lenses.length > 0 ? { graph: { explorer: { lenses: stored.lenses } } } : {}),
    version: stored.version,
  });
  server.use(
    http.get('*/api/user-settings', () => HttpResponse.json({ data: document() })),
    http.patch('*/api/user-settings', async ({ request }) => {
      const body = (await request.json()) as { graph: { explorer: { lenses: ExplorerLens[] } } };
      patches.push({ body, ifMatch: request.headers.get('If-Match') });
      if (conflictsToServe > 0) {
        conflictsToServe -= 1;
        stored.version += 1;
        return HttpResponse.json({ message: 'Version conflict', statusCode: 409 }, { status: 409 });
      }
      stored.lenses = body.graph.explorer.lenses;
      stored.version += 1;
      return HttpResponse.json({ data: document() });
    }),
  );
}

beforeEach(() => useSettings());

describe('useExplorerLenses', () => {
  it('reads the saved lenses from graph.explorer.lenses', async () => {
    useSettings([lens('1', 'Mine')]);
    const { result } = renderHook(() => useExplorerLenses());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.lenses).toEqual([lens('1', 'Mine')]);
  });

  it('saves, renames and deletes through the settings API, sending the whole list with If-Match', async () => {
    const { result } = renderHook(() => useExplorerLenses());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      expect(await result.current.save(lens('1', 'Mine'))).toBe(true);
    });
    expect(patches[0].body).toEqual({ graph: { explorer: { lenses: [lens('1', 'Mine')] } } });
    expect(patches[0].ifMatch).toBe('3');
    expect(result.current.lenses.map((l) => l.name)).toEqual(['Mine']);

    await act(async () => {
      expect(await result.current.rename('1', 'Better')).toBe(true);
    });
    expect(patches[1].body).toEqual({ graph: { explorer: { lenses: [lens('1', 'Better')] } } });
    expect(patches[1].ifMatch).toBe('4');

    await act(async () => {
      expect(await result.current.remove('1')).toBe(true);
    });
    expect(patches[2].body).toEqual({ graph: { explorer: { lenses: [] } } });
    expect(result.current.lenses).toEqual([]);
  });

  it('refuses the 21st lens with a friendly sentence, without a request', async () => {
    useSettings(Array.from({ length: LENS_LIMITS.maxLenses }, (_, i) => lens(`l${i}`, `Lens ${i}`)));
    const { result } = renderHook(() => useExplorerLenses());
    await waitFor(() => expect(result.current.lenses).toHaveLength(LENS_LIMITS.maxLenses));
    await act(async () => {
      expect(await result.current.save(lens('new', 'One more'))).toBe(false);
    });
    expect(result.current.error).toBe(TOO_MANY_LENSES);
    expect(patches).toHaveLength(0);
  });

  it('retries once against the fresh document after a 409', async () => {
    const { result } = renderHook(() => useExplorerLenses());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    conflictsToServe = 1;
    await act(async () => {
      expect(await result.current.save(lens('1', 'Mine'))).toBe(true);
    });
    expect(patches.map((p) => p.ifMatch)).toEqual(['3', '4']);
  });

  it('says so when the server refuses the write', async () => {
    const { result } = renderHook(() => useExplorerLenses());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    server.use(
      http.patch('*/api/user-settings', () =>
        HttpResponse.json({ message: 'graph.explorer.lenses: too many', statusCode: 400 }, { status: 400 }),
      ),
    );
    await act(async () => {
      expect(await result.current.save(lens('1', 'Mine'))).toBe(false);
    });
    expect(result.current.error).toMatch(/too many/);
  });
});

const NODE_KEYS = nodeTypeOptions(graphOntologyFixture).map((o) => o.key);
const REL_KEYS = relationTypeOptions(graphOntologyFixture).map((o) => o.key);

function Harness(props: Partial<ExplorerLensMenuProps>) {
  const [error, setError] = useState<string | null>(null);
  return (
    <ExplorerLensMenu
      windowClass="expanded"
      inputModality="pointer"
      builtIn={builtInLenses(NODE_KEYS, REL_KEYS)}
      lenses={[lens('u1', 'Copilot map')]}
      activeId={null}
      modified={false}
      busy={false}
      error={error}
      onClearError={() => setError(null)}
      onApply={vi.fn()}
      onSave={async (name) => {
        if (name === 'Taken') {
          setError('You already have a lens with that name.');
          return false;
        }
        return true;
      }}
      onRename={vi.fn(async () => true)}
      onDelete={vi.fn(async () => true)}
      {...props}
    />
  );
}

describe('ExplorerLensMenu', () => {
  it('lists the built-in and saved lenses and applies one', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    await user.click(screen.getByRole('button', { name: 'Lens' }));
    const panel = await screen.findByRole('dialog', { name: 'Lenses' });
    expect(within(panel).getByText('Stakeholders & stance')).toBeInTheDocument();
    expect(within(panel).getByText('Copilot map')).toBeInTheDocument();

    await user.click(within(panel).getByText('Stakeholders & stance'));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: 'builtin:stakeholders-stance' }));
  });

  it('saves the current view under a name, and shows a refusal in the dialog', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (name: string) => name !== 'Taken');
    render(<Harness onSave={onSave} />);
    await user.click(screen.getByRole('button', { name: 'Lens' }));
    await user.click(await screen.findByRole('button', { name: /Save current view as a lens/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Save as a lens' });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'My map');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('My map');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save as a lens' })).not.toBeInTheDocument());
  });

  it('renames and deletes a saved lens', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => true);
    const onDelete = vi.fn(async () => true);
    render(<Harness onRename={onRename} onDelete={onDelete} />);
    await user.click(screen.getByRole('button', { name: 'Lens' }));

    await user.click(await screen.findByRole('button', { name: 'Delete Copilot map' }));
    expect(onDelete).toHaveBeenCalledWith('u1');

    await user.click(screen.getByRole('button', { name: 'Rename Copilot map' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename lens' });
    const field = within(dialog).getByRole('textbox', { name: 'Name' });
    expect(field).toHaveValue('Copilot map');
    await user.clear(field);
    await user.type(field, 'Rollout');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(onRename).toHaveBeenCalledWith('u1', 'Rollout');
  });

  it('on a phone there is no button: the overflow menu opens the same list full-screen', async () => {
    const user = userEvent.setup();
    const onCompactClose = vi.fn();
    const { rerender } = render(<Harness windowClass="compact" inputModality="touch" compactOpen={false} onCompactClose={onCompactClose} />);
    expect(screen.queryByRole('button', { name: 'Lens' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(<Harness windowClass="compact" inputModality="touch" compactOpen onCompactClose={onCompactClose} />);
    const list = await screen.findByRole('dialog', { name: 'Lenses' });
    expect(within(list).getByText('People network')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: 'Close' }));
    expect(onCompactClose).toHaveBeenCalled();
  });

  it('marks the active lens as changed once the view drifts from it', async () => {
    const user = userEvent.setup();
    render(<Harness activeId="u1" modified />);
    expect(screen.getByRole('button', { name: 'Copilot map (changed)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copilot map (changed)' }));
    expect(await screen.findByText('Changed since applied')).toBeInTheDocument();
  });

  it('tells the user at 20 lenses and disables Save', async () => {
    const user = userEvent.setup();
    const lenses = Array.from({ length: LENS_LIMITS.maxLenses }, (_, i) => lens(`l${i}`, `Lens ${i}`));
    render(<Harness lenses={lenses} />);
    await user.click(screen.getByRole('button', { name: 'Lens' }));
    expect(await screen.findByText(/the most you can save/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save current view as a lens/ })).toBeDisabled();
  });

  it('has no axe violations open', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Lens' }));
    await screen.findByRole('dialog', { name: 'Lenses' });
    expect(await axe(document.body, AXE_OPTIONS)).toHaveNoViolations();
    expect(container).toBeTruthy();
  });
});
