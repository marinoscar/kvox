/**
 * This app's mount of the platform AI config (issue #477, epic #472).
 *
 * `GET /api/ai/config` answers "is AI switched on, and which providers" to any
 * signed-in user. Four things read that one answer: the `ai` settings feature
 * (the AI models, AI usage and AI Provider cards in `config/adminSections.tsx`
 * and `config/userSettingsSections.tsx` exist only while it is on, through
 * `config/settingsFeatures.ts`), `RequireAiEnabled` on their routes, the packaged
 * AI pages, and the admin AI page, which refreshes it after the switch is saved.
 *
 * The package's `AiConfigProvider` fetches the moment it mounts. It has to sit
 * ABOVE `AppPlatformHostProvider` (the host reads the feature it answers), which
 * is above the router and therefore above the login page, where nobody is signed
 * in and the endpoint would answer 401. So this binding is the same provider with
 * one difference: it does not fetch until the session is authenticated, and it
 * answers "off" again after sign-out. It is built from the package's own
 * `AiConfigContext` and its query hook, so every consumer (the package's config
 * hook, `useAiFeatures`, `RequireAiEnabled`) reads it unchanged. Same shape as
 * `TelemetryConfigBinding.tsx`.
 *
 * ONE RACE IS CLOSED HERE. The query hook with `skip` set starts at
 * `isLoading: false` when it mounts skipped, and flips to loading only inside the
 * effect that follows the render in which the session became authenticated. A
 * deep link to the AI models page would render `RequireAiEnabled` in that gap,
 * see "off, not loading", and redirect to `/`. So while the session is
 * authenticated and the first answer (or the first failure) has not landed, this
 * binding reports `isLoading: true` itself.
 *
 * This is the PLATFORM's answer. The app's own `useAiTasksConfig` (the caller's
 * key, the permitted models, connected knowledge) reads a different endpoint and
 * drives different surfaces.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@marinoscar/platform-web/identity/headless';
import {
  AI_CONFIG_DISABLED,
  AiConfigContext,
  useAiConfigQuery,
} from '@marinoscar/platform-web/ai/headless';
import type { UseAiConfigReturn } from '@marinoscar/platform-web/ai/headless';
import { appPlatformApi } from './platformHost';

const SIGNED_OUT: UseAiConfigReturn = {
  config: AI_CONFIG_DISABLED,
  isLoading: false,
  error: null,
  refresh: async () => {},
};

export function AppAiConfigProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const query = useAiConfigQuery({ skip: !isAuthenticated, api: appPlatformApi });

  const settled = query.config !== AI_CONFIG_DISABLED || query.error !== null;
  const value = useMemo<UseAiConfigReturn>(
    () =>
      isAuthenticated ? { ...query, isLoading: query.isLoading || !settled } : SIGNED_OUT,
    [isAuthenticated, query, settled],
  );

  return <AiConfigContext.Provider value={value}>{children}</AiConfigContext.Provider>;
}
