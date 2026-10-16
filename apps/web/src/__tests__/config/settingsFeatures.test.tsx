/**
 * this app's settings-hub feature keys (issue #466, epic #462).
 *
 * `useSettingsFeatures()` answers from the registry, so a key that is not
 * registered is "off" and every card gated on it is hidden. this app registers the
 * keys its registries can name: `ai` (the platform's AI switch, issue #477: the
 * AI models, AI usage and AI Provider cards), `graph` (connected knowledge,
 * `ai.graphEnabled`), `orgs` (the identity slice's multi-organization cards,
 * which this app does not spread) and `telemetry`.
 */

import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  registeredSettingsFeatures,
  useSettingsFeatures,
} from '@marinoscar/platform-web/settings/headless';
import { AI_CONFIG_DISABLED, AiConfigContext } from '@marinoscar/platform-web/ai/headless';
import '../../config/settingsFeatures';

const navigationFeatures = vi.hoisted(() => ({ graph: false }));
vi.mock('../../contexts/NavigationFeaturesContext', () => ({
  useNavigationFeatures: () => ({ features: navigationFeatures, refresh: async () => {} }),
}));

describe('settingsFeatures', () => {
  it('registers the ai, graph and orgs keys', () => {
    expect(registeredSettingsFeatures()).toEqual(expect.arrayContaining(['ai', 'graph', 'orgs']));
  });

  it('reads ai from the shell-wide platform AI config, never fetching', () => {
    const wrapper = (enabled: boolean) =>
      function Wrapper({ children }: { children: ReactNode }) {
        return (
          <AiConfigContext.Provider
            value={{
              config: { ...AI_CONFIG_DISABLED, enabled },
              isLoading: false,
              error: null,
              refresh: async () => {},
            }}
          >
            {children}
          </AiConfigContext.Provider>
        );
      };

    expect(renderHook(() => useSettingsFeatures(), { wrapper: wrapper(true) }).result.current.ai).toBe(
      true,
    );
    expect(renderHook(() => useSettingsFeatures(), { wrapper: wrapper(false) }).result.current.ai).toBe(
      false,
    );
  });

  it('reads graph from the navigation features the shell already fetched', () => {
    navigationFeatures.graph = true;
    const { result } = renderHook(() => useSettingsFeatures());
    expect(result.current.graph).toBe(true);
    navigationFeatures.graph = false;
  });

  it('fails closed: ai and graph are off until the shell says otherwise, and orgs is off without a session', () => {
    const { result } = renderHook(() => useSettingsFeatures());
    expect(result.current.ai).toBe(false);
    expect(result.current.graph).toBe(false);
    expect(result.current.orgs).toBe(false);
  });
});
