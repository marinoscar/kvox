/**
 * This app's mount of the connected-knowledge switch (issue #484, epic #478).
 *
 * `GET /api/ai-tasks/config` carries `graphEnabled`, the deployment switch for
 * connected knowledge. Everything that draws or hides a knowledge surface reads
 * ONE answer to it, through the `graph` settings feature
 * (`config/settingsFeatures.ts`): the packaged shell's rail, bottom bar and user
 * menu (a destination's `feature: 'graph'`), the AppBar's title resolver, and the
 * hub cards that declare it.
 *
 * A settings-feature resolver is a hook that must never fetch, so the read lives
 * here, in a provider, and the resolver only reads the context. The provider sits
 * ABOVE `AppPlatformHostProvider` (the host's `viewer.isFeatureEnabled` reads the
 * feature map) and so above the login page, where nobody is signed in and the
 * endpoint would answer 401: it does not read until the session is authenticated
 * and answers "off" again after sign-out. Same shape as `AiConfigBinding.tsx`.
 *
 * UNKNOWN IS OFF. While the config is loading, after a failed load (including the
 * 403 a caller without `notes:read` gets) and outside any provider, the feature
 * reads `false`. A gated row that appeared on an optimistic default and then
 * vanished once the read landed would be worse than one that appears a beat late.
 *
 * `refresh` lets the admin AI settings page re-read after it flips the switch, so
 * the tab follows the save without a reload.
 */

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@marinoscar/platform-web/identity/headless';
import { useAiTasksConfig } from '../hooks/useAiTasksConfig';

export interface GraphFeatureValue {
  /** Connected knowledge is on for this deployment. `false` while unknown. */
  graph: boolean;
  /** Re-read the switch (after the admin changes it). */
  refresh: () => Promise<void>;
}

const noop = async () => {};

const GraphFeatureContext = createContext<GraphFeatureValue>({ graph: false, refresh: noop });

export function AppGraphFeatureProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const { config, refresh } = useAiTasksConfig({ skip: !isAuthenticated });
  const graph = isAuthenticated && config?.graphEnabled === true;

  // `refresh` is the hook's memoized fetcher, so this value only changes when the
  // answer does: the consumers do not re-render per fetch.
  const value = useMemo<GraphFeatureValue>(
    () => ({ graph, refresh: isAuthenticated ? refresh : noop }),
    [graph, refresh, isAuthenticated],
  );

  return <GraphFeatureContext.Provider value={value}>{children}</GraphFeatureContext.Provider>;
}

/** The connected-knowledge switch. Outside a provider it is off. */
export function useGraphFeature(): GraphFeatureValue {
  return useContext(GraphFeatureContext);
}
