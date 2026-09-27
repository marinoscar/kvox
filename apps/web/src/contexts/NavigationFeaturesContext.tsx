/**
 * Which runtime features the navigation chrome may draw — ONE read per shell.
 *
 * Issue #438. The `knowledge` destination is gated on `ai.graphEnabled` as well
 * as on `graph:read` (`config/destinations.ts`, `requiresFeature`), and four
 * surfaces ask that question on every page: the bottom bar, the rail, the
 * avatar menu and the top bar's title resolver. Calling `useAiConfig()` in each
 * would issue `GET /api/ai/config` four times per shell mount, and give four
 * components four chances to disagree about whether the tab exists.
 *
 * So `Layout` mounts this provider ONCE around the whole shell — the same shape
 * `OnboardingProvider` takes there — and it reads the flag through the existing
 * `useAiConfig()` hook rather than a second fetcher. Every surface reads
 * `useNavigationFeatures()`.
 *
 * UNKNOWN IS OFF. While the config is loading, after a failed load (including
 * the 403 a caller without `notes:read` gets from `GET /api/ai/config`), and
 * outside any provider at all, every feature reads `false`. A gated row that
 * appeared on an optimistic default and then vanished once the read landed
 * would be worse than one that appears a beat late.
 *
 * `refresh` lets the admin AI settings page re-read after it flips the switch,
 * so the tab follows the save without a reload.
 */

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

import { NO_DESTINATION_FEATURES } from '../config/destinations';
import type { DestinationFeatures } from '../config/destinations';
import { useAiConfig } from '../hooks/useAiConfig';

export interface NavigationFeaturesValue {
  features: DestinationFeatures;
  refresh: () => Promise<void>;
}

const noop = async () => {};

const NavigationFeaturesContext = createContext<NavigationFeaturesValue>({
  features: NO_DESTINATION_FEATURES,
  refresh: noop,
});

export function NavigationFeaturesProvider({ children }: { children: ReactNode }) {
  const { config, refresh } = useAiConfig();
  const graph = config?.graphEnabled === true;

  // `refresh` is `useAiConfig`'s memoized fetcher, so this value only changes
  // when the answer does — the four consumers do not re-render per fetch.
  const value = useMemo<NavigationFeaturesValue>(
    () => ({ features: { graph }, refresh }),
    [graph, refresh],
  );

  return (
    <NavigationFeaturesContext.Provider value={value}>{children}</NavigationFeaturesContext.Provider>
  );
}

/**
 * The runtime features the navigation may draw. Outside a provider every
 * feature is off — the safe answer, and what a surface rendered alone in a
 * test sees.
 */
export function useNavigationFeatures(): NavigationFeaturesValue {
  return useContext(NavigationFeaturesContext);
}
