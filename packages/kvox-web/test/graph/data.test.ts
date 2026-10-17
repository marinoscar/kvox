import { describe, it, expect } from 'vitest';

import {
  kvoxGraphDestinationRoutes,
  kvoxGraphDestinations,
  kvoxGraphRoutes,
  kvoxGraphUserSettingsSections,
} from '../../src/graph/ui/index.js';

/**
 * The data the app spreads into its registries. The app keeps the registry
 * tests (`destinations.test.ts`, `knowledgeGraphCard.test.ts`); this pins what
 * the slice itself declares, so a change here is seen where it is made.
 */

describe('kvoxGraphDestinations', () => {
  it('is the knowledge destination, gated on graph:read AND the graph feature', () => {
    expect(kvoxGraphDestinations).toHaveLength(1);
    const [destination] = kvoxGraphDestinations;
    expect(destination).toMatchObject({
      key: 'knowledge',
      label: 'Knowledge',
      compactLabel: 'Knowledge',
      path: '/graph',
      permission: 'graph:read',
      feature: 'graph',
    });
    // A bottom-bar tab: four non-pinned destinations is the ceiling.
    expect(destination?.pinned).toBeFalsy();
  });

  it('owns /graph and /ask: the ask slice adds routes, not a destination', () => {
    expect(kvoxGraphDestinationRoutes).toEqual({ knowledge: ['/graph', '/ask'] });
  });
});

describe('kvoxGraphRoutes', () => {
  it('declares the five graph routes and the settings route, with the exact gates', () => {
    expect(
      kvoxGraphRoutes.map(({ path, permission, redirectTo }) => ({ path, permission, redirectTo })),
    ).toEqual([
      { path: '/graph', permission: 'graph:read', redirectTo: undefined },
      { path: '/graph/entities/:id', permission: 'graph:read', redirectTo: undefined },
      { path: '/graph/explore', permission: 'graph:read', redirectTo: undefined },
      { path: '/graph/overview', permission: 'graph:read', redirectTo: undefined },
      { path: '/graph/imports/:proposalId', permission: 'graph:write', redirectTo: '/graph' },
      { path: '/settings/knowledge-graph', permission: 'graph:write', redirectTo: '/settings' },
    ]);
  });
});

describe('kvoxGraphUserSettingsSections', () => {
  it('has one Knowledge graph card gated on graph:write, at the settings route', () => {
    expect(kvoxGraphUserSettingsSections.knowledge).toHaveLength(1);
    expect(kvoxGraphUserSettingsSections.knowledge[0]).toMatchObject({
      title: 'Knowledge graph',
      path: '/settings/knowledge-graph',
      permission: 'graph:write',
    });
  });
});
