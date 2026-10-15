/**
 * this app's settings-hub feature keys (issue #466, epic #462).
 *
 * `useSettingsFeatures()` answers from the registry, so a key that is not
 * registered is "off" and every card gated on it is hidden. this app registers the
 * two keys its registries can name: `graph` (connected knowledge,
 * `ai.graphEnabled`) and `orgs` (the identity slice's multi-organization cards,
 * which this app does not spread).
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  registeredSettingsFeatures,
  useSettingsFeatures,
} from '@marinoscar/platform-web/settings/headless';
import '../../config/settingsFeatures';

const navigationFeatures = vi.hoisted(() => ({ graph: false }));
vi.mock('../../contexts/NavigationFeaturesContext', () => ({
  useNavigationFeatures: () => ({ features: navigationFeatures, refresh: async () => {} }),
}));

describe('settingsFeatures', () => {
  it('registers the graph and orgs keys', () => {
    expect(registeredSettingsFeatures()).toEqual(expect.arrayContaining(['graph', 'orgs']));
  });

  it('reads graph from the navigation features the shell already fetched', () => {
    navigationFeatures.graph = true;
    const { result } = renderHook(() => useSettingsFeatures());
    expect(result.current.graph).toBe(true);
    navigationFeatures.graph = false;
  });

  it('fails closed: graph is off until the shell says otherwise, and orgs is off without a session', () => {
    const { result } = renderHook(() => useSettingsFeatures());
    expect(result.current.graph).toBe(false);
    expect(result.current.orgs).toBe(false);
  });
});
