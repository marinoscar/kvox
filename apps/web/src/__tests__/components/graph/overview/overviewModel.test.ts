import { createTheme } from '@mui/material/styles';
import { describe, expect, it } from 'vitest';

import {
  OVERVIEW_DRILL_DOWN_MAX,
  applyClusterFocus,
  buildClusterGraph,
  buildNodeGraph,
  clusterAnnouncement,
  clusterColor,
  clusterHandoff,
  clusterKeyboardOrder,
  clusterNodeKey,
  clusterPalette,
  clusterSeedIds,
  entityCount,
  parseClusterParam,
  toClusterList,
  topTypes,
} from '../../../../components/graph/overview/overviewModel';
import type { GraphOverview } from '../../../../services/graph';
import { BRAND_TOKENS } from '../../../../theme/tokens';
import { ACME_ID, BEACON_ID, INITECH_ID, JOE_ID, gid, overviewFixture } from '../../../mocks/graphData';

/**
 * The overview's pure model (#375). Everything the page draws is decided here,
 * so it is tested without a WebGL context.
 */

const light = createTheme({ palette: { mode: 'light', primary: { main: BRAND_TOKENS.light.primary.main } } });
const dark = createTheme({ palette: { mode: 'dark', primary: { main: BRAND_TOKENS.dark.primary.main } } });

describe('clusterColor', () => {
  it('is deterministic, cycles through twelve colours, and greys out Unconnected', () => {
    const palette = clusterPalette(light);
    expect(palette).toHaveLength(12);
    expect(new Set(palette).size).toBe(12);
    expect(clusterColor(0, light)).toBe(palette[0]);
    expect(clusterColor(5, light)).toBe(clusterColor(5, light));
    expect(clusterColor(12, light)).toBe(palette[0]);
    expect(clusterColor(13, light)).toBe(palette[1]);
    expect(clusterColor(-1, light)).toBe(light.palette.text.disabled);
  });

  it('has twelve distinct colours in dark mode too, from the dark tokens', () => {
    const palette = clusterPalette(dark);
    expect(new Set(palette).size).toBe(12);
    expect(palette[0]).toBe(BRAND_TOKENS.dark.primary.main);
    expect(palette).not.toEqual(clusterPalette(light));
    expect(clusterColor(-1, dark)).toBe(dark.palette.text.disabled);
  });
});

describe('buildClusterGraph', () => {
  it('draws one node per cluster at its snapshot position, labelled with its size', () => {
    const o = overviewFixture();
    const graph = buildClusterGraph(o, light);
    expect(graph.order).toBe(o.clusters.length);
    const acme = graph.getNodeAttributes(clusterNodeKey(0));
    expect(acme).toMatchObject({ x: -385, y: 125, label: 'Acme Corp (6)', clusterId: 0, color: clusterColor(0, light) });
    // The largest radius gets the largest size; smaller ones scale down.
    expect(acme.size).toBe(30);
    expect(graph.getNodeAttribute(clusterNodeKey(-1), 'size')).toBeLessThan(acme.size);
    expect(graph.getNodeAttribute(clusterNodeKey(-1), 'color')).toBe(light.palette.text.disabled);
    // No `type` attribute on a node: sigma would read it as a program name.
    expect(acme).not.toHaveProperty('type');
  });

  it('adds one undirected line per cluster edge, width growing with log(weight)', () => {
    const graph = buildClusterGraph(overviewFixture(), light);
    expect(graph.size).toBe(2);
    const heavy = graph.getEdgeAttributes(graph.edge(clusterNodeKey(0), clusterNodeKey(1))!);
    const light1 = graph.getEdgeAttributes(graph.edge(clusterNodeKey(2), clusterNodeKey(0))!);
    expect(heavy.type).toBe('line');
    expect(heavy.size).toBeGreaterThan(light1.size);
    expect(light1.size).toBe(1);
  });

  it('skips self-loops, duplicates and edges to unknown clusters', () => {
    const o = overviewFixture({
      clusterEdges: [
        { a: 0, b: 0, weight: 5 },
        { a: 0, b: 1, weight: 2 },
        { a: 1, b: 0, weight: 2 },
        { a: 0, b: 99, weight: 2 },
      ],
    });
    expect(buildClusterGraph(o, light).size).toBe(1);
  });

  it('is identical for the same snapshot', () => {
    const a = buildClusterGraph(overviewFixture(), light).export();
    const b = buildClusterGraph(overviewFixture(), light).export();
    expect(a).toEqual(b);
  });
});

describe('buildNodeGraph', () => {
  it('positions every node, coloured by cluster, sized by degree, with no edges', () => {
    const o = overviewFixture();
    const graph = buildNodeGraph(o, dark);
    expect(graph.order).toBe(o.nodes.length);
    expect(graph.size).toBe(0);
    const joe = graph.getNodeAttributes(JOE_ID);
    expect(joe).toMatchObject({ x: -330, y: 60, label: 'Joe Rivera', clusterId: 0, entityType: 'Person' });
    expect(joe.color).toBe(clusterColor(0, dark));
    expect(joe.size).toBeCloseTo(2 + Math.log2(6), 2);
    expect(graph.getNodeAttribute(gid(20), 'size')).toBe(2);
    expect(joe).not.toHaveProperty('type');
  });
});

describe('applyClusterFocus', () => {
  it('dims every node outside the cluster and restores them on null', () => {
    const graph = buildNodeGraph(overviewFixture(), light);
    applyClusterFocus(graph, 1, '#999999');
    expect(graph.getNodeAttribute(JOE_ID, 'color')).toBe('#999999');
    expect(graph.getNodeAttribute(JOE_ID, 'label')).toBe('');
    expect(graph.getNodeAttribute(gid(2), 'color')).toBe(clusterColor(1, light));
    expect(graph.getNodeAttribute(gid(2), 'zIndex')).toBe(1);

    applyClusterFocus(graph, null, '#999999');
    expect(graph.getNodeAttribute(JOE_ID, 'color')).toBe(clusterColor(0, light));
    expect(graph.getNodeAttribute(JOE_ID, 'label')).toBe('Joe Rivera');
    expect(graph.getNodeAttribute(gid(2), 'zIndex')).toBe(0);
  });
});

describe('clusterSeedIds + clusterHandoff', () => {
  it('orders members by degree, then label', () => {
    // Acme and Joe both have degree 5: label breaks the tie.
    expect(clusterSeedIds(overviewFixture(), 0)).toEqual([
      ACME_ID,
      JOE_ID,
      gid(6), // Project Atlas (3)
      gid(3), // Ben Okafor (2)
      gid(7), // Q3 planning (2)
      gid(12), // Dana Li (1)
    ]);
  });

  it('caps at max (50 by default)', () => {
    const nodes = Array.from({ length: 80 }, (_, i) => ({
      id: gid(1000 + i),
      label: `P${String(i).padStart(2, '0')}`,
      type: 'Person',
      x: i,
      y: -i,
      clusterId: 7,
      degree: i,
    }));
    const o = overviewFixture({ nodes, clusters: [] });
    const ids = clusterSeedIds(o, 7);
    expect(ids).toHaveLength(OVERVIEW_DRILL_DOWN_MAX);
    expect(ids[0]).toBe(gid(1079));
    expect(clusterSeedIds(o, 7, 3)).toEqual([gid(1079), gid(1078), gid(1077)]);
  });

  it('falls back to the member sample when the truncated nodes position none of the cluster', () => {
    const o = overviewFixture();
    const trimmed: GraphOverview = { ...o, nodes: o.nodes.filter((n) => n.clusterId !== 2), nodesTruncated: true };
    expect(clusterSeedIds(trimmed, 2)).toEqual([INITECH_ID, BEACON_ID]);
  });

  it('hands over the seeds at their overview positions, with the cluster label as title', () => {
    const handoff = clusterHandoff(overviewFixture(), 1);
    expect(handoff.title).toBe('Globex');
    expect(handoff.seedIds).toHaveLength(4);
    expect(handoff.nodes).toContainEqual({ id: gid(5), label: 'Globex', type: 'Organization', x: 380, y: -150, degree: 3 });
    expect(handoff.nodes.map((n) => n.id)).toEqual(handoff.seedIds);
  });

  it('rings unpositioned sample members around the cluster centroid', () => {
    const o = overviewFixture();
    const trimmed: GraphOverview = { ...o, nodes: o.nodes.filter((n) => n.clusterId !== 2) };
    const handoff = clusterHandoff(trimmed, 2);
    expect(handoff.nodes).toHaveLength(2);
    for (const node of handoff.nodes) {
      expect(Math.hypot(node.x - 180, node.y - 445)).toBeCloseTo(80, 0);
    }
    expect(clusterHandoff(trimmed, 2)).toEqual(handoff);
  });

  it('returns an empty hand-off for an unknown cluster', () => {
    expect(clusterHandoff(overviewFixture(), 42)).toEqual({ seedIds: [], title: undefined, nodes: [] });
  });
});

describe('toClusterList + keyboard order', () => {
  it('sorts by size, largest first, with Unconnected last', () => {
    const o = overviewFixture({
      clusters: [
        ...overviewFixture().clusters,
        { id: 3, label: 'Big', labelEntityId: null, size: 50, x: 0, y: 0, radius: 141, typeCounts: {}, memberSample: [] },
        { id: 4, label: 'Tie', labelEntityId: null, size: 4, x: 0, y: 0, radius: 40, typeCounts: {}, memberSample: [] },
      ],
    });
    const list = toClusterList(o);
    expect(list.map((row) => row.label)).toEqual(['Big', 'Acme Corp', 'Globex', 'Tie', 'Cluster 3', 'Unconnected']);
    expect(clusterKeyboardOrder(o)).toEqual([3, 0, 1, 4, 2, -1]);
  });

  it('carries top types, sample labels and member links', () => {
    const [acme] = toClusterList(overviewFixture());
    expect(acme.topTypes).toEqual(['Person', 'Meeting', 'Organization']);
    expect(acme.sample[0]).toBe('Acme Corp');
    expect(acme.members[1]).toEqual({ id: JOE_ID, label: 'Joe Rivera', type: 'Person' });
    expect(acme.labelEntityId).toBe(ACME_ID);
  });

  it('topTypes drops empty counts', () => {
    expect(topTypes({ Person: 0, Project: 2 })).toEqual(['Project']);
  });
});

describe('small helpers', () => {
  it('announces and counts', () => {
    expect(clusterAnnouncement({ label: 'Acme', size: 42 })).toBe('Cluster Acme, 42 entities');
    expect(entityCount(1)).toBe('1 entity');
    expect(entityCount(6200)).toBe('6,200 entities');
  });

  it('accepts only a cluster id present in this snapshot', () => {
    const o = overviewFixture();
    expect(parseClusterParam('1', o)).toBe(1);
    expect(parseClusterParam('-1', o)).toBe(-1);
    expect(parseClusterParam('9', o)).toBeNull();
    expect(parseClusterParam('abc', o)).toBeNull();
    expect(parseClusterParam(null, o)).toBeNull();
    expect(parseClusterParam('1', null)).toBeNull();
  });
});
