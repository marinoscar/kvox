/**
 * Settings → Notifications (`/settings/notifications`).
 *
 * Issue #126, epic #109. The per-user half of the notification framework: a
 * matrix of event x channel, driven by the server's registry
 * (`GET /api/notifications/events`) so an event added to
 * `apps/api/src/notifications/notification-events.ts` later appears here with
 * NO change to this page — which is epic #109's headline promise that a
 * notification costs one registry entry.
 *
 * THIN, like `UserAppearancePage`: every line of shared page chrome (the
 * settings fetch, the loading spinner, the fetch-error alert, the
 * success/failure snackbars) lives in `UserSettingsSection`, and the matrix
 * itself lives in `components/settings/NotificationSettings.tsx`. What is left
 * here is the wiring, and one decision — the exact shape of the write.
 *
 * =============================================================================
 * THE WRITE: ONE CHANNEL, ONE EVENT KEY, NOTHING ELSE
 * =============================================================================
 *
 * `onToggle` below is the ONLY place this feature writes preferences, and it
 * sends a document with exactly one channel and exactly one event key in it:
 *
 *     { notifications: { email: { 'user.welcome': false } } }   // store a choice
 *     { notifications: { email: { 'user.welcome': null  } } }   // DELETE the key
 *
 * The API deep-merges the channel object per event key (see
 * `mergeNotifications` in `UserSettingsService`, and
 * `notificationsPatchSchema`), so every preference this request does not name
 * stays exactly as it was — including staying ABSENT, which is the state that
 * resolves to the registry default.
 *
 * There is no other write path. Nothing PATCHes on mount, nothing serialises a
 * preferences object, and there is no Save button to batch one up: a batched
 * save needs a full local mirror to diff, and that mirror — defaulted, because
 * it has to be defaulted to render — is precisely the materialised blob the
 * sparse contract exists to avoid. See the header of `NotificationSettings.tsx`
 * for the full argument.
 *
 * `value` arriving as `null` is the null-delete, decided by
 * `preferenceWriteFor` at the control: the user has moved a control BACK to its
 * registry default, so the right write is to remove their stored opinion rather
 * than pin today's default into their document forever.
 *
 * =============================================================================
 * WHY TWO LOADING STATES, NESTED
 * =============================================================================
 *
 * This page needs two independent things: the user's settings document (owned
 * by `UserSettingsSection`) and the event registry (owned by
 * `useNotificationEvents`). They are separate endpoints and either can fail
 * alone, so they are reported separately: the outer spinner/alert is the
 * settings document's, the inner one below is the registry's. Collapsing them
 * would mean a registry failure renders an empty matrix, which is
 * indistinguishable from "this application notifies you about nothing".
 */

import { useCallback, useState } from 'react';
import { Alert } from '@mui/material';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { useIsMounted } from '../hooks/useIsMounted';
import { useNotificationCapability } from '../hooks/useNotificationCapability';
import { useNotificationConfig } from '../hooks/useNotificationConfig';
import { useNotificationEvents } from '../hooks/useNotificationEvents';
import { requestPermissionAndSyncPush } from '../services/pushSubscription';
import type { NotificationPreferencesPatch } from '../types';
import { UserSettingsSection } from './UserSettingsSection';

/** Mirrors the `Notifications` card in `config/userSettingsSections.tsx`, so the
 *  hub card, the compact AppBar title (#95) and this page's `h1` all agree. */
const PAGE_TITLE = 'Notifications';
const PAGE_DESCRIPTION =
  'Choose which events notify you, and whether they arrive by email or in your browser.';

export default function UserNotificationsPage() {
  // Both hooks at the top level of the component, NOT inside the render prop
  // below — a hook called from a callback is a hook called conditionally, and
  // the render prop is only invoked once the settings document has loaded.
  const { events, isLoading, error } = useNotificationEvents();

  // OBSERVED here; this page requests only from the click handler below (the
  // shell's `usePushSubscriptionSync` owns the once-per-load auto-prompt).
  //
  // #221 moved this from `useBrowserNotificationPermission` to the CAPABILITY
  // hook layered over it. Same observation, wider answer: the four permission
  // states could not distinguish an iOS Safari tab (fix: Add to Home Screen)
  // from an ancient browser (no fix), or a plain-HTTP origin (fix: HTTPS) from
  // either — so the page could only ever offer one remedy for four problems.
  // The raw permission is still available on this hook's result; nothing on
  // this page needs it, because every decision here is about what the user can
  // DO, which is exactly what `capability` names.
  //
  // #227: `adminDisabled` is now wired from `GET /api/notifications/config`,
  // via `useNotificationConfig` below. `config` is `null` until that first read
  // resolves, and `config?.browserEnabled === false` — rather than
  // `!config?.browserEnabled` — is what keeps that window from reading as
  // "disabled": see `useNotificationConfig`'s own header for why the two reads
  // disagree during loading and why only one of them is correct.
  const { config: notificationConfig } = useNotificationConfig();
  const { capability, refresh: refreshPermission } = useNotificationCapability({
    adminDisabled: notificationConfig?.browserEnabled === false,
  });

  const isMounted = useIsMounted();
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);

  /**
   * The "Allow notifications" button's handler (#127).
   *
   * Nothing on THIS page calls it automatically — the once-per-load auto-prompt
   * lives in the shell (`usePushSubscriptionSync`, #365). The button remains
   * because Firefox and Safari ignore a gestureless request. Like the shell,
   * it goes through `requestPermissionAndSyncPush`, so a grant here subscribes
   * this device to push straight away when the deployment offers it.
   *
   * THE REFRESH IS IN A `finally`, and that matters more than it looks.
   * `requestBrowserNotificationPermission` resolves `null` on an unsupported or
   * throwing browser and can resolve with the permission unchanged when the
   * user dismisses the prompt without choosing. Refreshing unconditionally
   * re-reads `Notification.permission` — the single source of truth for what
   * this page renders — instead of trusting one call's return value, so the
   * banner lands on the honest state in every one of those cases, including
   * "nothing happened, the button stays".
   */
  const handleRequestPermission = useCallback(async () => {
    setIsRequestingPermission(true);
    try {
      await requestPermissionAndSyncPush(notificationConfig);
    } finally {
      // Guarded: the prompt is modal and the user can navigate away from this
      // page while it is open, so both of these can land after unmount.
      if (isMounted()) {
        setIsRequestingPermission(false);
        refreshPermission();
      }
    }
  }, [isMounted, notificationConfig, refreshPermission]);

  return (
    <UserSettingsSection title={PAGE_TITLE} description={PAGE_DESCRIPTION}>
      {({ settings, isSaving, save }) => {
        if (isLoading) return <LoadingSpinner />;

        if (error) {
          // Inline and permanent, like the section's own fetch error: without
          // the registry there is no matrix to render, and a snackbar that
          // auto-hides would leave a blank page behind with no explanation.
          return <Alert severity="error">{error}</Alert>;
        }

        // `null` only in the window between "not loading" and "not errored",
        // which the two branches above have already covered; rendering nothing
        // is still the correct fallback rather than an assertion.
        if (!events) return null;

        return (
          <NotificationSettings
            events={events}
            // THE RAW STORED NAMESPACE, passed straight through — `undefined`
            // when the user has never saved a preference, which is the normal
            // case. Deliberately NOT `?? {}`-ed into a defaulted object here:
            // every control derives its own state from this plus the registry,
            // and the one thing that must never exist is a filled-in local copy.
            preferences={settings.notifications}
            isSaving={isSaving}
            browserCapability={capability}
            // The promise is dropped deliberately: `handleRequestPermission`
            // handles its own failure (there is nothing to report — the banner
            // already says what the state is) and the button's own spinner is
            // driven by `isRequestingPermission`.
            onRequestPermission={() => void handleRequestPermission()}
            isRequestingPermission={isRequestingPermission}
            // #365: the real value. `false` while the config is still loading,
            // matching the component's own default.
            pushEnabled={notificationConfig?.pushEnabled ?? false}
            onToggle={(channel, event, value) => {
              // The single-key patch. Built with a computed key so the channel
              // comes from the control that was clicked rather than from a
              // literal that could disagree with it, and typed explicitly so a
              // channel the union does not know about fails to compile here
              // rather than 400ing at the API's channel enum.
              const notifications: NotificationPreferencesPatch = {
                [channel]: { [event.key]: value },
              };

              // The promise is intentionally dropped: `save` reports its own
              // failures through the section's snackbar rather than rejecting,
              // exactly as `UserAppearancePage` does. On success the section
              // re-renders from the SERVER's response, so what the switch shows
              // afterwards is what was actually stored — no optimistic overlay,
              // and therefore no second source of truth to drift.
              void save(
                { notifications },
                {
                  success: 'Notification preferences updated',
                  failure: 'Failed to update notification preferences',
                },
              );
            }}
          />
        );
      }}
    </UserSettingsSection>
  );
}
