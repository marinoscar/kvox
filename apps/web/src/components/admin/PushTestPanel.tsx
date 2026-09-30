/**
 * "Test & diagnostics" — a SECTION of `/admin/settings/push`, issue #449.
 *
 * Not a tab, not a route: it answers the same question as the page around it
 * ("does web push work on this deployment?"), so it lives inside it — see
 * `CLAUDE.md`'s Settings UI Pattern §2. Rendered by `PushConfigPage` right
 * after the Status panel, and only once a key pair exists.
 *
 * Everything here is PRESENTATION over `services/pushDiagnostics.ts`, which
 * owns the stepwise flow; the server decides everything that matters through
 * `POST /api/admin/push-config/test` (`push:write`, enforced by the API — the
 * disabled button below is a courtesy, not the gate).
 *
 * Built for a phone first: the admin testing Android push is holding one.
 * Everything stacks at `xs`, long values wrap (`wordBreak`), and the only
 * table (events) scrolls inside its own box.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { ChipProps } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CancelIcon from '@mui/icons-material/Cancel';
import DoNotDisturbAltIcon from '@mui/icons-material/DoNotDisturbAlt';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import RefreshIcon from '@mui/icons-material/Refresh';
import SendIcon from '@mui/icons-material/Send';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import type { PushConfigAdminView, PushTestResult } from '../../services/pushConfig';
import {
  DENIED_RECOVERY,
  STEP_ORDER,
  buildDiagnosticsReport,
  collectBrowserSnapshot,
  runPushTest,
  showLocalTestNotification,
  type BrowserSnapshot,
  type DiagnosticStep,
  type DiagnosticStepStatus,
  type LocalNotificationResult,
  type PushTestRun,
} from '../../services/pushDiagnostics';
import { requestPermissionAndSyncPush } from '../../services/pushSubscription';
import { useNotificationConfig } from '../../hooks/useNotificationConfig';
import { useIsMounted } from '../../hooks/useIsMounted';

type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

const MONO_SX = {
  fontFamily: 'monospace',
  fontSize: '0.8125rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const;

function StatusIcon({ status }: { status: DiagnosticStepStatus | CheckLevel }) {
  switch (status) {
    case 'ok':
      return <CheckCircleIcon color="success" fontSize="small" titleAccess="OK" />;
    case 'warn':
      return <WarningAmberIcon color="warning" fontSize="small" titleAccess="Warning" />;
    case 'fail':
      return <CancelIcon color="error" fontSize="small" titleAccess="Failed" />;
    case 'skipped':
      return <DoNotDisturbAltIcon color="disabled" fontSize="small" titleAccess="Skipped" />;
    case 'running':
      return <CircularProgress size={18} aria-label="Running" />;
    case 'info':
      return <InfoOutlinedIcon color="info" fontSize="small" titleAccess="Info" />;
    default:
      return <RadioButtonUncheckedIcon color="disabled" fontSize="small" titleAccess="Pending" />;
  }
}

function CheckRow({ level, primary, secondary }: { level: CheckLevel; primary: ReactNode; secondary?: ReactNode }) {
  return (
    <ListItem disableGutters sx={{ alignItems: 'flex-start', py: 0.25 }}>
      <ListItemIcon sx={{ minWidth: 32, mt: 0.5 }}>
        <StatusIcon status={level} />
      </ListItemIcon>
      <ListItemText
        primary={primary}
        secondary={secondary}
        slotProps={{ secondary: { sx: { wordBreak: 'break-word' } } }}
      />
    </ListItem>
  );
}

const PERMISSION_CHIP: Record<BrowserSnapshot['permission'], { label: string; color: ChipProps['color'] }> = {
  granted: { label: 'Allowed', color: 'success' },
  denied: { label: 'Blocked', color: 'error' },
  default: { label: 'Not asked yet', color: 'warning' },
  unsupported: { label: 'Unsupported', color: 'default' },
};

const OVERALL_CHIP: Record<PushTestResult['overall'], { label: string; color: ChipProps['color'] }> = {
  sent: { label: 'Sent', color: 'success' },
  partial: { label: 'Partially sent', color: 'warning' },
  failed: { label: 'Failed', color: 'error' },
  not_configured: { label: 'Not configured', color: 'error' },
  no_subscriptions: { label: 'No subscriptions', color: 'warning' },
};

const SUB_STATUS_COLOR: Record<string, ChipProps['color']> = {
  sent: 'success',
  failed: 'error',
  pruned: 'warning',
  skipped: 'default',
};

function boolLevel(value: boolean | null, nullLevel: CheckLevel = 'info'): CheckLevel {
  if (value === null) return nullLevel;
  return value ? 'ok' : 'fail';
}

function formatDate(value: string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** The "This browser" checklist, derived from a snapshot. */
function browserChecks(snapshot: BrowserSnapshot): Array<{ level: CheckLevel; primary: string; secondary?: string }> {
  const sw = snapshot.serviceWorker;
  const sub = snapshot.subscription;
  const checks: Array<{ level: CheckLevel; primary: string; secondary?: string }> = [
    {
      level: snapshot.isSecureContext ? 'ok' : 'fail',
      primary: 'Secure context (HTTPS)',
      secondary: snapshot.origin || undefined,
    },
    { level: snapshot.hasServiceWorkerApi ? 'ok' : 'fail', primary: 'Service Worker API' },
    { level: snapshot.hasPushManager ? 'ok' : 'fail', primary: 'Push API (PushManager)' },
    {
      level: snapshot.hasNotificationApi ? 'ok' : snapshot.isIos ? 'warn' : 'fail',
      primary: 'Notification API',
    },
    {
      level: snapshot.isIos && !snapshot.isStandalone ? 'fail' : 'info',
      primary: snapshot.isStandalone ? 'Running as an installed app' : 'Running in a browser tab',
      secondary:
        snapshot.isIos && !snapshot.isStandalone
          ? 'iOS only delivers web push to an app added to the Home Screen.'
          : undefined,
    },
    {
      level: sw.registration ? (sw.registration.activeState === 'activated' ? 'ok' : 'warn') : 'fail',
      primary: 'Service worker registered',
      secondary: sw.registration
        ? `state ${sw.registration.activeState ?? 'none'} · scope ${sw.registration.scope}${sw.registration.scriptURL ? ` · ${sw.registration.scriptURL}` : ''}`
        : 'No registration found — reload the page.',
    },
    {
      level: sw.controlled ? 'ok' : 'warn',
      primary: sw.controlled ? 'This page is controlled by the service worker' : 'This page is not controlled by the service worker',
      secondary: sw.controlled ? undefined : 'Hard-reload (or close and reopen the app) so the worker takes control.',
    },
  ];
  if (sw.registration?.waiting) {
    checks.push({
      level: 'warn',
      primary: 'A newer service worker is waiting',
      secondary: 'Accept the update prompt, or close every tab/window of this app, so it activates.',
    });
  }
  checks.push({
    level: sub.exists ? 'ok' : 'warn',
    primary: sub.exists ? 'Push subscription present' : 'No push subscription in this browser',
    secondary: sub.exists
      ? `${sub.endpointPreview ?? ''}${sub.expirationTime ? ` · expires ${new Date(sub.expirationTime).toLocaleString()}` : ''}`
      : 'Send test push creates one.',
  });
  if (sub.exists) {
    checks.push({
      level: boolLevel(sub.keyMatchesServer),
      primary:
        sub.keyMatchesServer === null
          ? 'Subscription key could not be compared'
          : sub.keyMatchesServer
            ? 'Subscription key matches the server’s public key'
            : 'Subscription key does NOT match the server’s public key',
      secondary: sub.keyMatchesServer === false ? 'Send test push re-subscribes with the current key.' : undefined,
    });
  }
  for (const error of snapshot.errors) {
    checks.push({ level: 'warn', primary: 'Probe error', secondary: error });
  }
  return checks;
}

function emptySteps(): DiagnosticStep[] {
  return [];
}

export interface PushTestPanelProps {
  config: PushConfigAdminView;
  canWrite: boolean;
}

export function PushTestPanel({ config, canWrite }: PushTestPanelProps) {
  const isMounted = useIsMounted();
  const { config: clientConfig, error: clientConfigError, refresh: refreshClientConfig } =
    useNotificationConfig();

  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [steps, setSteps] = useState<DiagnosticStep[]>(emptySteps);
  const [run, setRun] = useState<PushTestRun | null>(null);
  const [localResult, setLocalResult] = useState<LocalNotificationResult | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [copyFallback, setCopyFallback] = useState<string | null>(null);

  const publicKey = config.publicKey;

  const refreshSnapshot = useCallback(async () => {
    setIsRefreshing(true);
    const next = await collectBrowserSnapshot(publicKey);
    if (isMounted()) {
      setSnapshot(next);
      setIsRefreshing(false);
    }
  }, [publicKey, isMounted]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  // Admin view vs what every client is told by `/notifications/config`.
  const clientWarnings = useMemo(() => {
    const warnings: string[] = [];
    if (!clientConfig) return warnings;
    if (config.enabled && !clientConfig.pushEnabled) {
      warnings.push(
        'Web push is enabled here, but /api/notifications/config tells clients push is OFF, so no browser will subscribe. Check the effective configuration (an environment-level override or a stale cache).',
      );
    }
    if (clientConfig.pushEnabled && clientConfig.vapidPublicKey && publicKey && clientConfig.vapidPublicKey !== publicKey) {
      warnings.push(
        'The public key clients receive from /api/notifications/config differs from the key shown above, so browsers subscribe with the wrong key and every push fails.',
      );
    }
    if (!clientConfig.browserEnabled) {
      warnings.push(
        'Browser notifications are switched off for this deployment (Admin → Notifications), which withholds non-mandatory notifications even when push works.',
      );
    }
    return warnings;
  }, [clientConfig, config.enabled, publicKey]);

  const handleAllow = async () => {
    setIsRequesting(true);
    try {
      await requestPermissionAndSyncPush(clientConfig);
    } finally {
      if (isMounted()) setIsRequesting(false);
      void refreshSnapshot();
    }
  };

  const handleSendTest = async () => {
    setIsRunning(true);
    setRun(null);
    setLocalResult(null);
    setSteps(
      STEP_ORDER.map((id) => ({ id, label: '', status: 'pending' as const, startedAt: 0, durationMs: 0 })),
    );
    const result = await runPushTest(publicKey, (step) => {
      if (!isMounted()) return;
      setSteps((current) => {
        const next = current.filter((s) => s.id !== step.id);
        next.push(step);
        return STEP_ORDER.map((id) => next.find((s) => s.id === id)).filter(
          (s): s is DiagnosticStep => !!s,
        );
      });
    });
    if (!isMounted()) return;
    setRun(result);
    setSnapshot(result.snapshot);
    setIsRunning(false);
    void refreshClientConfig();
  };

  const handleLocal = async () => {
    const result = await showLocalTestNotification();
    if (isMounted()) setLocalResult(result);
  };

  const handleCopy = async () => {
    const report = buildDiagnosticsReport({
      snapshot,
      run,
      adminConfig: {
        configured: config.configured,
        enabled: config.enabled,
        publicKey: config.publicKey,
        subject: config.subject,
      },
      clientConfig: clientConfig
        ? {
            browserEnabled: clientConfig.browserEnabled,
            pushEnabled: clientConfig.pushEnabled,
            vapidPublicKey: clientConfig.vapidPublicKey,
          }
        : null,
      localNotification: localResult,
      clientWarnings,
    });
    const text = JSON.stringify(report, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
      setCopyFallback(null);
    } catch {
      setCopyState('failed');
      setCopyFallback(text);
    }
  };

  const permission = snapshot?.permission ?? 'unsupported';
  const permissionChip = PERMISSION_CHIP[permission];
  const server = run?.server ?? null;
  const allHints = [...(server?.hints ?? []), ...(run?.hints ?? [])];

  return (
    <Paper sx={{ mt: 3, p: { xs: 2, sm: 3 } }} component="section" aria-labelledby="push-test-heading">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
        <BugReportOutlinedIcon color="action" />
        <Typography variant="h6" id="push-test-heading">
          Test & diagnostics
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Sends a real push to your own subscriptions and checks every link in the chain — this
        browser’s permission, service worker and subscription, the server’s key pair, the push
        service’s answer, and whether this device actually received it.
      </Typography>

      {clientConfigError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Could not read /api/notifications/config: {clientConfigError}
        </Alert>
      )}
      {clientWarnings.map((warning) => (
        <Alert key={warning} severity="warning" sx={{ mb: 2 }}>
          {warning}
        </Alert>
      ))}

      {/* ---------------- Permission ---------------- */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ alignItems: { xs: 'flex-start', sm: 'center' }, mb: 1 }}
      >
        <Typography variant="subtitle2">Notification permission</Typography>
        {snapshot ? (
          <Chip size="small" label={permissionChip.label} color={permissionChip.color} />
        ) : (
          <CircularProgress size={16} aria-label="Checking permission" />
        )}
        {permission === 'default' && (
          <Button
            size="small"
            variant="outlined"
            startIcon={<NotificationsActiveOutlinedIcon />}
            onClick={() => void handleAllow()}
            disabled={isRequesting || isRunning}
          >
            Allow notifications
          </Button>
        )}
      </Stack>
      {permission === 'denied' && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <AlertTitle>Notifications are blocked in this browser</AlertTitle>
          {DENIED_RECOVERY}
        </Alert>
      )}
      {snapshot?.isIos && !snapshot.isStandalone && (
        <Alert severity="info" sx={{ mb: 2 }}>
          On iPhone and iPad, web push only works for an app added to the Home Screen: tap Share →
          Add to Home Screen, then open the app from that icon and test from there.
        </Alert>
      )}

      {/* ---------------- This browser ---------------- */}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 2 }}>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          This browser
        </Typography>
        <Button
          size="small"
          startIcon={<RefreshIcon />}
          onClick={() => void refreshSnapshot()}
          disabled={isRefreshing || isRunning}
          aria-label="Refresh browser checks"
        >
          Refresh
        </Button>
      </Stack>
      {snapshot ? (
        <List dense aria-label="This browser checks" sx={{ py: 0 }}>
          {browserChecks(snapshot).map((check) => (
            <CheckRow key={check.primary} {...check} />
          ))}
        </List>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Checking this browser…
        </Typography>
      )}

      <Divider sx={{ my: 2 }} />

      {/* ---------------- Actions ---------------- */}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ flexWrap: 'wrap' }}>
        <Button
          variant="contained"
          startIcon={isRunning ? <CircularProgress size={16} color="inherit" /> : <SendIcon />}
          onClick={() => void handleSendTest()}
          disabled={!canWrite || isRunning}
        >
          {isRunning ? 'Testing…' : 'Send test push'}
        </Button>
        <Button variant="outlined" onClick={() => void handleLocal()} disabled={isRunning}>
          Show local notification
        </Button>
        <Button variant="outlined" startIcon={<ContentCopyIcon />} onClick={() => void handleCopy()}>
          {copyState === 'copied' ? 'Copied' : 'Copy diagnostics'}
        </Button>
      </Stack>
      {!canWrite && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Sending a test push needs the push:write permission. The browser checks and the local
          notification still work.
        </Typography>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
        Tip: you can lock the phone or switch apps after pressing Send — the test notification is
        shown even while this page is open.
      </Typography>

      {localResult && (
        <Alert severity={localResult.ok ? 'success' : 'error'} sx={{ mt: 2 }} onClose={() => setLocalResult(null)}>
          {localResult.ok
            ? `Local notification shown via ${localResult.via === 'service-worker' ? 'the service worker' : 'the page Notification API'}. If nothing appeared, notifications for this browser are blocked at the operating-system level (or Do Not Disturb is on).`
            : `Local notification failed${localResult.error ? `: ${localResult.error}` : ''}.`}
        </Alert>
      )}

      {copyState === 'failed' && copyFallback && (
        <Alert severity="warning" sx={{ mt: 2 }} onClose={() => setCopyState('idle')}>
          <AlertTitle>Could not copy to the clipboard</AlertTitle>
          Select and copy the report below.
          <Box component="pre" sx={{ ...MONO_SX, m: 0, mt: 1, maxHeight: 240, overflow: 'auto' }}>
            {copyFallback}
          </Box>
        </Alert>
      )}

      {/* ---------------- Run results ---------------- */}
      {steps.length > 0 && (
        <Box sx={{ mt: 3 }}>
          <Typography variant="subtitle2" gutterBottom>
            Test steps
          </Typography>
          <List dense aria-label="Test steps" sx={{ py: 0 }}>
            {steps.map((step) => (
              <ListItem key={step.id} disableGutters sx={{ alignItems: 'flex-start', py: 0.25 }}>
                <ListItemIcon sx={{ minWidth: 32, mt: 0.5 }}>
                  <StatusIcon status={step.status} />
                </ListItemIcon>
                <ListItemText
                  primary={
                    <>
                      {step.label || step.id}
                      {step.status !== 'pending' && step.status !== 'running' && step.status !== 'skipped' && (
                        <Typography component="span" variant="caption" color="text.secondary">
                          {` · ${step.durationMs} ms`}
                        </Typography>
                      )}
                    </>
                  }
                  secondary={step.detail}
                  slotProps={{ secondary: { sx: { wordBreak: 'break-word' } } }}
                />
              </ListItem>
            ))}
          </List>
        </Box>
      )}

      {run && (
        <Alert
          severity={run.ack ? (run.ack.shown ? 'success' : 'error') : 'error'}
          sx={{ mt: 2 }}
          role="status"
        >
          <AlertTitle>
            {run.ack
              ? run.ack.shown
                ? `Received by this device in ${run.ack.latencyMs} ms`
                : `Received by this device in ${run.ack.latencyMs} ms, but not displayed`
              : 'Not received by this device'}
          </AlertTitle>
          {run.ack
            ? run.ack.shown
              ? 'Web push works end to end on this device.'
              : `The operating system refused to display it${run.ack.error ? `: ${run.ack.error}` : ''}.`
            : (run.steps.find((s) => s.status === 'fail')?.detail ?? 'See the failing step above.')}
        </Alert>
      )}

      {server && <ServerResult result={server} />}

      {allHints.length > 0 && (
        <Alert severity="info" sx={{ mt: 2 }}>
          <AlertTitle>Hints</AlertTitle>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {allHints.map((hint) => (
              <li key={hint}>
                <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                  {hint}
                </Typography>
              </li>
            ))}
          </Box>
        </Alert>
      )}
    </Paper>
  );
}

function ServerResult({ result }: { result: PushTestResult }) {
  const overall = OVERALL_CHIP[result.overall] ?? { label: result.overall, color: 'default' as const };
  const cfg = result.config;
  return (
    <Box sx={{ mt: 3 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Typography variant="subtitle2">Server result</Typography>
        <Chip size="small" label={overall.label} color={overall.color} />
        <Typography variant="caption" color="text.secondary">
          {formatDate(result.ranAt)} · {result.durationMs} ms
        </Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ ...MONO_SX, mt: 0.5 }}>
        {result.testId}
      </Typography>

      <Typography variant="subtitle2" sx={{ mt: 2 }}>
        Server configuration
      </Typography>
      <List dense aria-label="Server configuration checks" sx={{ py: 0 }}>
        <CheckRow
          level={cfg.active ? 'ok' : 'fail'}
          primary={cfg.active ? 'Push is active' : 'Push is not active'}
          secondary={`source: ${cfg.source} · enabled: ${cfg.enabled === null ? 'n/a' : String(cfg.enabled)}`}
        />
        <CheckRow
          level={cfg.publicKeyValid ? 'ok' : 'fail'}
          primary={cfg.publicKeyValid ? 'Public key is a valid P-256 key' : 'Public key is invalid'}
        />
        <CheckRow
          level={boolLevel(cfg.privateKeyMatchesPublicKey, 'warn')}
          primary={
            cfg.privateKeyMatchesPublicKey === null
              ? 'Key pair could not be verified'
              : cfg.privateKeyMatchesPublicKey
                ? 'Private key matches the public key'
                : 'Private key does NOT match the public key'
          }
        />
        <CheckRow
          level={cfg.subjectValid ? 'ok' : 'fail'}
          primary={cfg.subjectValid ? 'Subject is valid' : 'Subject is invalid'}
          secondary={cfg.subject ?? 'not set'}
        />
        <CheckRow
          level={boolLevel(result.browser.endpointRegistered)}
          primary={
            result.browser.endpointRegistered === null
              ? 'This browser’s endpoint was not checked'
              : result.browser.endpointRegistered
                ? 'This browser’s subscription is registered on the server'
                : 'This browser’s subscription is NOT registered on the server'
          }
        />
        <CheckRow
          level={boolLevel(result.browser.keyMatchesServer)}
          primary={
            result.browser.keyMatchesServer === null
              ? 'This browser’s subscription key was not compared'
              : result.browser.keyMatchesServer
                ? 'This browser subscribed with the server’s current key'
                : 'This browser subscribed with a DIFFERENT key'
          }
        />
        {cfg.problems.map((problem) => (
          <CheckRow key={problem} level="fail" primary={problem} />
        ))}
      </List>

      <Typography variant="subtitle2" sx={{ mt: 2 }}>
        Subscriptions ({result.subscriptions.length})
      </Typography>
      {result.subscriptions.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          You have no push subscriptions on the server.
        </Typography>
      )}
      <Stack spacing={1.5} sx={{ mt: 1 }}>
        {result.subscriptions.map((sub) => (
          <Paper key={sub.id} variant="outlined" sx={{ p: 1.5 }} data-testid="push-test-subscription">
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
                {sub.pushService}
              </Typography>
              {sub.isThisBrowser && <Chip size="small" label="This browser" color="primary" variant="outlined" />}
              <Chip size="small" label={sub.result.status} color={SUB_STATUS_COLOR[sub.result.status] ?? 'default'} />
              {sub.result.statusCode !== null && (
                <Chip size="small" label={`HTTP ${sub.result.statusCode}`} variant="outlined" />
              )}
              <Typography variant="caption" color="text.secondary">
                {sub.result.durationMs} ms
              </Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ ...MONO_SX, mt: 0.5 }}>
              {sub.endpointPreview}
            </Typography>
            {sub.result.message && (
              <Typography variant="body2" sx={{ mt: 0.5, wordBreak: 'break-word' }}>
                {sub.result.message}
              </Typography>
            )}
            {sub.result.responseBody && (
              <Box
                component="pre"
                sx={{ ...MONO_SX, m: 0, mt: 0.5, p: 1, bgcolor: 'action.hover', borderRadius: 1, maxHeight: 160, overflow: 'auto' }}
              >
                {sub.result.responseBody}
              </Box>
            )}
            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5, wordBreak: 'break-word' }}>
              {sub.userAgent ?? 'unknown device'} · created {formatDate(sub.createdAt)} · last success{' '}
              {formatDate(sub.lastSuccessAt)} · failures {sub.failureCount}
            </Typography>
          </Paper>
        ))}
      </Stack>

      {result.events.length > 0 && (
        <>
          <Typography variant="subtitle2" sx={{ mt: 2 }}>
            Push events
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
            Whether each event may reach you by push: the admin policy and your own preference.
          </Typography>
          <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label="Push events">
              <TableHead>
                <TableRow>
                  <TableCell>Event</TableCell>
                  <TableCell align="center">Policy</TableCell>
                  <TableCell align="center">Your preference</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {result.events.map((event) => (
                  <TableRow key={event.eventKey}>
                    <TableCell sx={{ wordBreak: 'break-word' }}>
                      {event.label}
                      {event.mandatory && (
                        <Typography component="span" variant="caption" color="text.secondary">
                          {' '}
                          (mandatory)
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="center">
                      <StatusIcon status={event.policyAllows ? 'ok' : 'fail'} />
                    </TableCell>
                    <TableCell align="center">
                      <StatusIcon status={event.preferenceAllows ? 'ok' : 'fail'} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
    </Box>
  );
}

export default PushTestPanel;
