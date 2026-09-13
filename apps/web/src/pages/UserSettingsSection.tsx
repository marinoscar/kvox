/**
 * Shared chrome for every `/settings/*` page that edits the user settings
 * document.
 *
 * Issue #96, epic #90. The exact counterpart of
 * `pages/Admin/SystemSettingsSection.tsx` (#92), for the same reason and with
 * the same shape. `UserSettingsPage` used to be one component stacking three
 * cards, and with it ONE copy of the wiring those cards shared: the
 * `useUserSettings` hook, the loading spinner, the fetch-error alert, and the
 * success/failure snackbars. Splitting the stack into routed pages without
 * extracting that wiring would have produced a copy of it per page — and the
 * whole point of epic #90 is that near-identical copies drift within a release.
 * There is still exactly one copy; it just lives here now.
 *
 * ONE HOOK CALL PER PAGE, NOT ONE FOR THE SURFACE. Each routed page mounts its
 * own `UserSettingsSection`, so each owns its own `useUserSettings()` and its
 * own snackbar state. That is the behavioural change #96 asks for: on the old
 * stacked page a successful theme save raised a toast that sat visually
 * alongside the Profile card, because there was one snackbar for three
 * sections. Two pages that are never mounted together cannot do that. The cost
 * is one `GET /user-settings` per settings page visit, which is the same cost
 * the admin split already accepted and is dwarfed by the page's own chunk.
 *
 * A RENDER PROP rather than an outlet or a HOC — same argument as the admin
 * wrapper. `ThemeSettings` and `ProfileSettings` take `settings` fields as
 * VALUES and are deliberately left untouched by this issue, so the state has to
 * arrive as arguments. It also lets `settings` be NON-NULLABLE in the callback:
 * the null case is handled once, here, so neither page repeats a
 * `settings && …` guard that TypeScript would otherwise demand of both.
 *
 * NO `RequirePermission`, NO `hasPermission` CHECK, unlike the admin wrapper —
 * and that is a deliberate difference, not an omission. These are the user's
 * own settings; the API grants `user_settings:read` / `user_settings:write` to
 * all three roles, and `config/userSettingsSections.tsx` declares no
 * `permission` on any card for the same reason. A gate here would be inventing
 * an authorization rule the API does not enforce, and would lock users out of
 * their own profile.
 *
 * NO `<Paper>` AROUND THE CHILDREN, unlike the admin wrapper. The admin editors
 * are bare form controls that need section chrome; `ThemeSettings`,
 * `ProfileSettings` and `PersonalAccessTokens` each render their own `<Card>`
 * already, and nesting those in a Paper stacks two elevated surfaces with a
 * hairline of background between them.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Container, Snackbar, Typography } from '@mui/material';
import { useUserSettings } from '../hooks/useUserSettings';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import type { UserSettings, UserSettingsUpdate } from '../types';

/** The strings a save raises, per call site. See `save` below. */
export interface UserSettingsSaveMessages {
  /** Shown in the success snackbar, e.g. `'Theme updated'`. */
  success: string;
  /**
   * Success-path fallback for the ERROR snackbar when the rejection is not an
   * `Error` and therefore carries no `.message`, e.g. `'Failed to update
   * theme'`. Carried per call site rather than hardcoded to one generic string
   * so the two pages keep the exact copy the stacked page used.
   */
  failure: string;
}

/** What a settings page gets handed once the document has loaded. */
export interface UserSettingsSectionState {
  settings: UserSettings;
  /** True while a PATCH is in flight. Pages pass it straight to `disabled`. */
  isSaving: boolean;
  /**
   * PATCH a partial settings document and raise the success snackbar.
   *
   * SWALLOWS the rejection into the error snackbar rather than rethrowing —
   * this is `UserSettingsPage`'s `handleThemeChange` / `handleProfileSave`
   * unchanged, and both callers depend on it. `ProfileSettings.handleSave`
   * awaits `onSave` and then calls `refreshUser()` outside any try/catch: if
   * this rethrew, a failed save would skip that refresh and leave the form's
   * `isSaving` cleared only by its `finally`, with the rejection escaping as an
   * unhandled promise. `ThemeSettings.onThemeChange` is typed `void` and does
   * not even receive the promise.
   */
  save: (updates: UserSettingsUpdate, messages: UserSettingsSaveMessages) => Promise<void>;
  /**
   * Adopt a settings document an endpoint other than `PATCH /user-settings`
   * already returned (the profile-image upload/delete responses), so the
   * stored `version` stays current, and optionally raise the success snackbar.
   */
  replaceSettings: (settings: UserSettings, successMessage?: string) => void;
}

interface UserSettingsSectionProps {
  /** `h1` for the page. Mirrors the card title in `userSettingsSections.tsx`. */
  title: string;
  /** Secondary line under the title. Mirrors the card description. */
  description: string;
  children: (state: UserSettingsSectionState) => ReactNode;
}

export function UserSettingsSection({
  title,
  description,
  children,
}: UserSettingsSectionProps) {
  const {
    settings,
    isLoading,
    error,
    isSaving,
    updateSettings,
    replaceSettings: adoptSettings,
  } = useUserSettings();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const replaceSettings = (next: UserSettings, message?: string) => {
    adoptSettings(next);
    if (message) setSuccessMessage(message);
  };

  const save = async (updates: UserSettingsUpdate, messages: UserSettingsSaveMessages) => {
    try {
      await updateSettings(updates);
      setSuccessMessage(messages.success);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : messages.failure);
    }
  };

  // Before the `Container`, exactly as the stacked page did: a spinner under a
  // heading that is about to be replaced by the same heading flickers, and the
  // AppBar (#95) is already naming the page from the registry while this loads.
  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {title}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {description}
        </Typography>

        {/* The FETCH error, distinct from the save error below it. This one is
            inline and permanent because the page has no content to show without
            it; a snackbar that auto-hides after five seconds would leave an
            empty page behind with no explanation. */}
        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {settings && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {children({ settings, isSaving, save, replaceSettings })}
          </Box>
        )}

        {/* Both snackbars are per-PAGE as of #96 — see the file header. */}
        <Snackbar
          open={!!successMessage}
          autoHideDuration={3000}
          onClose={() => setSuccessMessage(null)}
          message={successMessage}
        />

        <Snackbar
          open={!!localError}
          autoHideDuration={5000}
          onClose={() => setLocalError(null)}
        >
          <Alert severity="error" onClose={() => setLocalError(null)}>
            {localError}
          </Alert>
        </Snackbar>
      </Box>
    </Container>
  );
}

export default UserSettingsSection;
