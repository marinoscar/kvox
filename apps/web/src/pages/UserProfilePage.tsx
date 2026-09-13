/**
 * Settings → Profile (`/settings/profile`).
 *
 * Issue #96, epic #90. The Profile card of the stacked `UserSettingsPage`, now
 * an addressable route. THIN BY DESIGN: `ProfileSettings` is not touched, not
 * copied, and not re-styled — this issue moves where the component is reached
 * from, nothing about what it renders. Every line of shared page chrome (the
 * hook, the spinner, the fetch-error alert, the snackbars) lives in
 * `UserSettingsSection`.
 *
 * The title and description mirror the `Profile` card in
 * `config/userSettingsSections.tsx` so the hub card, the compact AppBar title
 * (#95) and the page's own `h1` all name the page identically.
 */

import { ProfileSettings } from '../components/settings/ProfileSettings';
import { UserSettingsSection } from './UserSettingsSection';

export default function UserProfilePage() {
  return (
    <UserSettingsSection
      title="Profile"
      description="Your display name and profile image, and the email you signed in with."
    >
      {({ settings, isSaving, save, replaceSettings }) => (
        <ProfileSettings
          profile={settings.profile}
          // The stacked page's `handleProfileSave`, message for message.
          onSave={(profile) =>
            save(
              { profile },
              { success: 'Profile updated', failure: 'Failed to update profile' },
            )
          }
          // Upload/remove return the new settings document (#367); adopting it
          // keeps the stored `version` current for the next PATCH.
          onSettingsReplaced={replaceSettings}
          disabled={isSaving}
        />
      )}
    </UserSettingsSection>
  );
}
