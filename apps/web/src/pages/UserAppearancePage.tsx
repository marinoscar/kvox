/**
 * Settings → Appearance (`/settings/appearance`).
 *
 * Issue #96, epic #90. The Theme card of the stacked `UserSettingsPage`, now an
 * addressable route. THIN BY DESIGN: `ThemeSettings` is not touched, not
 * copied, and not re-styled. Every line of shared page chrome lives in
 * `UserSettingsSection`.
 *
 * This edits the signed-in user's own theme, never a deployment-wide default —
 * there is no admin-side equivalent. The `User` filename prefix follows the
 * same convention as this page's siblings (`UserSettingsPage.tsx`,
 * `UserNotificationsPage.tsx`, ...), keeping every per-user settings page
 * distinct from admin pages in `App.tsx`'s lazy imports.
 *
 * The title and description mirror the `Appearance` card in
 * `config/userSettingsSections.tsx` so the hub card, the compact AppBar title
 * (#95) and the page's own `h1` all name the page identically.
 */

import { ThemeSettings } from '../components/settings/ThemeSettings';
import { UserSettingsSection } from './UserSettingsSection';

export default function UserAppearancePage() {
  return (
    <UserSettingsSection
      title="Appearance"
      description="Choose a light, dark, or system-matched theme for this account."
    >
      {({ settings, isSaving, save }) => (
        <ThemeSettings
          currentTheme={settings.theme}
          // The stacked page's `handleThemeChange`, message for message. The
          // returned promise is intentionally dropped: `onThemeChange` is typed
          // `void`, and `save` reports its own failures through the snackbar
          // rather than rejecting.
          onThemeChange={(theme) => {
            void save(
              { theme },
              { success: 'Theme updated', failure: 'Failed to update theme' },
            );
          }}
          disabled={isSaving}
        />
      )}
    </UserSettingsSection>
  );
}
