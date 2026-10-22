import { describe, expect, it } from 'vitest';

import {
  CONNECT_MAX_SEEDS,
  bridgeRows,
  connectSeedIds,
  pluralNoun,
  sharedIdSet,
  sharedRows,
  summarySentence,
} from '../../src/graph/ui/components/explorer/connect/connectModel.js';
import type { GraphConnectResponse } from '../../src/graph/headless/clients/graph.js';
import { parseConnectNotes } from '../../src/graph/ui/hooks/useExplorerConnect.js';
import { gid } from './graphData.js';

const N1 = gid(101);
const N2 = gid(102);
const P1 = gid(1);
const P2 = gid(2);
const PROD = gid(3);
const RISK = gid(4);
const ORG = gid(5);

function node(id: string, label: string, type: string) {
  return { id, label, type, nodeKind: 'entity', depth: 0, degree: 1, status: null, occurredAt: null } as never;
}

const typeLabel = (type: string) =>
  ({ Person: 'Person', Product: 'Product', Risk: 'Risk', Organization: 'Organization' })[type] ?? type;

function response(over: Partial<GraphConnectResponse> = {}): GraphConnectResponse {
  return {
    inputs: [
      { kind: 'note', id: N1, title: 'Company A call', entityIds: [P1, PROD, ORG] },
      { kind: 'note', id: N2, title: 'Microsoft call', entityIds: [P1, P2, PROD, RISK] },
    ],
    shared: [
      { entityId: P1, inputIds: [N1, N2], mentionCount: 6 },
      { entityId: P2, inputIds: [N1, N2], mentionCount: 3 },
      { entityId: PROD, inputIds: [N1, N2], mentionCount: 2 },
      { entityId: RISK, inputIds: [N1, N2], mentionCount: 2 },
    ],
    paths: [{ fromInput: N1, toInput: N2, nodeIds: [ORG, P1], edgeIds: ['e1'], score: 0.7 }],
    slice: {
      seedIds: [P1],
      asOf: '2026-01-01T00:00:00.000Z',
      nodes: [
        node(P1, 'Joe', 'Person'),
        node(P2, 'Ana', 'Person'),
        node(PROD, 'Copilot', 'Product'),
        node(RISK, 'Vendor lock-in', 'Risk'),
        node(ORG, 'Company A', 'Organization'),
      ],
      edges: [],
      truncated: false,
      cap: 300,
    },
    truncated: false,
    ...over,
  };
}

describe('pluralNoun', () => {
  it.each([
    ['Person', 1, 'person'],
    ['Person', 3, 'people'],
    ['Product', 2, 'products'],
    ['Risk', 1, 'risk'],
    ['Company', 2, 'companies'],
    ['Business', 2, 'businesses'],
    ['Key person', 2, 'key people'],
    ['', 2, ''],
  ])('%s x%i is %s', (label, count, expected) => {
    expect(pluralNoun(label, count)).toBe(expected);
  });
});

describe('summarySentence', () => {
  it('counts the shared entities by type, the largest group first', () => {
    expect(summarySentence(response(), typeLabel)).toBe('2 people, 1 product and 1 risk in common');
  });

  it('reads naturally for one group, and says so when nothing is shared', () => {
    const one = response({ shared: [{ entityId: P1, inputIds: [N1, N2], mentionCount: 1 }] });
    expect(summarySentence(one, typeLabel)).toBe('1 person in common');
    expect(summarySentence(response({ shared: [] }), typeLabel)).toBe('Nothing in common yet');
  });

  it('names the types the ontology labels', () => {
    const labels = (type: string) => (type === 'Person' ? 'Stakeholder' : type);
    expect(summarySentence(response(), labels)).toContain('2 stakeholders');
  });
});

describe('sharedRows, bridgeRows and sharedIdSet', () => {
  it('turns the shared entities into rows with the input titles, in the API order', () => {
    const rows = sharedRows(response());
    expect(rows.map((r) => r.label)).toEqual(['Joe', 'Ana', 'Copilot', 'Vendor lock-in']);
    expect(rows[0]).toMatchObject({ coverage: 2, mentionCount: 6, type: 'Person' });
    expect(rows[0].inputTitles).toEqual(['Company A call', 'Microsoft call']);
  });

  it('falls back to the id for an entity the slice does not carry', () => {
    const rows = sharedRows(response({ shared: [{ entityId: gid(99), inputIds: [N1, N2], mentionCount: 1 }] }));
    expect(rows[0].label).toBe(gid(99));
  });

  it('labels every node along a bridge', () => {
    const [bridge] = bridgeRows(response());
    expect(bridge.labels).toEqual(['Company A', 'Joe']);
    expect(bridge.fromTitle).toBe('Company A call');
    expect(bridge.toTitle).toBe('Microsoft call');
  });

  it('rings the shared entities only', () => {
    expect([...sharedIdSet(response())].sort()).toEqual([P1, P2, PROD, RISK].sort());
    expect(sharedIdSet(null).size).toBe(0);
  });
});

describe('connectSeedIds', () => {
  it('puts the shared entities first, then each input in turn, without repeats', () => {
    const seeds = connectSeedIds(response());
    expect(seeds.slice(0, 4)).toEqual([P1, P2, PROD, RISK]);
    expect(seeds).toContain(ORG);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('seeds a single note from its own entities', () => {
    const single = response({
      inputs: [{ kind: 'note', id: N1, title: 'Alone', entityIds: [ORG, P1] }],
      shared: [],
      paths: [],
    });
    expect(connectSeedIds(single)).toEqual([ORG, P1]);
  });

  it('is empty when nothing is touched, and capped at the seed limit', () => {
    expect(connectSeedIds(response({ inputs: [], shared: [] }))).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => gid(200 + i));
    const big = response({ inputs: [{ kind: 'note', id: N1, title: 'Big', entityIds: many }], shared: [] });
    expect(connectSeedIds(big)).toHaveLength(CONNECT_MAX_SEEDS);
  });
});

describe('parseConnectNotes', () => {
  it('keeps distinct uuids, at most ten, and drops anything else', () => {
    const ids = Array.from({ length: 12 }, (_, i) => gid(i + 1));
    expect(parseConnectNotes([...ids, 'nope', ids[0]].join(','))).toEqual(ids.slice(0, 10));
    expect(parseConnectNotes(null)).toEqual([]);
    expect(parseConnectNotes('')).toEqual([]);
  });
});
