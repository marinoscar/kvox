/**
 * `useUserSettings` with the one-retry-on-409 this app had before #466.
 *
 * PLATFORM-ADOPTION-SHIM(upstream platform hook): the packaged
 * `useUserSettings` (`@marinoscar/platform-web/settings/headless`) refetches on
 * a 409 `If-Match` conflict and then THROWS "Settings were updated elsewhere.
 * Please try again." this app's own hook re-read the document and re-applied the
 * SAME patch once (#276, epic #271). That retry is load-bearing here: the
 * navigation rail (the packaged `useShellRailPreference` since #484, which does NOT
 * retry), the platform onboarding provider (a write of its own,
 * `PATCH /api/user-settings`) and the graph preferences
 * (`useGraphPreferences`) each hold their OWN copy of
 * the user-settings document, so one of them writing bumps the version under
 * the others and their next write 409s through no fault of the user. Without
 * the retry that surfaces as a "please try again" for a conflict the hook could
 * have resolved.
 *
 * The fix belongs in the platform hook; delete this file when it retries. Until
 * then the app callers above import `useUserSettings` from here, and the
 * packaged pages (Profile, Appearance, the section chrome) keep the packaged
 * behaviour untouched.
 *
 * HOW. The packaged hook swallows the status: on a conflict it refetches and
 * throws a plain `Error` (not an `ApiError`), whose closure still holds the
 * stale version, so the retry cannot be re-issued through it. The wrapper
 * therefore recognises that conflict error by its message
 * (`PACKAGED_CONFLICT_MESSAGE`, pinned against the real packaged hook in
 * `__tests__/hooks/userSettingsRetry.test.tsx`, so a package change fails a test
 * instead of silently dropping the retry), reads the fresh document itself,
 * PATCHes the same body once with the fresh `version` as `If-Match`, and adopts
 * the response through the hook's `replaceSettings`. A second 409 throws the
 * packaged message again; any other error is rethrown untouched; a non-conflict
 * first failure is never retried.
 */

import { useCallback, useRef } from 'react';
import { isPlatformApiError, useOptionalPlatformHost } from '@marinoscar/platform-web/core';
import { useUserSettings as usePackagedUserSettings } from '@marinoscar/platform-web/settings/headless';
import type {
  UseUserSettingsOptions,
  UseUserSettingsResult,
  UserSettingsDocument,
  UserSettingsUpdateBase,
} from '@marinoscar/platform-web/settings/headless';

/** What the packaged hook throws after refetching on a 409. */
export const PACKAGED_CONFLICT_MESSAGE = 'Settings were updated elsewhere. Please try again.';

export function useUserSettings<
  T extends UserSettingsDocument,
  U extends UserSettingsUpdateBase = Partial<T>,
>(options: UseUserSettingsOptions = {}): UseUserSettingsResult<T, U> {
  const host = useOptionalPlatformHost();
  const api = options.api ?? host?.api;
  const { syncTheme = true, applyTheme } = options;
  const base = usePackagedUserSettings<T, U>(options);

  // The patch is re-issued from the render the conflict happened in, so the
  // latest `replaceSettings` is read through a ref.
  const replaceRef = useRef(base.replaceSettings);
  replaceRef.current = base.replaceSettings;
  const baseUpdate = base.updateSettings;

  const updateSettings = useCallback(
    async (updates: U) => {
      try {
        await baseUpdate(updates);
      } catch (err) {
        const conflict = err instanceof Error && err.message === PACKAGED_CONFLICT_MESSAGE;
        if (!conflict || !api) throw err;

        try {
          const fresh = await api.get<T>('/user-settings');
          const saved = await api.patch<T>('/user-settings', updates, {
            ifMatch: String(fresh.version),
          });
          replaceRef.current(saved);
          if (syncTheme && applyTheme && updates.theme) applyTheme(updates.theme);
        } catch (retryErr) {
          if (isPlatformApiError(retryErr) && retryErr.status === 409) {
            throw new Error(PACKAGED_CONFLICT_MESSAGE);
          }
          throw retryErr;
        }
      }
    },
    [baseUpdate, api, syncTheme, applyTheme],
  );

  const updateTheme = useCallback(
    (theme: T['theme']) => updateSettings({ theme } as unknown as U),
    [updateSettings],
  );
  const updateProfile = useCallback(
    (profile: T['profile']) => updateSettings({ profile } as unknown as U),
    [updateSettings],
  );

  return { ...base, updateSettings, updateTheme, updateProfile };
}
