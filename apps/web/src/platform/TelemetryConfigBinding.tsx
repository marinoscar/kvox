/**
 * This app's mount of the telemetry feature flag (issue #471, epic #467).
 *
 * `GET /api/telemetry/config` answers "is a telemetry store deployed AND is
 * collection switched on" to any signed-in user. Three things read that one
 * answer: the `telemetry` settings feature (the Explorer and Dashboard cards in
 * `config/adminSections.tsx` exist only while it is on, through
 * `config/settingsFeatures.ts`), `RequireTelemetryEnabled` on the two query
 * routes, and the Telemetry settings page, which refreshes it after a save.
 *
 * The package's `TelemetryConfigProvider` fetches the moment it mounts. It has
 * to sit ABOVE `AppPlatformHostProvider` (the host reads the feature it
 * answers), which is above the router and therefore above the login page, where
 * nobody is signed in and the endpoint would answer 401. So this binding is the
 * same provider with one difference: it does not fetch until the session is
 * authenticated, and it answers "off" again after sign-out. It is built from the
 * package's own `TelemetryConfigContext` and `useTelemetryConfigQuery`, so every
 * consumer (`useTelemetryConfig`, `useTelemetryFeatures`) reads it unchanged.
 *
 * ONE RACE IS CLOSED HERE. `useTelemetryConfigQuery({ skip })` starts at
 * `isLoading: false` when it mounts skipped, and flips to loading only inside
 * the effect that follows the render in which the session became
 * authenticated. A deep link to the Explorer would render
 * `RequireTelemetryEnabled` in that gap, see "off, not loading", and redirect to
 * `/`. So while the session is authenticated and the first answer (or the first
 * failure) has not landed, this binding reports `isLoading: true` itself.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@marinoscar/platform-web/identity/headless';
import {
  TELEMETRY_CONFIG_DISABLED,
  TelemetryConfigContext,
  useTelemetryConfigQuery,
} from '@marinoscar/platform-web/telemetry/headless';
import type { UseTelemetryConfigReturn } from '@marinoscar/platform-web/telemetry/headless';
import { appPlatformApi } from './platformHost';

const SIGNED_OUT: UseTelemetryConfigReturn = {
  config: TELEMETRY_CONFIG_DISABLED,
  isLoading: false,
  error: null,
  refresh: async () => {},
};

export function AppTelemetryConfigProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const query = useTelemetryConfigQuery({ skip: !isAuthenticated, api: appPlatformApi });

  const settled = query.config !== TELEMETRY_CONFIG_DISABLED || query.error !== null;
  const value = useMemo<UseTelemetryConfigReturn>(
    () =>
      isAuthenticated
        ? { ...query, isLoading: query.isLoading || !settled }
        : SIGNED_OUT,
    [isAuthenticated, query, settled],
  );

  return <TelemetryConfigContext.Provider value={value}>{children}</TelemetryConfigContext.Provider>;
}
