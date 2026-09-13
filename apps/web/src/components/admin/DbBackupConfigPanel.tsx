/**
 * The backup policy form (issue #287, epic #254).
 *
 * A component rather than JSX inside `DbBackupPage.tsx`, for the reason
 * `NodeCredentials` and `BroadcastComposer` are components: the page owns the
 * fetching and the run history, and this owns one form's draft state. It is
 * also the half of the page a test wants to drive without a table, a poll and a
 * restore dialog mounted around it.
 *
 * =============================================================================
 * ⚠ `nextRunAt` IS THE REASON THIS PANEL IS WORTH RENDERING AT ALL
 * =============================================================================
 *
 * A backup schedule is the one setting whose mistakes are invisible: a wrong
 * hour, or a timezone the runtime cannot resolve, does not fail at save time —
 * it fails HOURS LATER inside a cron tick on a night nobody is watching, and
 * the symptom is that a backup did not happen, which looks exactly like a
 * deployment that is being backed up.
 *
 * So the server's own projection of the schedule is displayed beside the form
 * and refreshed from every save. It is the API's arithmetic, through the stored
 * timezone, from the same code path the scheduler fires on — never a
 * client-side `Date` calculation, which would be a second implementation of the
 * one thing this panel exists to let an administrator verify.
 *
 * =============================================================================
 * THE TIMEZONE IS NOT VALIDATED HERE, DELIBERATELY
 * =============================================================================
 *
 * The field is free text and this component ships no list of IANA names. The
 * API validates by PERFORMING the projection: if the zone cannot be resolved it
 * answers 400, and that message is rendered verbatim. A hand-kept list in the
 * browser would rot, would disagree with the runtime's own ICU data, and would
 * reject a zone the server can actually schedule against — the client would be
 * refusing on evidence unrelated to whether the write will succeed.
 *
 * =============================================================================
 * WHAT IS NOT ON THIS FORM
 * =============================================================================
 *
 * `storageProvider` and `runStaleMinutes` are part of the stored policy and are
 * NOT edited here. The first must equal the active provider or be empty
 * ("whatever is active"), so a free-text box over it is a way to break tonight's
 * backup with a typo and no benefit; the second is the sweep threshold that
 * decides when an unheard-from run is called `stale`, which is an internal
 * timing constant rather than a policy an operator has a view on. Both remain
 * writable through the API — `PATCH /api/system-settings` with a
 * `databaseBackup` body — for the rare operator who genuinely needs to change
 * them; there is deliberately no form field for either.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  FormControlLabel,
  Grid,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import {
  DB_BACKUP_FREQUENCIES,
  RESTORE_ROLLBACK_MODES,
} from '../../services/dbBackup';
import type {
  DbBackupConfig,
  DbBackupFrequency,
  RestoreRollbackMode,
  UpdateDbBackupConfigInput,
} from '../../services/dbBackup';

/** The editable half of `DbBackupConfig` — the computed fields are not settable. */
type ConfigForm = Required<
  Pick<
    DbBackupConfig,
    | 'enabled'
    | 'frequency'
    | 'dayOfWeek'
    | 'dayOfMonth'
    | 'timeOfDay'
    | 'timezone'
    | 'retentionCount'
    | 'compressionLevel'
    | 'restoreRollbackMode'
    | 'oldDatabaseRetentionHours'
  >
>;

const FREQUENCY_LABELS: Record<DbBackupFrequency, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
};

const ROLLBACK_MODE_LABELS: Record<RestoreRollbackMode, string> = {
  retain_database: 'Keep the replaced database (rolling back takes seconds)',
  drop_database: 'Drop the replaced database (rolling back takes hours)',
};

/**
 * Weekday names, indexed by the API's own `dayOfWeek` (0 = Sunday).
 *
 * Written out rather than derived from `Intl`: the VALUE is a number the API
 * defines, and a locale-derived list would silently reorder itself in a locale
 * whose week starts on Monday, which would map "Monday" onto `0`.
 */
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function toForm(config: DbBackupConfig): ConfigForm {
  return {
    enabled: config.enabled,
    frequency: config.frequency,
    dayOfWeek: config.dayOfWeek,
    dayOfMonth: config.dayOfMonth,
    timeOfDay: config.timeOfDay,
    timezone: config.timezone,
    retentionCount: config.retentionCount,
    compressionLevel: config.compressionLevel,
    restoreRollbackMode: config.restoreRollbackMode,
    oldDatabaseRetentionHours: config.oldDatabaseRetentionHours,
  };
}

export interface DbBackupConfigPanelProps {
  config: DbBackupConfig;
  canWrite: boolean;
  isSaving: boolean;
  /** The API's own message when a save was refused — rendered verbatim. */
  saveError: string | null;
  onSave: (input: UpdateDbBackupConfigInput) => Promise<boolean>;
  onSaved: (message: string) => void;
}

export function DbBackupConfigPanel({
  config,
  canWrite,
  isSaving,
  saveError,
  onSave,
  onSaved,
}: DbBackupConfigPanelProps) {
  const [form, setForm] = useState<ConfigForm>(() => toForm(config));

  /**
   * Re-seed from the server whenever the SAVED policy changes.
   *
   * Keyed on the config object, which `useDbBackupConfig` replaces only when
   * the API hands back a new one (a load, a poll, or a successful save). An
   * operator must be shown what is true rather than what they asked for — the
   * same rule `MaintenancePage` follows.
   */
  useEffect(() => {
    setForm(toForm(config));
  }, [config]);

  const update = <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const isDirty = JSON.stringify(form) !== JSON.stringify(toForm(config));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite) return;
    // The WHOLE form is sent, not a diff. The endpoint takes a partial body, so
    // a diff would work — but a diff computed in the browser is a second source
    // of truth about what changed, and a policy half-applied because one field
    // was thought unchanged is worse than a redundant field on the wire.
    const ok = await onSave(form);
    if (ok) onSaved('Backup policy saved');
  };

  const disabled = !canWrite || isSaving;

  return (
    <Paper sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
      <Typography variant="h6" gutterBottom>
        Schedule and retention
      </Typography>

      {saveError && (
        <Alert severity="error" sx={{ mb: 2 }} data-testid="db-backup-config-error">
          {saveError}
        </Alert>
      )}

      <Box component="form" onSubmit={handleSubmit} noValidate>
        <FormControlLabel
          control={
            <Switch
              checked={form.enabled}
              onChange={(event) => update('enabled', event.target.checked)}
              disabled={disabled}
              slotProps={{ input: { 'aria-label': 'Scheduled backups' } }}
            />
          }
          label="Take a backup on a schedule"
        />

        <Grid container spacing={2} sx={{ mt: 1 }}>
          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <TextField
              select
              fullWidth
              label="Frequency"
              value={form.frequency}
              onChange={(event) => update('frequency', event.target.value as DbBackupFrequency)}
              disabled={disabled}
            >
              {DB_BACKUP_FREQUENCIES.map((value) => (
                <MenuItem key={value} value={value}>
                  {FREQUENCY_LABELS[value]}
                </MenuItem>
              ))}
            </TextField>
          </Grid>

          {/* The day field FOLLOWS the frequency: a weekday picker above a
              "every day" schedule is a control that changes nothing, and an
              operator who sets it will reasonably believe it applied. */}
          {form.frequency === 'weekly' && (
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <TextField
                select
                fullWidth
                label="Day of the week"
                value={String(form.dayOfWeek)}
                onChange={(event) => update('dayOfWeek', Number(event.target.value))}
                disabled={disabled}
              >
                {WEEKDAYS.map((label, index) => (
                  <MenuItem key={label} value={String(index)}>
                    {label}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
          )}

          {form.frequency === 'monthly' && (
            <Grid size={{ xs: 12, sm: 6, md: 4 }}>
              <TextField
                fullWidth
                type="number"
                label="Day of the month"
                value={form.dayOfMonth}
                onChange={(event) => update('dayOfMonth', Number(event.target.value))}
                disabled={disabled}
                slotProps={{ htmlInput: { min: 1, max: 28 } }}
                // 28 is the API's ceiling, and the reason is worth stating: a
                // 31st that only exists in seven months would silently skip the
                // others.
                helperText="1–28, so every month has the day"
              />
            </Grid>
          )}

          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <TextField
              fullWidth
              label="Time of day"
              value={form.timeOfDay}
              onChange={(event) => update('timeOfDay', event.target.value)}
              disabled={disabled}
              placeholder="02:30"
              helperText="24-hour HH:mm, in the timezone below"
            />
          </Grid>

          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <TextField
              fullWidth
              label="Timezone"
              value={form.timezone}
              onChange={(event) => update('timezone', event.target.value)}
              disabled={disabled}
              placeholder="UTC"
              // No client-side validation, deliberately — see the file header.
              helperText="An IANA zone name, for example Europe/London"
            />
          </Grid>

          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <TextField
              fullWidth
              type="number"
              label="Backups to keep"
              value={form.retentionCount}
              onChange={(event) => update('retentionCount', Number(event.target.value))}
              disabled={disabled}
              slotProps={{ htmlInput: { min: 1, max: 365 } }}
              helperText="Older archives are deleted after a successful backup"
            />
          </Grid>

          <Grid size={{ xs: 12, sm: 6, md: 4 }}>
            <TextField
              fullWidth
              type="number"
              label="Compression level"
              value={form.compressionLevel}
              onChange={(event) => update('compressionLevel', Number(event.target.value))}
              disabled={disabled}
              slotProps={{ htmlInput: { min: 0, max: 9 } }}
              helperText="0 is no compression, 9 is the smallest and slowest"
            />
          </Grid>
        </Grid>

        <Divider sx={{ my: 3 }} />

        <Typography variant="subtitle1" gutterBottom>
          After a restore
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          A restore swaps the database it restored into place. What happens to the one it
          replaces decides what rolling back costs.
        </Typography>

        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 8 }}>
            <TextField
              select
              fullWidth
              label="Rollback mode"
              value={form.restoreRollbackMode}
              onChange={(event) =>
                update('restoreRollbackMode', event.target.value as RestoreRollbackMode)
              }
              disabled={disabled}
            >
              {RESTORE_ROLLBACK_MODES.map((value) => (
                <MenuItem key={value} value={value}>
                  {ROLLBACK_MODE_LABELS[value]}
                </MenuItem>
              ))}
            </TextField>
          </Grid>

          <Grid size={{ xs: 12, md: 4 }}>
            <TextField
              fullWidth
              type="number"
              label="Keep the replaced database for (hours)"
              value={form.oldDatabaseRetentionHours}
              onChange={(event) =>
                update('oldDatabaseRetentionHours', Number(event.target.value))
              }
              disabled={disabled || form.restoreRollbackMode !== 'retain_database'}
              slotProps={{ htmlInput: { min: 1, max: 8760 } }}
              helperText="Costs roughly double the database volume until it is dropped"
            />
          </Grid>
        </Grid>

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ mt: 3, alignItems: { sm: 'center' } }}
        >
          <Button type="submit" variant="contained" disabled={disabled || !isDirty}>
            {isSaving ? 'Saving...' : 'Save Changes'}
          </Button>

          {/* THE SERVER'S OWN PROJECTION — see the file header. Rendered beside
              the save button so the answer to "did I get the schedule right"
              lands where the question is asked. */}
          <Typography variant="body2" color="text.secondary" data-testid="db-backup-next-run">
            {config.nextRunAt
              ? `Next scheduled backup: ${new Date(config.nextRunAt).toLocaleString()}`
              : 'No backup is scheduled.'}
          </Typography>
        </Stack>
      </Box>
    </Paper>
  );
}
