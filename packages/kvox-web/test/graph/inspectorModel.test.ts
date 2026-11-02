import { describe, expect, it } from 'vitest';

import type { GraphSlice, TimelineEvent } from '../../src/graph/headless/clients/graph.js';
import { evidenceIdsOf } from '../../src/graph/headless/hooks/useGraphEvidenceFeed.js';
import { createExplorerState, mergeSlice, type ExplorerState } from '../../src/graph/ui/components/explorer/explorerModel.js';
import {
  buildSelection,
  connectionGroups,
  defaultTabFor,
  evidenceSubjectForNode,
  expandMenuModel,
  parseInspectorTab,
  summariseSelection,
  tabsFor,
  type NodeSelection,
} from '../../src/graph/ui/components/explorer/inspector/inspectorModel.js';
import {
  decodeSelection,
  encodeSelection,
} from '../../src/graph/ui/components/explorer/inspector/useInspectorUrlState.js';
import { KAPPA_ID, ANDERS_ID, ATLAS_COMMITMENT_ID, JONTY_ID, Q3_MEETING_ID, expandFixture, gid } from './graphData.js';

/** The inspector's pure model (GIC-11, #672): no React, no canvas. */

function jontyState(): ExplorerState {
  const state = createExplorerState();
  const slice = expandFixture({ nodeIds: [JONTY_ID], cap: 300 })!;
  mergeSlice(state, slice);
  state.seedIds = [JONTY_ID];
  return state;
}

const label = (type: string) => type;
const pinned = () => false;

function nodeOf(state: ExplorerState, id: string): NodeSelection {
  const selection = buildSelection({ selected: { kind: 'node', id }, state, ontology: null, typeLabel: label, pinned });
  if (selection?.kind !== 'node') throw new Error('not a node');
  return selection;
}

describe('tabs', () => {
  it('gives an entity five tabs with Ask, four without, an item three and an edge two', () => {
    const state = jontyState();
    const jonty = nodeOf(state, JONTY_ID);
    expect(tabsFor(jonty, true)).toEqual(['overview', 'evidence', 'connections', 'timeline', 'ask']);
    expect(tabsFor(jonty, false)).toEqual(['overview', 'evidence', 'connections', 'timeline']);
    expect(tabsFor(nodeOf(state, ATLAS_COMMITMENT_ID), true)).toEqual(['overview', 'evidence', 'connections']);
    const edge = buildSelection({ selected: { kind: 'edge', id: gid(411) }, state, ontology: null, typeLabel: label, pinned })!;
    expect(tabsFor(edge, true)).toEqual(['overview', 'evidence']);
  });

  it('opens a node on Overview and an edge on Evidence', () => {
    const state = jontyState();
    expect(defaultTabFor(nodeOf(state, JONTY_ID))).toBe('overview');
    expect(
      defaultTabFor(buildSelection({ selected: { kind: 'edge', id: gid(411) }, state, ontology: null, typeLabel: label, pinned })!),
    ).toBe('evidence');
  });

  it('reads a tab from the URL and refuses an unknown one', () => {
    expect(parseInspectorTab('timeline')).toBe('timeline');
    expect(parseInspectorTab('bogus')).toBeNull();
    expect(parseInspectorTab(null)).toBeNull();
  });
});

describe('what the Evidence tab may ask about', () => {
  it('asks about an entity and about an item, but never about a person fact', () => {
    expect(evidenceSubjectForNode({ id: 'a', nodeKind: 'entity', entityType: 'Person' })).toEqual({ kind: 'entity', id: 'a' });
    expect(evidenceSubjectForNode({ id: 'b', nodeKind: 'item', entityType: 'commitment' })).toEqual({ kind: 'item', id: 'b' });
    expect(evidenceSubjectForNode({ id: 'c', nodeKind: 'item', entityType: 'person_fact' })).toBeNull();
  });

  it('asks about a real edge by its id and about a derived edge by its item', () => {
    const state = jontyState();
    const real = buildSelection({ selected: { kind: 'edge', id: gid(411) }, state, ontology: null, typeLabel: label, pinned });
    expect(real).toMatchObject({ evidenceSubject: { kind: 'relation', id: gid(411) } });
    const derived = buildSelection({
      selected: { kind: 'edge', id: `virt:${ATLAS_COMMITMENT_ID}:ASSIGNED_TO` },
      state,
      ontology: null,
      typeLabel: label,
      pinned,
    });
    expect(derived).toMatchObject({ virtual: true, evidenceSubject: { kind: 'item', id: ATLAS_COMMITMENT_ID } });
  });

  it('has no evidence subject for an edge that touches a person fact', () => {
    const state = jontyState();
    const factId = gid(77);
    const slice: GraphSlice = {
      seedIds: [JONTY_ID],
      asOf: '2026-09-26T00:00:00.000Z',
      nodes: [{ id: factId, nodeKind: 'item', type: 'person_fact', label: 'Likes sailing', depth: 1, degree: 1, status: null, occurredAt: null }],
      edges: [
        { id: `virt:${factId}:ABOUT`, type: 'ABOUT', source: factId, target: JONTY_ID, valid: null, confidence: null, virtual: true },
        { id: gid(78), type: 'ABOUT', source: factId, target: JONTY_ID, valid: null, confidence: 0.5, virtual: false },
      ],
      truncated: false,
      cap: 300,
    };
    mergeSlice(state, slice);
    for (const id of [`virt:${factId}:ABOUT`, gid(78)]) {
      const selection = buildSelection({ selected: { kind: 'edge', id }, state, ontology: null, typeLabel: label, pinned });
      expect(selection).toMatchObject({ kind: 'edge', evidenceSubject: null });
    }
  });

  it('drops sensitive facts from the ids a timeline contributes', () => {
    const event = (id: string, sensitivity: 'business' | 'sensitive' | null, evidenceIds: string[]): TimelineEvent =>
      ({
        id,
        eventKind: sensitivity ? 'item' : 'meeting',
        at: null,
        precision: 'unknown',
        item: sensitivity
          ? { id: gid(1), kind: 'person_fact', title: null, statement: 's', status: null, dueAt: null, ownerPerson: null, counterparty: null, sensitivity, superseded: false, supersededById: null }
          : undefined,
        evidenceIds,
        evidenceCount: evidenceIds.length,
      }) as TimelineEvent;
    expect(evidenceIdsOf([event('a', 'business', ['e1']), event('b', 'sensitive', ['e2', 'e3']), event('c', null, ['e4'])])).toEqual([
      'e1',
      'e4',
    ]);
  });
});

describe('buildSelection', () => {
  it('carries the node facts the header shows', () => {
    const state = jontyState();
    const jonty = nodeOf(state, JONTY_ID);
    expect(jonty).toMatchObject({ label: 'Jonty Placeholder', entityType: 'Person', isSeed: true, expanded: false, pinned: false });
    expect(nodeOf(state, KAPPA_ID).isSeed).toBe(false);
  });

  it('is null for a node or an edge that left the canvas, and for the line to a stub', () => {
    const state = jontyState();
    expect(buildSelection({ selected: { kind: 'node', id: 'gone' }, state, ontology: null, typeLabel: label, pinned })).toBeNull();
    expect(buildSelection({ selected: { kind: 'edge', id: 'gone' }, state, ontology: null, typeLabel: label, pinned })).toBeNull();
    expect(buildSelection({ selected: null, state, ontology: null, typeLabel: label, pinned })).toBeNull();
  });

  it('turns an INVOLVED_IN edge into role and stance chips', () => {
    const state = createExplorerState();
    mergeSlice(state, {
      seedIds: [JONTY_ID],
      asOf: '2026-09-26T00:00:00.000Z',
      nodes: [
        { id: JONTY_ID, nodeKind: 'entity', type: 'Person', label: 'Jonty', depth: 0, degree: 1, status: null, occurredAt: null },
        { id: ATLAS_COMMITMENT_ID, nodeKind: 'entity', type: 'Project', label: 'Product X rollout', depth: 1, degree: 1, status: null, occurredAt: null },
      ],
      edges: [
        {
          id: gid(500),
          type: 'INVOLVED_IN',
          source: JONTY_ID,
          target: ATLAS_COMMITMENT_ID,
          valid: null,
          confidence: 0.8,
          virtual: false,
          props: { role: 'stakeholder', stance: 'skeptical' },
          evidenceCount: 3,
        },
      ],
      truncated: false,
      cap: 300,
    });
    const edge = buildSelection({ selected: { kind: 'edge', id: gid(500) }, state, ontology: null, typeLabel: label, pinned });
    expect(edge).toMatchObject({ chips: ['Stakeholder', 'skeptical'], stance: 'skeptical', evidenceCount: 3 });
  });
});

describe('connectionGroups', () => {
  it('groups the neighbours on the canvas by relation type, biggest first, with the API totals', () => {
    const state = jontyState();
    const groups = connectionGroups(state.graph, JONTY_ID, null, { ATTENDED: 9, WORKS_FOR: 1 });
    expect(groups.map((g) => g.relationType)).toEqual(['ATTENDED', 'ASSIGNED_TO', 'REPORTS_TO', 'WORKS_FOR']);
    const attended = groups[0]!;
    expect(attended.items.map((i) => i.label).sort()).toEqual(['Q3 planning', 'Weekly sync']);
    expect(attended.total).toBe(9);
    expect(groups.find((g) => g.relationType === 'REPORTS_TO')!.total).toBeNull();
  });

  it('says which end the edge leaves, and ignores "+N more" stubs', () => {
    const state = jontyState();
    const incoming = connectionGroups(state.graph, JONTY_ID, null).find((g) => g.relationType === 'ASSIGNED_TO')!;
    expect(incoming.items[0]).toMatchObject({ direction: 'in', label: 'Ship the Atlas beta' });
    state.graph.addNode('stub:x', { ...state.graph.getNodeAttributes(JONTY_ID), isStub: true, label: '+3 more' });
    state.graph.addDirectedEdgeWithKey('stubedge:x', JONTY_ID, 'stub:x', { ...state.graph.getEdgeAttributes(gid(410)), relationType: '__more' });
    expect(connectionGroups(state.graph, JONTY_ID, null).some((g) => g.relationType === '__more')).toBe(false);
  });
});

describe('expandMenuModel', () => {
  const base = { ontology: null, typeLabel: label, hiddenRelationTypes: new Set<string>(), hiddenTypes: new Set<string>() };

  it('lists relation types and neighbour types with their counts, biggest first', () => {
    const model = expandMenuModel({
      ...base,
      counts: { relationsByType: { WORKS_FOR: 2, ATTENDED: 7 }, relationsByNeighborType: { Organization: 2, Meeting: 7 } },
    });
    expect(model.byRelation.map((c) => [c.key, c.count])).toEqual([['ATTENDED', 7], ['WORKS_FOR', 2]]);
    expect(model.byType.map((c) => [c.key, c.count])).toEqual([['Meeting', 7], ['Organization', 2]]);
  });

  it('disables what the user filtered out, and is empty for an older API', () => {
    const model = expandMenuModel({
      ...base,
      counts: { relationsByType: { WORKS_FOR: 2 }, relationsByNeighborType: { Organization: 2 } },
      hiddenRelationTypes: new Set(['WORKS_FOR']),
      hiddenTypes: new Set(['Organization']),
    });
    expect(model.byRelation[0]!.disabled).toBe(true);
    expect(model.byType[0]!.disabled).toBe(true);
    expect(expandMenuModel({ ...base, counts: {} })).toEqual({ byRelation: [], byType: [] });
    expect(expandMenuModel({ ...base, counts: undefined })).toEqual({ byRelation: [], byType: [] });
  });
});

describe('summariseSelection', () => {
  it('counts by type and names the neighbours two or more of the nodes share', () => {
    const state = jontyState();
    // Anders and Kappa meet at Jonty (Jonty -> Anders, Jonty -> Kappa) and at the Q3 meeting is only Jonty's.
    mergeSlice(state, expandFixture({ nodeIds: [ANDERS_ID], cap: 300 })!);
    const summary = summariseSelection(state, new Set([ANDERS_ID, KAPPA_ID]));
    expect(summary.ids.sort()).toEqual([KAPPA_ID, ANDERS_ID].sort());
    expect(summary.byType).toEqual([
      { type: 'Organization', count: 1 },
      { type: 'Person', count: 1 },
    ]);
    expect(summary.shared.map((s) => s.label)).toContain('Jonty Placeholder');
    expect(summary.shared.every((s) => s.count >= 2)).toBe(true);
    expect(summary.seedCount).toBe(0);
  });

  it('ignores nodes that left the canvas, and counts seeds', () => {
    const state = jontyState();
    const summary = summariseSelection(state, new Set([JONTY_ID, Q3_MEETING_ID, 'gone']));
    expect(summary.ids.sort()).toEqual([JONTY_ID, Q3_MEETING_ID].sort());
    expect(summary.seedCount).toBe(1);
  });
});

describe('the selection in the URL', () => {
  it('round-trips a node and an edge, including a derived edge id with colons', () => {
    expect(decodeSelection(encodeSelection({ kind: 'node', id: JONTY_ID }))).toEqual({ kind: 'node', id: JONTY_ID });
    const derived = `virt:${ATLAS_COMMITMENT_ID}:ASSIGNED_TO`;
    expect(encodeSelection({ kind: 'edge', id: derived })).toBe(`e:${derived}`);
    expect(decodeSelection(`e:${derived}`)).toEqual({ kind: 'edge', id: derived });
    expect(encodeSelection(null)).toBeNull();
  });

  it('refuses anything malformed', () => {
    for (const raw of [null, '', 'x', 'n:', 'z:abc', ':abc']) expect(decodeSelection(raw)).toBeNull();
  });
});
