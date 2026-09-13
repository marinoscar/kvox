/**
 * Admin → Settings → Notifications (`/admin/settings/notifications`).
 *
 * Issue #225, epic #215. The `Notifications` card in `config/adminSections.tsx`
 * routes here, and — per the MANDATORY settings-hub rules in `CLAUDE.md` — that
 * registry entry is what makes this page reachable from the hub, the Console
 * rail and the AppBar title resolver at once. It is deliberately NOT a fourth
 * tab on an existing settings page: a tab gate is about CONTENT within one
 * destination, and this is a destination of its own.
 *
 * NOTHING ENFORCES THESE VALUES YET, AND THAT IS NOT A BUG. #225 adds the
 * setting, its persistence and this editor. The server-side enforcement — the
 * browser channel consulting `browserEnabled` / `disabledEvents` before it
 * writes a notification, and the non-admin read endpoint that lets the web app
 * stop asking for OS permission when the capability is off — is issue #226.
 * Until that lands, saving here changes the stored document and changes nothing
 * an end user can observe.
 *
 * WHY THE CHECKBOX IS INVERTED RELATIVE TO THE STORED FIELD. The document
 * stores `disabledEvents` (a suppression list), and this page renders a box
 * that is CHECKED when the event is delivered. That matches
 * `/settings/notifications`, where a switch being on means "you receive this" —
 * two notification surfaces whose controls read in opposite directions would be
 * a genuine hazard on a page whose whole job is silencing things. The inversion
 * happens in exactly one place (`toggleEvent`), never in render.
 *
 * ONLY BROWSER-CAPABLE EVENTS ARE LISTED. `disabledEvents` suppresses the
 * BROWSER notification; offering the control for an email-only event
 * (`user.welcome`, `allowlist.invitation`) would render a checkbox that cannot
 * do anything. The registry is the authority on which those are — this page
 * filters on `channels.includes('browser')` and never restates the list.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import { SystemSettingsSection } from './SystemSettingsSection';
import { useNotificationEvents } from '../../hooks/useNotificationEvents';
import type { NotificationEventDef, SystemNotificationSettings } from '../../types';

const PAGE_TITLE = 'Notifications';
const PAGE_DESCRIPTION =
  'Turn browser notifications on or off for everyone, and suppress individual events.';

/**
 * The block, defaulted.
 *
 * A UI that crashes because a field is missing is worse than one that shows the
 * documented defaults: this build can be deployed in front of an API that
 * predates #225, and the response schema is the API's promise, not a guarantee
 * about every server this bundle will ever talk to.
 */
const FALLBACK: SystemNotificationSettings = {
  browserEnabled: true,
  disabledEvents: [],
};

/** Order-insensitive set comparison, so re-ordering alone is not "dirty". */
function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((key, index) => key === right[index]);
}

interface EventRowProps {
  event: NotificationEventDef;
  /** Checked means DELIVERED — the inverse of membership in `disabledEvents`. */
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}

function EventRow({ event, enabled, disabled, onChange }: EventRowProps) {
  return (
    <Box sx={{ py: 1.5 }}>
      <FormControlLabel
        sx={{ alignItems: 'flex-start', m: 0 }}
        control={
          <Checkbox
            checked={enabled}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
            slotProps={{
              input: {
                'aria-label': `Browser notification for ${event.label}`,
              },
            }}
            sx={{ mt: -1 }}
          />
        }
        label={
          <Box>
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', flexWrap: 'wrap' }}
            >
              <Typography variant="subtitle2">{event.label}</Typography>
              {event.mandatory && (
                // The user cannot opt out of this one. An OPERATOR still can,
                // deployment-wide — the flag is a hint about who is in charge
                // of the per-user preference, not a lock on this page — so it
                // is labelled rather than disabled.
                <Chip
                  size="small"
                  icon={<LockIcon />}
                  label="Users cannot opt out"
                  variant="outlined"
                />
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {event.description}
            </Typography>
            <Typography variant="caption" color="text.disabled">
              {event.key}
            </Typography>
          </Box>
        }
      />
    </Box>
  );
}

export default function NotificationSettingsPage() {
  return (
    <SystemSettingsSection
      title={PAGE_TITLE}
      description={PAGE_DESCRIPTION}
      requiredPermission="system_settings:read"
    >
      {({ settings, canWrite, isSaving, saveBranch }) => (
        <NotificationSettingsForm
          stored={settings.notifications ?? FALLBACK}
          canWrite={canWrite}
          isSaving={isSaving}
          onSave={(value) => saveBranch('notifications', value)}
        />
      )}
    </SystemSettingsSection>
  );
}

interface FormProps {
  stored: SystemNotificationSettings;
  canWrite: boolean;
  isSaving: boolean;
  onSave: (value: SystemNotificationSettings) => Promise<void>;
}

/**
 * Split out from the page so the render prop stays a one-liner and the editing
 * state has a component of its own to live in: the page owns the chrome, the
 * form owns the pending edit.
 *
 * A BATCHED SAVE, unlike `/settings/notifications`, which PATCHes on every
 * toggle. The reason is the shape of the data, not a style preference: the
 * per-user matrix is a sparse map where each toggle is genuinely independent
 * and a null-delete keeps absent keys absent, whereas `disabledEvents` is a
 * single array that REPLACES wholesale. Saving per click would fire one full
 * array write per checkbox and race with itself; here a local mirror is the
 * correct model, because the local mirror IS the value being written.
 */
function NotificationSettingsForm({ stored, canWrite, isSaving, onSave }: FormProps) {
  const { events, isLoading, error } = useNotificationEvents();

  const [browserEnabled, setBrowserEnabled] = useState(stored.browserEnabled);
  const [disabledEvents, setDisabledEvents] = useState<string[]>(
    stored.disabledEvents,
  );

  // Re-seed from the server's answer whenever it changes — after a successful
  // save, or after the hook re-fetches on a 409. The stored document is the
  // source of truth and local state is only ever a pending edit of it.
  useEffect(() => {
    setBrowserEnabled(stored.browserEnabled);
    setDisabledEvents(stored.disabledEvents);
  }, [stored]);

  const browserEvents = useMemo(
    () => (events ?? []).filter((event) => event.channels.includes('browser')),
    [events],
  );

  const isDirty =
    browserEnabled !== stored.browserEnabled ||
    !sameKeys(disabledEvents, stored.disabledEvents);

  const controlsDisabled = !canWrite || isSaving;

  const toggleEvent = (key: string, enabled: boolean) => {
    setDisabledEvents((current) =>
      enabled ? current.filter((k) => k !== key) : [...new Set([...current, key])],
    );
  };

  const handleSave = () => {
    void onSave({ browserEnabled, disabledEvents });
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Browser notifications
      </Typography>

      <FormControlLabel
        control={
          <Switch
            checked={browserEnabled}
            disabled={controlsDisabled}
            onChange={(e) => setBrowserEnabled(e.target.checked)}
          />
        }
        label="Deliver browser notifications"
      />
      <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mb: 2 }}>
        When off, no one receives browser notifications, whatever their own
        preferences say. Email is unaffected.
      </Typography>

      <Divider sx={{ my: 3 }} />

      <Typography variant="h6" gutterBottom>
        Events
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Clear an event to stop showing its browser notification for everyone.
        Events that can only be delivered by email are not listed.
      </Typography>

      {!browserEnabled && (
        <Alert severity="info" sx={{ my: 2 }}>
          Browser notifications are off for everyone, so these choices are not in
          effect. They are kept, and apply again if you turn the switch back on.
        </Alert>
      )}

      {/* The events list is a SEPARATE request from the settings document, so
          it has its own loading and error states. A failure here must not hide
          the global switch above — that control needs nothing from the registry
          and stays usable. */}
      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={28} />
        </Box>
      )}

      {error && (
        <Alert severity="error" sx={{ my: 2 }}>
          {error}
        </Alert>
      )}

      {!isLoading && !error && browserEvents.length === 0 && (
        <Alert severity="info" sx={{ my: 2 }}>
          No events in this deployment can be delivered as a browser
          notification, so there is nothing to suppress here.
        </Alert>
      )}

      {browserEvents.length > 0 && (
        <Stack divider={<Divider flexItem />} sx={{ mt: 1 }}>
          {browserEvents.map((event) => (
            <EventRow
              key={event.key}
              event={event}
              enabled={!disabledEvents.includes(event.key)}
              // Greyed out, not hidden, when the channel is off: hiding them
              // would make the saved suppression list invisible and unrecoverable
              // without turning the switch back on first.
              disabled={controlsDisabled || !browserEnabled}
              onChange={(enabled) => toggleEvent(event.key, enabled)}
            />
          ))}
        </Stack>
      )}

      <Box sx={{ mt: 3 }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={controlsDisabled || !isDirty}
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </Button>
      </Box>
    </Box>
  );
}
