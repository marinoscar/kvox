/**
 * Shared chrome for every `/admin/settings/*` page that edits the system
 * settings document.
 *
 * Issue #92, epic #90. `SystemSettingsPage` used to be one component holding
 * three tabs, and with it ONE copy of the wiring those tabs shared: the
 * `useSystemSettings` hook, the loading spinner, the fetch-error alert, the
 * `canWrite` gate, the success/failure snackbars, and the "last updated by"
 * line. Splitting the tabs into four routed pages without extracting that
 * wiring would have produced four copies of it — and four copies of a
 * permission gate is precisely the split-brain `config/destinations.ts` was
 * written to end. There is still exactly one copy; it just lives here now.
 *
 * A RENDER PROP rather than an outlet or a HOC. The children need `settings`,
 * `canWrite` and `isSaving` as VALUES — the typed editors (today
 * `NotificationSettingsPage`'s form) take them as props — and a render prop
 * hands them over without a context, without a wrapper component
 * per page, and without any page being able to render before `settings` is
 * non-null. That last part is why `settings` is non-nullable in the callback's
 * argument: the null case is handled once, here, so no page repeats a
 * `settings && …` guard that TypeScript would otherwise demand of each.
 *
 * THE PAGE-LEVEL PERMISSION CHECK IS DEFENCE, NOT THE GATE. `App.tsx` wraps
 * each route in `RequirePermission` with the same string, which is the real
 * enforcement point; this one exists for a page mounted from anywhere else, and
 * it is the check `SystemSettingsPage` already carried. `requiredPermission` is
 * a prop rather than a hardcoded `system_settings:read` so the page states the
 * same string its route and its card in `config/adminSections.tsx` declare.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Box, Container, Paper, Snackbar, Typography } from '@mui/material';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useSystemSettings } from '../../hooks/useSystemSettings';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import type { SystemSettings } from '../../types';

/** What every settings page gets handed once the document has loaded. */
export interface SystemSettingsSectionState {
  settings: SystemSettings;
  /** `system_settings:write`. Pages pass `!canWrite || isSaving` as `disabled`. */
  canWrite: boolean;
  isSaving: boolean;
  /**
   * PATCH ONE top-level branch (`notifications`, …) and raise the success
   * snackbar. This is the old page's `handleSave`, unchanged: a rejected save
   * is reported through the error snackbar rather than rethrown, because the
   * typed editors treat `onSave` as fire-and-forget.
   */
  saveBranch: (key: keyof SystemSettings, value: unknown) => Promise<void>;
  /**
   * The raw hook function: PATCHes an arbitrary partial and RETHROWS.
   *
   * For an editor that renders its own inline error `Alert` and so needs the
   * rejection to reach its `catch`, which the snackbar path above deliberately
   * swallows. No current page uses it.
   */
  updateSettings: (updates: Partial<SystemSettings>) => Promise<void>;
}

interface SystemSettingsSectionProps {
  /** `h1` for the page. Mirrors the card title in `config/adminSections.tsx`. */
  title: string;
  /** Secondary line under the title. Mirrors the card description. */
  description: string;
  /** Permission required to render at all; the same string the route enforces. */
  requiredPermission: string;
  children: (state: SystemSettingsSectionState) => ReactNode;
}

export function SystemSettingsSection({
  title,
  description,
  requiredPermission,
  children,
}: SystemSettingsSectionProps) {
  const { hasPermission } = usePermissions();
  const { settings, isLoading, error, isSaving, updateSettings } = useSystemSettings();

  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  if (!hasPermission(requiredPermission)) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('system_settings:write');

  const saveBranch = async (key: keyof SystemSettings, value: unknown) => {
    try {
      await updateSettings({ [key]: value } as Partial<SystemSettings>);
      setSuccessMessage('Settings saved');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          {title}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {description}
          {/* Stated in the subtitle rather than left for the user to discover
              by finding every control disabled. A page that silently refuses to
              save reads as broken; a page that says "read-only" reads as
              permissions. */}
          {!canWrite && ' (read-only)'}
        </Typography>

        {settings?.updatedBy && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Last updated by {settings.updatedBy.email} on{' '}
            {new Date(settings.updatedAt).toLocaleString()}
          </Typography>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {settings && (
          <Paper sx={{ mt: 2, p: 3 }}>
            {children({ settings, canWrite, isSaving, saveBranch, updateSettings })}
          </Paper>
        )}

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

export default SystemSettingsSection;
