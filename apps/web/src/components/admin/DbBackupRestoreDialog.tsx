/**
 * The restore / rollback dialog (issue #287, epic #254).
 *
 * The most destructive control in this application: one of these two buttons
 * REPLACES THE PRODUCTION DATABASE, and the other undoes that swap. Everything
 * below exists to make sure the person pressing it knows what they are about to
 * cause, in advance, in words, and cannot cause it by a stray click.
 *
 * =============================================================================
 * ONE COMPONENT FOR BOTH INTENTS, BECAUSE THEY SHARE THE SAFETY MACHINERY
 * =============================================================================
 *
 * A restore and a rollback need exactly the same three things: a plain
 * statement of the consequence, an acknowledgement of it, and a TYPED
 * CONFIRMATION LITERAL — and they both answer with a `mode` that must be
 * rendered rather than collapsed into "it worked". Two components would be two
 * copies of that machinery, and the second copy is where the acknowledgement
 * quietly stops gating the button. The intents differ only in their copy, their
 * literal, and which of the API's outcome shapes they render, so `intent`
 * selects between them and nothing else forks.
 *
 * =============================================================================
 * ⚠ THE PRE-FLIGHT DOES NOT EXIST UNTIL THE RESTORE IS REQUESTED
 * =============================================================================
 *
 * There is no dry-run endpoint, and inventing a client-side one is not
 * available: `POST runs/{id}/restore` runs the gates itself, deliberately, so
 * that no caller can reach a restore with no gates by forgetting to. The gates
 * come back on the response — on ALL THREE outcomes, `running` included.
 *
 * So "the confirm control stays disabled until the verdicts have been seen" is
 * implemented at the two points where verdicts actually exist:
 *
 *   1. THE FIRST CONFIRM is gated on the CONSEQUENCES — an explicit
 *      acknowledgement whose label states that the application will restart,
 *      plus the typed literal. That is the only information that exists at that
 *      moment, and it is the information that matters: the gates decide whether
 *      the restore is POSSIBLE, while the restart, the duration and the
 *      rollback cost decide whether it is WANTED.
 *   2. EVERY SUBSEQUENT CONFIRM — which in practice means the schema override
 *      after a `blocked` outcome — is gated on the verdicts, which are on
 *      screen by then, via a second acknowledgement that names the mismatch,
 *      AND on the literal being typed AGAIN (the field is cleared when the
 *      block arrives). Re-typing is the point: the override is a different,
 *      more dangerous request than the one that was refused, and it must not
 *      inherit the consent given to that one.
 *
 * Every gate is listed whatever its verdict — the passes too — because an
 * operator about to replace a production database should be able to see what
 * was CHECKED, not only what objected. Each carries its own action item.
 *
 * =============================================================================
 * `guided` IS A SUPPORTED PATH. IT IS NOT STYLED AS A FAILURE.
 * =============================================================================
 *
 * A capability gate failing — typically a role without `CREATEDB`, which
 * managed PostgreSQL routinely denies — is a `200` that started nothing and
 * carries a complete, paste-ready command block with real names, hosts and
 * ports, plus a runbook path. That is an ANSWER, not an error: the same restore
 * can be performed by hand with a superuser, and the block is the whole
 * deliverable. Rendering it in the error palette would tell an operator their
 * deployment is broken at the exact moment the screen is handing them the fix,
 * and the likely reaction — retrying, or filing a bug — is worse than doing
 * nothing. So it is `info`, and the copy says so.
 *
 * The `runbook` is a REPOSITORY-RELATIVE PATH (`docs/runbooks/…`), not a URL.
 * It is rendered as a path with its own copy affordance rather than as an
 * anchor: an `href` built from it would have to guess a host and a branch, and
 * a link that 404s at this moment is worse than the plain path an operator can
 * open in the checkout they are already standing in.
 *
 * =============================================================================
 * THE OVERRIDE APPLIES TO ONE GATE, AND THE UI SAYS WHICH
 * =============================================================================
 *
 * `overrideSchemaCheck` unblocks THE SCHEMA-COMPATIBILITY GATE AND NOTHING
 * ELSE — no amount of accepting makes a role without `CREATEDB` able to create
 * a database. So the override control is offered only when the API's own
 * `block.overrideParameter` names it, never as a general "force" switch, and
 * when `overrideParameter` is `null` the dialog offers no override at all
 * rather than a disabled one that implies a way through.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import {
  OVERRIDE_SCHEMA_CHECK_PARAMETER,
  RESTORE_CONFIRMATION,
  ROLLBACK_CONFIRMATION,
} from '../../services/dbBackup';
import type {
  DbBackupConfig,
  DbBackupRun,
  RestoreGate,
  RestorePreflight,
  RollbackRestoreResult,
  StartRestoreResult,
} from '../../services/dbBackup';
import { formatBytes } from '../../pages/Admin/dbBackupTable';

export type RestoreDialogIntent = 'restore' | 'rollback';

export interface DbBackupRestoreDialogProps {
  open: boolean;
  intent: RestoreDialogIntent;
  /** The archive being restored from, or whose restore is being undone. */
  run: DbBackupRun | null;
  /**
   * The saved policy, for the rollback cost stated BEFORE a restore is
   * confirmed. `null` while it has not loaded — the dialog then says the cost
   * is unknown rather than assuming the cheap one.
   */
  config: DbBackupConfig | null;
  isWorking: boolean;
  /** The last transport or API failure from the actions hook, or `null`. */
  error: string | null;
  onRestore: (
    options: { overrideSchemaCheck?: boolean },
  ) => Promise<StartRestoreResult | null>;
  onRollback: () => Promise<RollbackRestoreResult | null>;
  onClose: () => void;
}

/** The icon and palette one gate verdict is drawn in. */
const VERDICT_STYLE = {
  pass: { Icon: CheckCircleIcon, color: 'success.main' as const, label: 'Passed' },
  warning: { Icon: WarningAmberIcon, color: 'warning.main' as const, label: 'Warning' },
  block: { Icon: ErrorOutlineIcon, color: 'error.main' as const, label: 'Blocked' },
};

/**
 * Every gate the API ran, in the order it ran them, passes included.
 *
 * The verdict is carried by an icon, a colour AND a word, never by colour
 * alone: this list is read under pressure and is routinely screenshotted into
 * an incident channel.
 */
function PreflightGateList({ preflight }: { preflight: RestorePreflight }) {
  return (
    <Box data-testid="restore-preflight-gates">
      <Typography variant="subtitle2" gutterBottom>
        Pre-flight checks
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Every check that ran, including the ones that passed.
      </Typography>
      <List dense disablePadding>
        {preflight.gates.map((gate: RestoreGate) => {
          const style = VERDICT_STYLE[gate.verdict];
          const { Icon } = style;
          return (
            <ListItem
              key={gate.id}
              alignItems="flex-start"
              disableGutters
              data-testid={`restore-gate-${gate.id}`}
            >
              <ListItemIcon sx={{ minWidth: 36, mt: 0.5 }}>
                <Icon fontSize="small" sx={{ color: style.color }} />
              </ListItemIcon>
              <ListItemText
                primary={
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
                      {gate.title}
                    </Typography>
                    {/* The word, beside the icon, because colour alone is not
                        an accessible distinction. */}
                    <Chip size="small" variant="outlined" label={style.label} />
                  </Stack>
                }
                secondary={
                  <>
                    <Typography variant="body2" color="text.secondary" component="span">
                      {gate.detail}
                    </Typography>
                    {/* The action item, when there is one. A gate that passed
                        usually has nothing to do, and printing "None" on six
                        rows would bury the one that has something. */}
                    {gate.action && (
                      <Typography
                        variant="body2"
                        component="span"
                        sx={{ display: 'block', mt: 0.5 }}
                      >
                        <strong>What to do:</strong> {gate.action}
                      </Typography>
                    )}
                  </>
                }
              />
            </ListItem>
          );
        })}
      </List>
    </Box>
  );
}

/**
 * What rolling back will cost, taken from the pre-flight rather than from the
 * policy, because the two can differ.
 *
 * A `downgraded` plan is called out in its own warning: the configured
 * `retain_database` could not be honoured, so the way back is a full restore of
 * the pre-restore dump. That turns the recovery guarantee from SECONDS into
 * HOURS, and it is the single fact most likely to change the decision the
 * operator is in the middle of making.
 */
function RollbackPlanNotice({ preflight }: { preflight: RestorePreflight }) {
  const { rollback } = preflight;

  if (rollback.downgraded) {
    return (
      <Alert severity="warning" sx={{ mt: 2 }} data-testid="restore-rollback-downgraded">
        <AlertTitle>Rolling back will take hours, not seconds</AlertTitle>
        This deployment is configured to keep the displaced database so a rollback is a
        rename, but that is not possible for this restore
        {rollback.reason ? `: ${rollback.reason}` : '.'} The way back is a full restore of the
        safety backup taken just before the swap.
      </Alert>
    );
  }

  return (
    <Alert severity="info" sx={{ mt: 2 }} data-testid="restore-rollback-plan">
      {rollback.effective === 'retain_database'
        ? 'If this goes wrong, rolling back renames the displaced database back into place — seconds.'
        : 'If this goes wrong, rolling back restores the safety backup taken just before the swap — hours.'}
    </Alert>
  );
}

/** A multi-line shell block: monospace, selectable, and copied whole. */
function CopyableBlock({
  value,
  label,
  testId,
}: {
  value: string;
  label: string;
  testId: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Clipboard access denied or unavailable. The block below is still
      // complete and still selectable, which is the right fallback — the same
      // ruling `NodeCredentialRevealDialog` makes.
    }
  };

  return (
    <Box sx={{ mt: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {label}
        </Typography>
        <Tooltip title={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}>
          <IconButton size="small" onClick={() => void handleCopy()} aria-label={`Copy ${label}`}>
            {copied ? <CheckIcon fontSize="small" color="success" /> : <ContentCopyIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Stack>
      <Paper
        variant="outlined"
        sx={{
          p: 1.5,
          overflowX: 'auto',
          backgroundColor: 'action.hover',
        }}
      >
        <Typography
          component="pre"
          data-testid={testId}
          sx={{
            m: 0,
            fontFamily: 'monospace',
            fontSize: '0.8125rem',
            whiteSpace: 'pre',
          }}
        >
          {value}
        </Typography>
      </Paper>
    </Box>
  );
}

export function DbBackupRestoreDialog({
  open,
  intent,
  run,
  config,
  isWorking,
  error,
  onRestore,
  onRollback,
  onClose,
}: DbBackupRestoreDialogProps) {
  const literal = intent === 'restore' ? RESTORE_CONFIRMATION : ROLLBACK_CONFIRMATION;

  const [acknowledged, setAcknowledged] = useState(false);
  const [typed, setTyped] = useState('');
  const [overrideAccepted, setOverrideAccepted] = useState(false);
  const [restoreResult, setRestoreResult] = useState<StartRestoreResult | null>(null);
  const [rollbackResult, setRollbackResult] = useState<RollbackRestoreResult | null>(null);

  // Every opening starts from nothing. A dialog that remembered a ticked
  // acknowledgement or a typed literal from the last time it was open would let
  // a second, different archive inherit consent given for the first.
  useEffect(() => {
    if (!open) return;
    setAcknowledged(false);
    setTyped('');
    setOverrideAccepted(false);
    setRestoreResult(null);
    setRollbackResult(null);
  }, [open, run?.id, intent]);

  const typedMatches = typed.trim() === literal;

  const handleConfirm = async () => {
    if (!typedMatches) return;

    if (intent === 'rollback') {
      const result = await onRollback();
      if (result) setRollbackResult(result);
      return;
    }

    const result = await onRestore({});
    if (result) {
      setRestoreResult(result);
      // A block is a DIFFERENT request from here on: the literal must be typed
      // again, so the override cannot inherit the consent just given.
      if (result.mode === 'blocked') setTyped('');
    }
  };

  const handleOverrideConfirm = async () => {
    if (!typedMatches || !overrideAccepted) return;
    const result = await onRestore({ overrideSchemaCheck: true });
    if (result) {
      setRestoreResult(result);
      if (result.mode === 'blocked') setTyped('');
    }
  };

  const hasResult = restoreResult !== null || rollbackResult !== null;
  const blocked = restoreResult?.mode === 'blocked' ? restoreResult.block : null;
  const canOverride =
    blocked !== null &&
    blocked.overridable &&
    blocked.overrideParameter === OVERRIDE_SCHEMA_CHECK_PARAMETER;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        {intent === 'restore'
          ? 'Restore the database from this backup?'
          : 'Undo the restore performed from this backup?'}
      </DialogTitle>
      <DialogContent dividers>
        {/* A failure to GET an answer. Separate from every outcome below, all
            of which are answers. */}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* ==================================================================
            THE BRIEF — everything that is known before the request is made.
            Shown until an outcome replaces it.
            =============================================================== */}
        {!hasResult && intent === 'restore' && (
          <Stack spacing={2}>
            <Alert severity="warning">
              <AlertTitle>This replaces the live database</AlertTitle>
              Everything written since this backup was taken is lost. The archive is restored
              into a scratch database first, verified, and only then swapped into place.
            </Alert>

            {/* WHAT HAPPENS AND HOW LONG IT TAKES, stated before the
                confirmation rather than discovered while waiting. The numbers
                are the API's own: the restore itself rebuilds every index from
                the archive, and the destructive window is two catalog renames
                long. */}
            <Box data-testid="restore-phases">
              <Typography variant="subtitle2" gutterBottom>
                What will happen
              </Typography>
              <List dense disablePadding>
                <ListItem disableGutters>
                  <ListItemText
                    primary="1. Restoring — hours"
                    secondary="The archive is loaded into a new scratch database and every index is rebuilt. The application keeps serving normally throughout."
                  />
                </ListItem>
                <ListItem disableGutters>
                  <ListItemText
                    primary="2. Verifying — minutes"
                    secondary="The restored copy is checked before anything is swapped."
                  />
                </ListItem>
                <ListItem disableGutters>
                  <ListItemText
                    primary="3. Swapping — seconds"
                    secondary="Two catalog renames put the restored copy in place. This is the only destructive moment."
                  />
                </ListItem>
              </List>
            </Box>

            <Alert severity="info" data-testid="restore-restart-notice">
              <AlertTitle>The application will restart</AlertTitle>
              At the end of the swap the API exits deliberately so its connection pool can be
              rebuilt against the new database. Requests fail for a few seconds and this page
              will show the maintenance screen until it is back.
            </Alert>

            {/* The rollback cost as CONFIGURED. The pre-flight may downgrade it,
                and if it does that is shown on the outcome — but an operator
                must not have to start a restore to find out what the way back
                costs. */}
            {config && (
              <Typography variant="body2" color="text.secondary">
                {config.restoreRollbackMode === 'retain_database'
                  ? `The database this replaces will be kept for ${config.oldDatabaseRetentionHours} hours, so rolling back is a rename — seconds.`
                  : 'The database this replaces will be dropped, so rolling back means restoring the safety backup taken just before the swap — hours.'}
              </Typography>
            )}

            {run && (
              <Typography variant="body2" color="text.secondary">
                Archive: {formatBytes(run.sizeBytes)}
                {run.migrationName ? ` · schema ${run.migrationName}` : ''}
                {run.verifiedAt
                  ? ` · verified ${new Date(run.verifiedAt).toLocaleString()}`
                  : ' · never verified'}
              </Typography>
            )}
          </Stack>
        )}

        {!hasResult && intent === 'rollback' && (
          <Stack spacing={2}>
            <Alert severity="warning">
              <AlertTitle>This replaces the live database again</AlertTitle>
              Anything written since the restore completed is lost. The application will
              restart at the end, exactly as it did for the restore.
            </Alert>
            <Typography variant="body2" color="text.secondary">
              What this costs depends on whether the displaced database is still there. If it
              is, it is renamed back into place — seconds. If it has passed its retention
              window, the safety backup taken just before the swap is restored instead —
              hours. The answer comes back with the response; it is not decided here.
            </Typography>
          </Stack>
        )}

        {/* ==================================================================
            THE OUTCOME. ⚠ All three restore modes and all three rollback modes
            are a 200: the mode is the answer, not the status code.
            =============================================================== */}
        {restoreResult?.mode === 'running' && (
          <Stack spacing={2}>
            <Alert severity="success" data-testid="restore-running">
              <AlertTitle>The restore is under way</AlertTitle>
              The archive is being loaded into <code>{restoreResult.scratchDatabase}</code>. The
              application keeps serving until the swap, which will restart it. Watch the
              Restore column on this page for progress — it moves through Restoring,
              Verifying and Swapping.
            </Alert>
            <RollbackPlanNotice preflight={restoreResult.preflight} />
            <Divider />
            <PreflightGateList preflight={restoreResult.preflight} />
          </Stack>
        )}

        {restoreResult?.mode === 'guided' && (
          <Stack spacing={2}>
            {/* `info`, NOT an error — see the file header. Nothing failed; this
                deployment cannot create a database from the API's own
                connection, and the answer is the block below. */}
            <Alert severity="info" data-testid="restore-guided">
              <AlertTitle>This restore has to be run by hand</AlertTitle>
              {restoreResult.guidance.reason} Nothing has been started and nothing has
              changed. The commands below do the same restore with a role that has the
              privileges this one lacks.
            </Alert>

            <CopyableBlock
              label="Commands"
              value={restoreResult.guidance.commands}
              testId="restore-guided-commands"
            />

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Runbook
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                The full procedure, including what to do if a step fails, is in this
                repository at:
              </Typography>
              <Typography
                variant="body2"
                sx={{ fontFamily: 'monospace' }}
                data-testid="restore-guided-runbook"
              >
                {restoreResult.guidance.runbook}
              </Typography>
            </Box>

            <Divider />
            <PreflightGateList preflight={restoreResult.preflight} />
          </Stack>
        )}

        {restoreResult?.mode === 'blocked' && blocked && (
          <Stack spacing={2}>
            <Alert severity="warning" data-testid="restore-blocked">
              <AlertTitle>Refused by the {blocked.gateId.replace(/_/g, ' ')} check</AlertTitle>
              {blocked.message} Nothing has been started and nothing has changed.
            </Alert>

            {/* The two values the operator has to compare to make the call. */}
            <Paper variant="outlined" sx={{ p: 2 }} data-testid="restore-schema-mismatch">
              <Typography variant="subtitle2" gutterBottom>
                Schema
              </Typography>
              <Typography variant="body2">
                Archive: <code>{restoreResult.preflight.archiveMigration ?? 'unknown'}</code>
              </Typography>
              <Typography variant="body2">
                Live database: <code>{restoreResult.preflight.liveMigration ?? 'unknown'}</code>
              </Typography>
            </Paper>

            <PreflightGateList preflight={restoreResult.preflight} />

            {canOverride ? (
              <Box data-testid="restore-override">
                <Alert severity="warning" sx={{ mb: 1 }}>
                  <AlertTitle>Overriding accepts a schema mismatch</AlertTitle>
                  This overrides the schema-compatibility check and nothing else. The
                  application will run against data written for a different schema, which can
                  fail in ways a restore cannot undo.
                </Alert>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={overrideAccepted}
                      onChange={(event) => setOverrideAccepted(event.target.checked)}
                      slotProps={{
                        input: { 'aria-label': 'Accept the schema mismatch' },
                      }}
                    />
                  }
                  label="I have read the checks above and accept the schema mismatch"
                />
              </Box>
            ) : (
              // No override control at all rather than a disabled one: nothing
              // unblocks this gate, and a greyed-out switch would imply there is
              // a way through that has simply not been unlocked.
              <Alert severity="info">
                There is no override for this check. Resolve what it reports and try again.
              </Alert>
            )}
          </Stack>
        )}

        {rollbackResult && (
          <Alert
            severity={rollbackResult.mode === 'unavailable' ? 'info' : 'success'}
            data-testid={`rollback-${rollbackResult.mode}`}
          >
            <AlertTitle>
              {rollbackResult.mode === 'renamed'
                ? 'Rolled back — the previous database is back in place'
                : rollbackResult.mode === 'restore_started'
                  ? 'Rolling back by restoring the safety backup'
                  : 'There is nothing left to roll back to'}
            </AlertTitle>
            {/* `detail` is always present and always renderable. It is the
                API's own sentence, and it is more specific than anything this
                component could compose from the mode alone. */}
            {rollbackResult.detail}
          </Alert>
        )}

        {/* ==================================================================
            THE CONSENT CONTROLS. Present while a confirmation is still to be
            given — which is the brief, and the blocked outcome's override.
            =============================================================== */}
        {(!hasResult || canOverride) && (
          <Box sx={{ mt: 3 }}>
            <Divider sx={{ mb: 2 }} />
            {!hasResult && (
              <FormControlLabel
                control={
                  <Checkbox
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                    slotProps={{
                      input: { 'aria-label': 'Acknowledge the consequences' },
                    }}
                  />
                }
                label={
                  intent === 'restore'
                    ? 'I understand that this replaces the live database and that the application will restart'
                    : 'I understand that this replaces the live database again and that the application will restart'
                }
              />
            )}

            <TextField
              fullWidth
              sx={{ mt: 2 }}
              label={`Type ${literal} to confirm`}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              // Autocomplete off and no default: the literal exists so that a
              // retried, replayed or mis-fired action cannot reconstruct it.
              autoComplete="off"
              slotProps={{ htmlInput: { 'aria-label': `Type ${literal} to confirm` } }}
              helperText={`This must be typed exactly, in capitals. The API refuses anything else, and nothing is started.`}
            />
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{hasResult && !canOverride ? 'Close' : 'Cancel'}</Button>

        {!hasResult && (
          <Button
            variant="contained"
            color="error"
            // THREE conditions, and all three are the point: the consequence
            // acknowledged, the literal typed, and no write already in flight.
            disabled={!acknowledged || !typedMatches || isWorking}
            onClick={() => void handleConfirm()}
          >
            {intent === 'restore' ? 'Restore this backup' : 'Roll back'}
          </Button>
        )}

        {canOverride && (
          <Button
            variant="contained"
            color="error"
            // A SEPARATE acknowledgement and a RE-TYPED literal: this request is
            // not the one that was refused, and it must not inherit its consent.
            disabled={!overrideAccepted || !typedMatches || isWorking}
            onClick={() => void handleOverrideConfirm()}
          >
            Restore anyway
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
