import { MultiDirectedGraph } from 'graphology';
import { describe, expect, it } from 'vitest';

import type { ExplorerGraph } from '../../src/graph/ui/components/explorer/explorerModel.js';
import {
  MAX_PALETTE_SEEDS,
  canvasMatches,
  fuzzyScore,
  parsePaletteQuery,
  seedCapMessage,
  seedPlan,
} from '../../src/graph/ui/components/explorer/palette/paletteModel.js';

const TYPES = [
  { key: 'Person', label: 'People' },
  { key: 'Product', label: 'Products' },
  { key: 'commitment', label: 'Commitments' },
];

function graphOf(nodes: { id: string; label: string; type: string; stub?: boolean }[]): {
  graph: ExplorerGraph;
  ids: Set<string>;
} {
  const graph = new MultiDirectedGraph() as ExplorerGraph;
  for (const node of nodes) {
    graph.addNode(node.id, { label: node.label, entityType: node.type, isStub: node.stub, x: 0, y: 0 } as never);
  }
  return { graph, ids: new Set(nodes.map((n) => n.id)) };
}

describe('parsePaletteQuery', () => {
  it('splits type tokens from the free text, by key or label, ignoring case', () => {
    expect(parsePaletteQuery('type:Person joe', TYPES)).toEqual({ text: 'joe', types: ['Person'], unknownTypes: [] });
    expect(parsePaletteQuery('copilot TYPE:products', TYPES)).toEqual({ text: 'copilot', types: ['Product'], unknownTypes: [] });
    expect(parsePaletteQuery('type:People type:Person joe rivera', TYPES).types).toEqual(['Person']);
    expect(parsePaletteQuery('type:commitment', TYPES).types).toEqual(['commitment']);
  });

  it('reports a token that names no type, and ignores a bare "type:"', () => {
    expect(parsePaletteQuery('type:Spaceship joe', TYPES)).toEqual({ text: 'joe', types: [], unknownTypes: ['Spaceship'] });
    expect(parsePaletteQuery('type: joe', TYPES)).toEqual({ text: 'joe', types: [], unknownTypes: [] });
    expect(parsePaletteQuery('   ', TYPES)).toEqual({ text: '', types: [], unknownTypes: [] });
  });
});

describe('fuzzyScore', () => {
  it('ranks prefix over word start over substring over subsequence, and rejects the rest', () => {
    const prefix = fuzzyScore('Joe Rivera', 'joe')!;
    const word = fuzzyScore('Big Joe', 'joe')!;
    const sub = fuzzyScore('Bojoe', 'joe')!;
    const subsequence = fuzzyScore('Jane Orla Ellis', 'joe')!;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(subsequence);
    expect(fuzzyScore('Ana Diaz', 'joe')).toBeNull();
    expect(fuzzyScore('Anything', '')).toBe(0);
  });
});

describe('canvasMatches', () => {
  const { graph, ids } = graphOf([
    { id: 'a', label: 'Joe Rivera', type: 'Person' },
    { id: 'b', label: 'Copilot rollout', type: 'Project' },
    { id: 'c', label: 'Microsoft Copilot', type: 'Product' },
    { id: 'd', label: '+3 more', type: 'Person', stub: true },
    { id: 'e', label: 'Joel Park', type: 'Person' },
  ]);

  it('matches loaded labels best first, and never a stub', () => {
    const found = canvasMatches(graph, ids, parsePaletteQuery('joe', TYPES));
    // Both are prefix matches; the shorter label wins the tie.
    expect(found.map((m) => m.id)).toEqual(['e', 'a']);
    expect(canvasMatches(graph, ids, parsePaletteQuery('more', TYPES))).toEqual([]);
  });

  it('narrows by type tokens, with or without text', () => {
    expect(canvasMatches(graph, ids, parsePaletteQuery('type:Product copilot', TYPES)).map((m) => m.id)).toEqual(['c']);
    expect(canvasMatches(graph, ids, parsePaletteQuery('type:Person', TYPES)).map((m) => m.id).sort()).toEqual(['a', 'e']);
  });

  it('returns nothing for an empty query, and only visible nodes', () => {
    expect(canvasMatches(graph, ids, parsePaletteQuery('', TYPES))).toEqual([]);
    expect(canvasMatches(graph, new Set(['b']), parsePaletteQuery('joe', TYPES))).toEqual([]);
  });

  it('honours the limit', () => {
    expect(canvasMatches(graph, ids, parsePaletteQuery('o', TYPES), 2)).toHaveLength(2);
  });
});

describe('seedPlan', () => {
  const ten = Array.from({ length: MAX_PALETTE_SEEDS }, (_, i) => `s${i}`);

  it('adds, keeps an existing seed once, and replaces', () => {
    expect(seedPlan(['a'], 'b', 'add')).toEqual({ kind: 'set', seedIds: ['a', 'b'] });
    expect(seedPlan(['a', 'b'], 'b', 'add')).toEqual({ kind: 'set', seedIds: ['a', 'b'] });
    expect(seedPlan(['a', 'b'], 'c', 'replace')).toEqual({ kind: 'set', seedIds: ['c'] });
  });

  it('refuses the eleventh seed with a message, but still replaces', () => {
    expect(seedPlan(ten, 'new', 'add')).toEqual({ kind: 'refused', message: seedCapMessage() });
    expect(seedCapMessage()).toMatch(/up to 10/);
    expect(seedPlan(ten, 'new', 'replace')).toEqual({ kind: 'set', seedIds: ['new'] });
    expect(seedPlan(ten, ten[3], 'add')).toEqual({ kind: 'set', seedIds: ten });
  });
});
