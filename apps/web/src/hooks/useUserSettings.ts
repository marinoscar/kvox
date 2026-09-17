import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../services/api';
import { UserSettings, UserSettingsUpdate } from '../types';
import { useThemeContext } from '../contexts/ThemeContext';
import { useIsMounted } from './useIsMounted';

interface UseUserSettingsOptions {
  /**
   * Whether loading/saving settings should push the theme into ThemeContext.
   * Defaults to `true`, which is what the settings page wants.
   *
   * Pass `false` when mounting this hook from always-present chrome (AppBar,
   * navigation rail, layout shells). There, syncing would make the STORED
   * theme authoritative on every page load: the moment the user flips the
   * AppBar's light/dark toggle, any refetch — or simply navigating to a route
   * that remounts the chrome — calls setMode() with the persisted value and
   * stamps the toggle right back. Do not "simplify" this option away.
   */
  syncTheme?: boolean;
}

interface UseUserSettingsReturn {
  settings: UserSettings | null;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  updateSettings: (updates: UserSettingsUpdate) => Promise<void>;
  updateTheme: (theme: 'light' | 'dark' | 'system') => Promise<void>;
  updateProfile: (profile: UserSettings['profile']) => Promise<void>;
  refresh: () => Promise<void>;
  /**
   * Adopt a settings document another endpoint already returned (e.g. the
   * profile-image upload/delete responses), including its `version`, so the
   * next PATCH sends the current `If-Match` instead of a stale one and 409s.
   */
  replaceSettings: (next: UserSettings) => void;
}

export function useUserSettings(options: UseUserSettingsOptions = {}): UseUserSettingsReturn {
  const { syncTheme = true } = options;
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { setMode } = useThemeContext();
  // Every `setState` past an `await` is guarded: a request that settles after
  // the component is gone must not schedule an update on it. `setMode` is
  // included — it writes ThemeContext state and is just as unsafe once the
  // tree is gone. Only the state write is skipped; what these functions
  // return or throw is unchanged.
  const isMounted = useIsMounted();

  /**
   * Read the settings document and adopt it, WITHOUT touching `isLoading`.
   *
   * Split out of `fetchSettings` for the 409 retry below, and the split is the
   * point: `isLoading` is what `UserSettingsSection` renders a full-page
   * spinner on, so a refetch performed in the middle of a save would blank the
   * page the user is still looking at and then bring it back. A conflict
   * recovery must be invisible.
   *
   * RETURNS the document rather than only storing it, because `setSettings` is
   * asynchronous and the caller cannot read the new `version` back out of state
   * within the same tick — which is exactly the trap the retry exists to avoid.
   */
  const readSettings = useCallback(async (): Promise<UserSettings | null> => {
    const data = await api.get<UserSettings>('/user-settings');
    if (isMounted()) {
      setSettings(data);
      // Sync theme with settings (opt-out via syncTheme: false)
      if (syncTheme) {
        setMode(data.theme);
      }
    }
    return data;
  }, [setMode, syncTheme, isMounted]);

  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      await readSettings();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to load settings';
      if (isMounted()) setError(message);
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [readSettings, isMounted]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const updateSettings = useCallback(
    async (updates: UserSettingsUpdate) => {
      if (!settings) return;

      try {
        setIsSaving(true);
        setError(null);

        const data = await api.patch<UserSettings>('/user-settings', updates, {
          headers: {
            'If-Match': settings.version.toString(),
          },
        });

        if (isMounted()) {
          setSettings(data);

          // Sync theme if changed (opt-out via syncTheme: false)
          if (syncTheme && updates.theme) {
            setMode(updates.theme);
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // ---------------------------------------------------------------
          // VERSION CONFLICT: RE-READ, THEN RETRY ONCE WITH THE FRESH VERSION
          // ---------------------------------------------------------------
          //
          // This used to re-read and then throw "please try again", which put
          // the recovery on the user for a conflict the hook could resolve
          // itself. The re-read alone is not a retry: `updateSettings` closes
          // over `settings.version` from the render that created it, so a
          // caller retrying immediately would resend the SAME `If-Match` and
          // 409 again — the stale value is captured in the closure, not read
          // at call time. That is why the retry has to happen in here, against
          // the version `readSettings` just returned.
          //
          // ⚠ RETRYING IS SAFE BECAUSE THE BODY IS A MERGE PATCH, NOT A
          // REPLACEMENT. `updates` states only the fields this caller changed,
          // so re-applying them on top of whatever landed in between is the
          // correct resolution rather than a clobber: the other writer's
          // untouched fields survive. A PUT could not be retried this way, and
          // `replaceSettings` deliberately remains the path for callers that
          // already hold a fresh document.
          //
          // ONCE, NOT IN A LOOP. A second conflict means something is writing
          // continuously, and a hook that kept retrying would hide that from
          // the user forever instead of letting them see it.
          try {
            const fresh = await readSettings();

            if (fresh) {
              const data = await api.patch<UserSettings>('/user-settings', updates, {
                headers: { 'If-Match': fresh.version.toString() },
              });

              if (isMounted()) {
                setSettings(data);
                if (syncTheme && updates.theme) {
                  setMode(updates.theme);
                }
              }

              return;
            }
          } catch (retryErr) {
            // Fall through to the shared message below. A failed recovery is
            // reported as the conflict it started as, not as whatever the
            // second attempt happened to fail with.
            if (!(retryErr instanceof ApiError)) throw retryErr;
          }

          throw new Error('Settings were updated elsewhere. Please try again.');
        }
        const message = err instanceof ApiError ? err.message : 'Failed to save settings';
        if (isMounted()) setError(message);
        throw err;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [settings, setMode, syncTheme, readSettings, isMounted],
  );

  const updateTheme = useCallback(
    async (theme: 'light' | 'dark' | 'system') => {
      await updateSettings({ theme });
    },
    [updateSettings],
  );

  const updateProfile = useCallback(
    async (profile: UserSettings['profile']) => {
      await updateSettings({ profile });
    },
    [updateSettings],
  );

  return {
    settings,
    isLoading,
    error,
    isSaving,
    updateSettings,
    updateTheme,
    updateProfile,
    refresh: fetchSettings,
    replaceSettings: setSettings,
  };
}
