import Alert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { AccountSignInProviderCard, aiErrorText } from '@marinoscar/platform-web/ai/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  COPILOT_CONSENT_VERSION,
  type CopilotSettings,
  type CopilotSignInChallenge,
  type CopilotStatus,
} from '@marinoscar/kvox-contract/copilot';

import {
  COPILOT_CONSENT_COPY,
  COPILOT_RUNTIME_SIZE_TEXT,
  buildCopilotCapabilities,
  copilotSignInReasonText,
  hasCopilotConsent,
} from '../headless/index.js';
import { CopilotConsentBody } from './CopilotConsentBody.js';
import { CopilotRuntimeSection } from './CopilotRuntimeSection.js';
import { CopilotSignInDialog } from './CopilotSignInDialog.js';
import { openExternalUrl } from './openExternal.js';

/**
 * Props of {@link CopilotProviderCard}.
 *
 * @remarks
 * Everything the card does goes through these props: it makes no network call.
 * With `useCopilotProvider`, pass `status`, `settings` and the same-named
 * actions straight through.
 *
 * @stability experimental
 */
export interface CopilotProviderCardProps {
  /** What the host reports about Copilot. */
  status: CopilotStatus;
  /** The stored setting. */
  settings: CopilotSettings;
  /** Save a patch of the setting. Rejects on failure. */
  onUpdate(patch: Partial<CopilotSettings>): Promise<void>;
  /** Begin a sign-in. Rejects on failure. */
  onSignIn(): Promise<CopilotSignInChallenge>;
  /** Resolve once the user finished the sign-in; reject when `signal` aborts. The host should refresh the status afterwards. */
  onWaitForSignIn(signal: AbortSignal): Promise<void>;
  /** Sign out. Rejects on failure. */
  onSignOut(): Promise<void>;
  /** Open an `https` address (Desktop: `shell.openExternal` over IPC); the default is `window.open`. */
  onOpenExternal?(url: string): void;
  /** The hosts KVox may contact besides this device, shown in the footer. */
  allowedHosts?: readonly string[];
  /** Download the runtime; without it a missing runtime shows only the notice. */
  onDownloadRuntime?(): Promise<void>;
  /** Cancel a running runtime download. */
  onCancelRuntimeDownload?(): void;
  /** The runtime download size to state, such as `'151 MB'`; the default is an approximation. */
  runtimeDownloadSize?: string;
}

const MAX_TIMER_MS = 2_147_483_647;

const PROVIDER = {
  id: 'copilot',
  displayName: 'GitHub Copilot',
  description:
    'Run notes, knowledge extraction and name checks on your own GitHub Copilot subscription. Opt-in; off until you turn it on.',
} as const;

function asError(error: unknown, fallback: string): Error {
  return new Error(copilotSignInReasonText(error) ?? aiErrorText(error, fallback));
}

interface Flow {
  challenge: CopilotSignInChallenge;
  expired: boolean;
}

/**
 * The GitHub Copilot settings card: opt-in switch with a versioned consent
 * dialog, runtime download, device-code or browser sign-in, the signed-in
 * account, the model, and which KVox features run on Copilot.
 *
 * @remarks
 * Built on `AccountSignInProviderCard` of `@marinoscar/platform-web/ai/ui`.
 * The switch saves nothing until the user accepts the consent text; accepting
 * calls `onUpdate({ enabled: true, consentedAt, consentVersion })`. An enabled
 * setting whose `consentVersion` differs from `COPILOT_CONSENT_VERSION` shows
 * the consent again. Turning the switch off calls `onUpdate({ enabled: false })`
 * and the card hides the status and the models.
 *
 * @stability experimental
 */
export function CopilotProviderCard({
  status,
  settings,
  onUpdate,
  onSignIn,
  onWaitForSignIn,
  onSignOut,
  onOpenExternal,
  allowedHosts,
  onDownloadRuntime,
  onCancelRuntimeDownload,
  runtimeDownloadSize,
}: CopilotProviderCardProps) {
  const consented = hasCopilotConsent(settings);
  // The user flipped the switch on but has not accepted the consent yet. Nothing is saved.
  const [pendingEnable, setPendingEnable] = useState(false);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (settings.enabled) setPendingEnable(false);
  }, [settings.enabled]);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const sizeText = runtimeDownloadSize ?? COPILOT_RUNTIME_SIZE_TEXT;
  const open = useCallback((url: string) => openExternalUrl(url, onOpenExternal), [onOpenExternal]);

  // A device code stops being usable at `expiresAt`: stop waiting and offer a new one.
  const expiresAt = flow?.challenge.kind === 'device' ? flow.challenge.expiresAt : null;
  const expired = flow?.expired ?? false;
  useEffect(() => {
    if (expiresAt === null || expired) return undefined;
    const at = Date.parse(expiresAt);
    if (Number.isNaN(at)) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    // A timer longer than 2^31 - 1 ms fires at once, so wait in steps of at most that.
    const arm = () => {
      const remaining = at - Date.now();
      if (remaining <= 0) {
        controller.current?.abort();
        setFlow((current) => (current ? { ...current, expired: true } : current));
        return;
      }
      timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_MS));
    };
    arm();
    return () => clearTimeout(timer);
  }, [expiresAt, expired]);

  const runSignIn = useCallback(async () => {
    if (status.runtime.state !== 'ready') {
      throw new Error(
        status.runtime.state === 'downloading'
          ? 'Wait for the Copilot runtime to finish downloading.'
          : status.runtime.state === 'error'
            ? 'The Copilot runtime is not working. Download it again first.'
            : `Download the Copilot runtime first (${sizeText}).`,
      );
    }
    controller.current?.abort();
    let challenge: CopilotSignInChallenge;
    try {
      challenge = await onSignIn();
    } catch (error) {
      throw asError(error, 'Could not start the sign-in');
    }
    const own = new AbortController();
    controller.current = own;
    setFlow({ challenge, expired: false });
    if (challenge.kind === 'browser') open(challenge.url);
    try {
      await onWaitForSignIn(own.signal);
      setFlow(null);
    } catch (error) {
      // Cancelled by the user, or stopped because the device code expired: not an error.
      if (own.signal.aborted) return;
      setFlow(null);
      throw asError(error, 'Sign-in failed');
    } finally {
      if (controller.current === own) controller.current = null;
    }
  }, [status.runtime.state, sizeText, onSignIn, onWaitForSignIn, open]);

  const cancelSignIn = () => {
    controller.current?.abort();
    setFlow(null);
  };

  const restartSignIn = () => {
    setRestartError(null);
    setFlow(null);
    runSignIn().catch((error: unknown) => setRestartError(asError(error, 'Sign-in failed').message));
  };

  const download = async () => {
    if (!onDownloadRuntime) return;
    setDownloadError(null);
    setDownloadBusy(true);
    try {
      await onDownloadRuntime();
    } catch (error) {
      setDownloadError(aiErrorText(error, 'The Copilot runtime could not be downloaded'));
    } finally {
      setDownloadBusy(false);
    }
  };

  const footer = (
    <Stack spacing={1.5}>
      {restartError ? <Alert severity="error">{restartError}</Alert> : null}
      <CopilotRuntimeSection
        runtime={status.runtime}
        sizeText={sizeText}
        onDownload={onDownloadRuntime ? () => void download() : undefined}
        onCancel={onCancelRuntimeDownload}
        error={downloadError}
        busy={downloadBusy}
      />
      {allowedHosts && allowedHosts.length > 0 ? (
        <Typography variant="caption" color="text.secondary">
          Besides this device, KVox may connect only to {allowedHosts.join(', ')}.
        </Typography>
      ) : null}
    </Stack>
  );

  return (
    <>
      <AccountSignInProviderCard
        provider={PROVIDER}
        enabled={settings.enabled || pendingEnable}
        onEnabledChange={async (next) => {
          if (next) {
            if (consented) await onUpdate({ enabled: true });
            else setPendingEnable(true);
            return;
          }
          // "Not now" on a first consent only closes the dialog; nothing was saved.
          if (!settings.enabled) {
            setPendingEnable(false);
            return;
          }
          cancelSignIn();
          await onUpdate({ enabled: false });
        }}
        consent={{
          required: true,
          acceptedAt: consented ? settings.consentedAt : null,
          title: COPILOT_CONSENT_COPY.title,
          acceptLabel: COPILOT_CONSENT_COPY.acceptLabel,
          body: (
            <CopilotConsentBody
              showRuntimeDownload={status.runtime.state === 'missing'}
              runtimeDownloadSize={sizeText}
              onOpenExternal={onOpenExternal}
            />
          ),
          onAccept: async () => {
            await onUpdate({
              enabled: true,
              consentedAt: new Date().toISOString(),
              consentVersion: COPILOT_CONSENT_VERSION,
            });
            setPendingEnable(false);
          },
          onRevoke: async () => {
            cancelSignIn();
            await onUpdate({ enabled: false, consentedAt: null, consentVersion: null });
          },
        }}
        status={{ signedIn: status.signedIn, login: status.login }}
        onSignIn={runSignIn}
        onSignOut={onSignOut}
        capabilities={buildCopilotCapabilities(status)}
        models={status.models.map((m) => ({ id: m.id, label: m.label }))}
        model={settings.model}
        onModelChange={async (id) => {
          await onUpdate({ model: id });
        }}
        slots={{ footer }}
      />
      {flow ? (
        <CopilotSignInDialog
          challenge={flow.challenge}
          expired={flow.expired}
          onOpen={open}
          onRestart={restartSignIn}
          onCancel={cancelSignIn}
        />
      ) : null}
    </>
  );
}
