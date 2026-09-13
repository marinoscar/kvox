/**
 * App-wide "notifications are not on for this device" banner — issue #365.
 *
 * Rendered by `Layout` directly under `MaintenanceBanner`, fed by the single
 * `usePushSubscriptionSync` mount there. Shown only when the deployment offers
 * browser or push notifications and this device can act on it:
 *
 *   * `default`           — an Enable button. The auto-prompt may have been
 *                           ignored (Firefox/Safari need a gesture) or quieted
 *                           (Chrome), so a click must always be available.
 *   * `denied`            — the app cannot re-ask; explain the browser's
 *                           site-settings remedy.
 *   * `ios-needs-install` — Add to Home Screen first.
 *
 * Every other capability renders nothing: there is either nothing left to do
 * (`granted`, `sw-unavailable`) or nothing the user can do
 * (`unsupported`, `insecure-context`, `admin-disabled`).
 *
 * Dismissal lasts for the browser session only, and only for the state that
 * was dismissed — the owner wants this prominent, so it returns on the next
 * visit, and a dismissed `default` that becomes `denied` shows again.
 * Suppressed on `/settings/notifications`, which carries the fuller version of
 * the same message and controls.
 */

import { useState, type ReactNode } from 'react';
import { Alert, AlertTitle, Box, Button, CircularProgress, IconButton, Stack } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import type { NotificationCapability } from '../../hooks/useNotificationCapability';
import type { NotificationConfigResponse } from '../../types';

export const NOTIFICATION_SETTINGS_PATH = '/settings/notifications';
export const BANNER_DISMISSED_STORAGE_KEY = 'notificationPermissionBanner.dismissed';

type BannerCapability = Extract<NotificationCapability, 'default' | 'denied' | 'ios-needs-install'>;

function isBannerCapability(capability: NotificationCapability): capability is BannerCapability {
  return capability === 'default' || capability === 'denied' || capability === 'ios-needs-install';
}

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(BANNER_DISMISSED_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(capability: BannerCapability): void {
  try {
    window.sessionStorage.setItem(BANNER_DISMISSED_STORAGE_KEY, capability);
  } catch {
    // Storage blocked: the in-memory dismissal below still hides it for now.
  }
}

export interface NotificationPermissionBannerProps {
  /** `null` while loading — renders nothing rather than flashing. */
  config: NotificationConfigResponse | null;
  capability: NotificationCapability;
  onRequestPermission: () => void;
  isRequestingPermission?: boolean;
}

export function NotificationPermissionBanner({
  config,
  capability,
  onRequestPermission,
  isRequestingPermission = false,
}: NotificationPermissionBannerProps) {
  const { pathname } = useLocation();
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);

  if (!config || !(config.pushEnabled || config.browserEnabled)) return null;
  if (!isBannerCapability(capability)) return null;
  if (dismissed === capability) return null;
  if (pathname === NOTIFICATION_SETTINGS_PATH || pathname.startsWith(`${NOTIFICATION_SETTINGS_PATH}/`)) {
    return null;
  }

  const dismiss = () => {
    writeDismissed(capability);
    setDismissed(capability);
  };

  const settingsLink = (
    <Button component={RouterLink} to={NOTIFICATION_SETTINGS_PATH} color="inherit" size="small">
      {capability === 'ios-needs-install' ? 'Show me how' : 'Notification settings'}
    </Button>
  );

  let title: string;
  let body: string;
  let primaryAction: ReactNode;

  switch (capability) {
    case 'default':
      title = 'Notifications are not enabled on this device';
      body = 'Turn them on so important alerts reach you even when this app is closed.';
      primaryAction = (
        <Button
          variant="contained"
          color="warning"
          size="small"
          onClick={onRequestPermission}
          disabled={isRequestingPermission}
          startIcon={isRequestingPermission ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {isRequestingPermission ? 'Waiting for your browser…' : 'Enable notifications'}
        </Button>
      );
      break;
    case 'denied':
      title = 'Notifications are blocked on this device';
      body =
        'Your browser is blocking notifications from this site, and the app cannot ask again. ' +
        'Open your browser’s site settings (usually the icon at the left of the address bar) ' +
        'and allow notifications.';
      primaryAction = settingsLink;
      break;
    case 'ios-needs-install':
      title = 'Add this app to your Home Screen to get notifications';
      body =
        'On iPhone and iPad, notifications only work for apps added to the Home Screen: ' +
        'tap Share, then “Add to Home Screen”.';
      primaryAction = settingsLink;
      break;
  }

  return (
    <Box sx={{ mb: 3 }}>
      <Alert
        severity={capability === 'ios-needs-install' ? 'info' : 'warning'}
        action={
          <IconButton aria-label="Dismiss notification banner" color="inherit" size="small" onClick={dismiss}>
            <CloseIcon fontSize="small" />
          </IconButton>
        }
      >
        <AlertTitle>{title}</AlertTitle>
        {body}
        {/* Below the copy rather than in the Alert's `action` slot, so the
            button wraps under the text at phone width instead of squeezing it. */}
        <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
          {primaryAction}
          {capability === 'default' && settingsLink}
        </Stack>
      </Alert>
    </Box>
  );
}
