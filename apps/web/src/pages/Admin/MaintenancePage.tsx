/**
 * Admin → Settings → Maintenance (`/admin/settings/maintenance`).
 *
 * Issue #258, epic #254. A REGISTRY CARD and nothing else, per `CLAUDE.md`'s
 * MANDATORY Settings UI Pattern: one entry in `ADMIN_SECTIONS`
 * (`config/adminSections.tsx`), one route in `App.tsx` gated on the same
 * permission string, and no tab anywhere. The hub, the Console rail and the
 * compact AppBar title all pick this page up from that single declaration.
 *
 * It is deliberately NOT a section or a tab on another settings page: a tab
 * gate is about CONTENT within one destination, and this is a destination of
 * its own — the one screen an operator navigates straight to during an
 * incident.
 *
 * WHY IT DOES NOT USE `SystemSettingsSection` (the render-prop wrapper
 * `NotificationSettingsPage` uses). That component is bound to
 * `useSystemSettings`: it loads the whole system settings document and PATCHes
 * one branch of it. The maintenance window is a different controller with a response this page exists
 * to render — `source` and `layers`, which the settings document does not carry
 * — and a write that must be a `PUT` of `{ enabled, … }` so the API can stamp
 * the window's provenance. `EmailSettingsPage` (#124) made the same departure
 * for the same reason, and what is shared is the CHROME, reproduced here field
 * for field: container, `h4` title, mirrored card description, "(read-only)"
 * suffix, `Paper` body, save snackbar.
 *
 * =============================================================================
 * THE LAYERS ARE THE POINT OF THIS PAGE, NOT DECORATION
 * =============================================================================
 *
 * A switch would have been three lines. "I turned it off and it is still on" is
 * the question an operator asks at the worst possible moment, and its honest
 * answer — "because `MAINTENANCE_MODE=true` is still in this deployment's
 * environment, and it outranks the row you just wrote" — is invisible unless
 * every contributing layer is on screen next to the effective state. The API
 * publishes all three for exactly this reason; a page that rendered only
 * `enabled` would throw that away and send the operator to a shell.
 *
 * =============================================================================
 * WHAT AN ENVIRONMENT OVERRIDE DISABLES, AND WHAT IT DOES NOT
 * =============================================================================
 *
 * `MAINTENANCE_MODE` carries a BOOLEAN AND NOTHING ELSE. In
 * `MaintenanceModeService.resolve` the env layer decides `enabled`, while
 * `message` and `allowAdmins` are resolved independently from the highest layer
 * that actually supplies them — which, with no in-memory override, is the
 * persisted row this page writes.
 *
 * So an env override disables the ON/OFF SWITCH ONLY. Greying the whole form
 * out would be the easy gesture and the wrong one: it would stop an operator
 * preparing the message and the `allowAdmins` value that take effect the moment
 * the variable is removed — and those are the settings that a window forced
 * open from the environment is *still using right now*.
 */

import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  FormControlLabel,
  Paper,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useMaintenance } from '../../hooks/useMaintenance';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { isDecidingLayer } from '../../services/maintenance';
import type { MaintenanceStatus, MaintenanceSource } from '../../types';

/** Mirrors the `Maintenance` card in `config/adminSections.tsx`, word for word. */
const PAGE_TITLE = 'Maintenance';
const PAGE_DESCRIPTION =
  'Take the application out of service for planned work, with a message for anyone who tries to use it.';

/** The API's own ceiling on the message (`systemMaintenanceSchema`, `.max(1000)`). */
const MAX_MESSAGE_LENGTH = 1000;

interface FormState {
  enabled: boolean;
  message: string;
  allowAdmins: boolean;
}

function toFormState(status: MaintenanceStatus): FormState {
  return {
    // The EFFECTIVE values, not `layers.persisted.value`. With no override the
    // two agree; with one, showing the persisted row would put a switch reading
    // "off" above a banner saying the application is out of service.
    enabled: status.enabled,
    message: status.message,
    allowAdmins: status.allowAdmins,
  };
}

/** Human copy for `source`. Never rendered as the raw enum — an operator is not reading a DTO. */
const SOURCE_LABEL: Record<MaintenanceSource, string> = {
  env: 'Environment variable',
  memory: 'Server task',
  persisted: 'Saved setting',
};

interface LayerRowProps {
  label: string;
  /** True when this layer is the one deciding `enabled` right now. */
  deciding: boolean;
  children: ReactNode;
}

/**
 * One layer, with a badge on whichever one is winning.
 *
 * The badge is the single most useful pixel on this page: it converts "here are
 * three values, work it out" into "this one is the answer", which is the whole
 * difference between the layers being diagnostic and being noise.
 */
function LayerRow({ label, deciding, children }: LayerRowProps) {
  return (
    <Box sx={{ py: 1.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="subtitle2">{label}</Typography>
        {deciding && <Chip size="small" color="primary" label="Deciding" />}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {children}
      </Typography>
    </Box>
  );
}

export default function AdminMaintenancePage() {
  const { hasPermission } = usePermissions();
  const { status, isLoading, loadError, isSaving, saveError, save } = useMaintenance();

  const [form, setForm] = useState<FormState | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  // Re-seed from the server's answer whenever it changes — on load, and after a
  // save. The response is the baseline, never the input: an env override can
  // make the state after a write differ from what was written, and the operator
  // must be shown what is true rather than what they asked for.
  useEffect(() => {
    if (status) setForm(toFormState(status));
  }, [status]);

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string, exactly as every sibling admin page does. This
  // catches the page mounted from anywhere else, and sits after every hook so
  // the hook order never changes.
  if (!hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('system_settings:write');

  if (isLoading || (!form && !loadError)) {
    return <LoadingSpinner />;
  }

  const envOverride = status?.layers.env;
  // The environment decides ON/OFF and nothing else — see the file header.
  const enabledLocked = !!envOverride?.present;
  const messageTooLong = !!form && form.message.trim().length > MAX_MESSAGE_LENGTH;
  const messageEmpty = !!form && form.message.trim().length === 0;

  const isDirty =
    !!form && !!status && JSON.stringify(form) !== JSON.stringify(toFormState(status));

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || !canWrite || messageTooLong || messageEmpty) return;

    const ok = await save({
      enabled: form.enabled,
      message: form.message.trim(),
      allowAdmins: form.allowAdmins,
    });

    if (ok) setSavedMessage('Maintenance settings saved');
  };

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {/* Title and description MIRROR the `Maintenance` card so the hub card,
            the rail row, the compact AppBar title and this `h1` all name the
            page identically. */}
        <Typography variant="h4" component="h1" gutterBottom>
          {PAGE_TITLE}
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {PAGE_DESCRIPTION}
          {/* Stated up front rather than left for the operator to discover by
              finding every control disabled. */}
          {!canWrite && ' (read-only)'}
        </Typography>

        {loadError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {loadError}
          </Alert>
        )}

        {saveError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {saveError}
          </Alert>
        )}

        {status && form && (
          <>
            {/* ------------------------------------------------------------------
                THE EFFECTIVE STATE, FIRST AND ON ITS OWN.
                What the application is actually doing to its users right now —
                the one fact an operator opening this page in an incident needs
                before anything else. Severity carries it as well as the words
                do, so it reads correctly at a glance from across a room.
                ------------------------------------------------------------- */}
            <Alert severity={status.enabled ? 'warning' : 'success'} sx={{ mb: 3 }}>
              <AlertTitle>
                {status.enabled
                  ? 'Maintenance mode is ON — the application is out of service'
                  : 'Maintenance mode is off — the application is serving normally'}
              </AlertTitle>
              <Stack spacing={0.5}>
                <span>
                  Decided by: <strong>{SOURCE_LABEL[status.source]}</strong>
                </span>
                {status.enabled && (
                  <span>
                    {status.allowAdmins
                      ? 'Administrators keep access; everyone else is turned away.'
                      : 'Everyone is turned away, administrators included.'}
                  </span>
                )}
                {/* Provenance belongs to the PERSISTED window and to nothing
                    else — neither the environment nor a server task has a user
                    to attribute a window to — so it is rendered only when the
                    API actually supplies it, never invented. */}
                {status.startedAt && (
                  <span>Opened {new Date(status.startedAt).toLocaleString()}</span>
                )}
              </Stack>
            </Alert>

            {enabledLocked && (
              <Alert severity="info" sx={{ mb: 3 }}>
                <AlertTitle>
                  This deployment’s environment is forcing maintenance mode{' '}
                  {envOverride?.enabled ? 'ON' : 'OFF'}
                </AlertTitle>
                {/* The exact recovery, named, because this is the state an
                    operator lands in while wondering why the switch does
                    nothing. */}
                <span>
                  The <code>MAINTENANCE_MODE</code> variable outranks anything saved here, so
                  the switch below cannot change what the application does. Remove the
                  variable from the environment and restart the API to hand control back to
                  this page. The message and administrator access below still apply and can
                  still be edited.
                </span>
              </Alert>
            )}

            <Paper sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
              <Box component="form" onSubmit={handleSubmit} noValidate>
                <FormControlLabel
                  control={
                    <Switch
                      checked={form.enabled}
                      onChange={(e) => update('enabled', e.target.checked)}
                      // Disabled by an env override as well as by permission:
                      // a control that accepted a change it cannot make would
                      // be a lie the operator only discovers after saving.
                      disabled={!canWrite || isSaving || enabledLocked}
                      slotProps={{ input: { 'aria-label': 'Maintenance mode' } }}
                    />
                  }
                  label="Turn maintenance mode on"
                />
                <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mb: 2 }}>
                  Every API request answers 503 with the message below, except signing in,
                  signing out and this page.
                </Typography>

                <Divider sx={{ my: 3 }} />

                <TextField
                  fullWidth
                  multiline
                  minRows={3}
                  label="Message shown to users"
                  value={form.message}
                  onChange={(e) => update('message', e.target.value)}
                  disabled={!canWrite || isSaving}
                  error={messageTooLong || messageEmpty}
                  helperText={
                    messageEmpty
                      ? 'A message is required — it is the only thing a blocked user is told.'
                      : messageTooLong
                        ? `Keep the message to ${MAX_MESSAGE_LENGTH} characters or fewer.`
                        : 'Shown verbatim on the maintenance screen. Say what is happening and when you expect to be back.'
                  }
                />

                <FormControlLabel
                  sx={{ mt: 2 }}
                  control={
                    <Switch
                      checked={form.allowAdmins}
                      onChange={(e) => update('allowAdmins', e.target.checked)}
                      disabled={!canWrite || isSaving}
                      slotProps={{ input: { 'aria-label': 'Allow administrators' } }}
                    />
                  }
                  label="Let administrators keep using the application"
                />
                {/* The one setting that can lock its own fix out, so the warning
                    is attached to the control rather than left in a runbook. */}
                {!form.allowAdmins && (
                  <Alert severity="warning" sx={{ mt: 1 }}>
                    With this off, administrators are turned away too. This page and signing
                    in stay reachable, but if that is ever not enough the only way back is to
                    set <code>MAINTENANCE_MODE=false</code> in the environment and restart.
                  </Alert>
                )}

                <Box sx={{ mt: 3 }}>
                  <Button
                    type="submit"
                    variant="contained"
                    disabled={
                      !canWrite || isSaving || !isDirty || messageTooLong || messageEmpty
                    }
                  >
                    {isSaving ? 'Saving...' : 'Save Changes'}
                  </Button>
                </Box>
              </Box>
            </Paper>

            {/* ------------------------------------------------------------------
                EVERY CONTRIBUTING LAYER, SEPARATELY. See the file header for why
                this is not optional.
                ------------------------------------------------------------- */}
            <Paper sx={{ p: { xs: 2, sm: 3 } }}>
              <Typography variant="h6" gutterBottom>
                Where this setting comes from
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Three layers can turn maintenance mode on, and the first one that has an
                answer wins. This is what each of them currently says.
              </Typography>

              <Stack divider={<Divider flexItem />}>
                <LayerRow label="1. Environment variable" deciding={isDecidingLayer(status, 'env')}>
                  {status.layers.env.present
                    ? `MAINTENANCE_MODE is set to “${status.layers.env.enabled}”, forcing maintenance mode ${
                        status.layers.env.enabled ? 'on' : 'off'
                      }.`
                    : 'MAINTENANCE_MODE is not set, so this layer has no opinion.'}
                </LayerRow>

                <LayerRow label="2. Server task" deciding={isDecidingLayer(status, 'memory')}>
                  {status.layers.memory.present
                    ? `A task running on the API has taken the window (${
                        status.layers.memory.override?.enabled ? 'on' : 'off'
                      }). It is held in memory only and is released when the task finishes.`
                    : 'No task on the API is holding the window.'}
                </LayerRow>

                <LayerRow label="3. Saved setting" deciding={isDecidingLayer(status, 'persisted')}>
                  {status.layers.persisted.readable
                    ? `Saved as ${
                        status.layers.persisted.value.enabled ? 'on' : 'off'
                      }, administrators ${
                        status.layers.persisted.value.allowAdmins ? 'allowed' : 'not allowed'
                      }. This is the layer the form above writes.`
                    : // Named plainly, because it changes what the values above
                      // mean: the API could not read the row and is reporting
                      // the last state it saw.
                      'The saved setting could not be read, so the values shown are the last ones the API saw. This is expected while a database restore is in progress.'}
                </LayerRow>
              </Stack>
            </Paper>
          </>
        )}

        <Snackbar
          open={!!savedMessage}
          autoHideDuration={3000}
          onClose={() => setSavedMessage(null)}
          message={savedMessage}
        />
      </Box>
    </Container>
  );
}
