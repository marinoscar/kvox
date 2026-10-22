import { describe, expect, it } from 'vitest';

import { nodeTypeOptions, relationTypeOptions } from '../../src/graph/headless/utils/explorerFilters.js';
import {
  BLANK_LENS_NAME,
  LENS_LIMITS,
  TOO_MANY_LENSES,
  TOO_MANY_PINS,
  addLens,
  applyLensToParams,
  builtInLenses,
  captureLens,
  deleteLens,
  explorerPinsKey,
  isBuiltInLens,
  lensMatchesView,
  lensPaletteActions,
  renameLens,
  type ExplorerLens,
  type LensView,
} from '../../src/graph/ui/components/explorer/lenses/lensModel.js';
import { graphOntologyFixture } from './graphData.js';

/** Lenses (GIC-17, #678): the presets, applying a lens to the URL, and the limits. */

const NODE_KEYS = nodeTypeOptions(graphOntologyFixture).map((o) => o.key);
const REL_KEYS = relationTypeOptions(graphOntologyFixture).map((o) => o.key);

const lens = (id: string, name: string, over: Partial<ExplorerLens> = {}): ExplorerLens => ({
  id,
  name,
  seeds: [],
  types: null,
  relTypes: null,
  layout: null,
  pins: {},
  ...over,
});

describe('builtInLenses', () => {
  it('offers the four presets for the shipped ontology, in order', () => {
    const lenses = builtInLenses(NODE_KEYS, REL_KEYS);
    expect(lenses.map((l) => l.name)).toEqual([
      'People network',
      'Project map',
      'Stakeholders & stance',
      'Commitments & risks',
    ]);
    expect(lenses.every((l) => isBuiltInLens(l.id))).toBe(true);
  });

  it('Stakeholders & stance shows only INVOLVED_IN, between the types it connects', () => {
    const stance = builtInLenses(NODE_KEYS, REL_KEYS).find((l) => l.name === 'Stakeholders & stance')!;
    expect(stance.relTypes).toEqual(['INVOLVED_IN']);
    expect(stance.types).toEqual(expect.arrayContaining(['Person', 'Project']));
  });

  it('skips members the ontology does not have, and a preset with nothing left', () => {
    const project = builtInLenses(NODE_KEYS, REL_KEYS).find((l) => l.name === 'Project map')!;
    expect(project.types).toEqual(expect.arrayContaining(['Project', 'Product', 'Topic', 'risk', 'Person']));
    // Without the Risk item kind (an older ontology) the Project map keeps the rest.
    const older = builtInLenses(
      NODE_KEYS.filter((key) => key !== 'risk'),
      REL_KEYS,
    ).find((l) => l.name === 'Project map')!;
    expect(older.types).not.toContain('risk');
    expect(older.types).toEqual(expect.arrayContaining(['Project', 'Person']));

    const trimmed = builtInLenses(['Person', 'Organization'], ['WORKS_FOR']);
    expect(trimmed.map((l) => l.name)).toEqual(['People network']);
    expect(trimmed[0].relTypes).toEqual(['WORKS_FOR']);
    expect(builtInLenses([], [])).toEqual([]);
  });
});

describe('applyLensToParams', () => {
  it('writes types, relTypes, layout and lens, and clears the selection of the view it leaves', () => {
    const stance = builtInLenses(NODE_KEYS, REL_KEYS).find((l) => l.name === 'Stakeholders & stance')!;
    const params = new URLSearchParams('seed=abc&focus=n1&sel=n:n1&tab=evidence&asOf=2026-01-01');
    applyLensToParams(params, stance, NODE_KEYS, REL_KEYS);
    expect(params.get('relTypes')).toBe('INVOLVED_IN');
    expect(params.get('types')?.split(',')).toEqual(expect.arrayContaining(['Person', 'Project']));
    expect(params.get('layout')).toBe('concentric');
    expect(params.get('lens')).toBe(stance.id);
    expect(params.get('seed')).toBe('abc');
    expect(params.get('asOf')).toBe('2026-01-01');
    for (const gone of ['focus', 'sel', 'tab']) expect(params.has(gone)).toBe(false);
  });

  it('leaves the reserved keys of other stories alone', () => {
    const params = new URLSearchParams('from=2026-01-01&to=2026-02-01&pathFrom=a&pathTo=b');
    applyLensToParams(params, lens('l1', 'x'), NODE_KEYS, REL_KEYS);
    expect(params.get('from')).toBe('2026-01-01');
    expect(params.get('to')).toBe('2026-02-01');
    expect(params.get('pathFrom')).toBe('a');
    expect(params.get('pathTo')).toBe('b');
  });

  it('a lens with seeds sets them; one with a list of unknown types shows everything', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const params = new URLSearchParams('types=Person&cluster=c');
    applyLensToParams(params, lens('l1', 'x', { seeds: [id], types: ['Nope'], relTypes: ['Gone'] }), NODE_KEYS, REL_KEYS);
    expect(params.get('seed')).toBe(id);
    expect(params.has('cluster')).toBe(false);
    expect(params.has('types')).toBe(false);
    expect(params.has('relTypes')).toBe(false);
  });
});

describe('captureLens and lensMatchesView', () => {
  const view = (over: Partial<LensView> = {}): LensView => ({
    seeds: ['a'],
    hiddenTypes: new Set(),
    hiddenRelationTypes: new Set(),
    nodeKeys: ['Person', 'Project'],
    relationKeys: ['WORKS_FOR', 'INVOLVED_IN'],
    layout: 'force',
    pins: new Map([['a', { x: 1, y: 2 }]]),
    ...over,
  });

  it('stores the SHOWN lists (null when nothing is hidden), the layout and the pins', () => {
    expect(captureLens(view(), 'id', '  Mine ')).toEqual({
      id: 'id',
      name: 'Mine',
      seeds: ['a'],
      types: null,
      relTypes: null,
      layout: 'force',
      pins: { a: { x: 1, y: 2 } },
    });
    const filtered = captureLens(view({ hiddenTypes: new Set(['Project']), hiddenRelationTypes: new Set(['WORKS_FOR']) }), 'id', 'x');
    expect(filtered.types).toEqual(['Person']);
    expect(filtered.relTypes).toEqual(['INVOLVED_IN']);
  });

  it('matches until the filters, layout or seeds change', () => {
    const saved = captureLens(view({ hiddenTypes: new Set(['Project']) }), 'id', 'x');
    expect(lensMatchesView(saved, view({ hiddenTypes: new Set(['Project']) }))).toBe(true);
    expect(lensMatchesView(saved, view())).toBe(false);
    expect(lensMatchesView(saved, view({ hiddenTypes: new Set(['Project']), layout: 'concentric' }))).toBe(false);
    expect(lensMatchesView(saved, view({ hiddenTypes: new Set(['Project']), seeds: ['b'] }))).toBe(false);
  });
});

describe('the list of saved lenses', () => {
  it('adds, refuses a blank or taken name, renames and deletes', () => {
    const added = addLens([], lens('1', ' Mine '));
    expect(added).toEqual({ ok: true, lenses: [lens('1', 'Mine')] });
    expect(addLens([], lens('1', '   '))).toEqual({ ok: false, message: BLANK_LENS_NAME });
    expect(addLens([lens('1', 'Mine')], lens('2', 'mine')).ok).toBe(false);

    const renamed = renameLens([lens('1', 'Mine'), lens('2', 'Other')], '2', 'Better');
    expect(renamed.ok && renamed.lenses.map((l) => l.name)).toEqual(['Mine', 'Better']);
    expect(renameLens([lens('1', 'Mine'), lens('2', 'Other')], '2', 'Mine').ok).toBe(false);
    // Renaming a lens to its own name (a case change) is allowed.
    expect(renameLens([lens('1', 'Mine')], '1', 'MINE').ok).toBe(true);

    expect(deleteLens([lens('1', 'a'), lens('2', 'b')], '1').map((l) => l.id)).toEqual(['2']);
  });

  it('enforces 20 lenses and 300 pins with a friendly sentence', () => {
    const full = Array.from({ length: LENS_LIMITS.maxLenses }, (_, i) => lens(`l${i}`, `Lens ${i}`));
    expect(addLens(full, lens('new', 'One more'))).toEqual({ ok: false, message: TOO_MANY_LENSES });
    const pins = Object.fromEntries(Array.from({ length: LENS_LIMITS.maxPins + 1 }, (_, i) => [`n${i}`, { x: 0, y: 0 }]));
    expect(addLens([], lens('p', 'Pinned', { pins }))).toEqual({ ok: false, message: TOO_MANY_PINS });
    const fits = Object.fromEntries(Array.from({ length: LENS_LIMITS.maxPins }, (_, i) => [`n${i}`, { x: 0, y: 0 }]));
    expect(addLens([], lens('p', 'Pinned', { pins: fits })).ok).toBe(true);
  });
});

describe('small helpers', () => {
  it('keeps the old pins key without a lens and adds the lens when there is one', () => {
    expect(explorerPinsKey('a,b', null)).toBe('explore:a,b:');
    expect(explorerPinsKey('a', '2026-01-01', 'l1')).toBe('explore:a:2026-01-01:l1');
  });

  it('describes lens actions for the command palette', () => {
    const calls: string[] = [];
    const [first] = lensPaletteActions([lens('l1', 'Mine')], (l) => calls.push(l.id));
    expect(first).toMatchObject({ id: 'lens:l1', label: 'Lens: Mine', group: 'Lenses' });
    first.run();
    expect(calls).toEqual(['l1']);
  });
});
