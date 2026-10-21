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
  COPILOT_PROVIDER_COPY,
  COPILOT_RUNTIME_SIZE_TEXT,
  buildCopilotCapabilities,
  copilotSignInReasonText,
  copilotSignInUnavailableReason,
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
  /**
   * The host's choice of provider. When defined, the card renders no enable switch (the host
   * offers the choice, for example one provider among several) and is on exactly while
   * `selected` is true. While `selected` is true and the consent is not current, the card shows
   * the consent dialog; accepting it still calls `onUpdate({ enabled: true, consentedAt,
   * consentVersion })`, and Withdraw consent still calls `onUpdate({ enabled: false,
   * consentedAt: null, consentVersion: null })`, for the host to map. Undefined (the default):
   * the card renders its own switch.
   */
  selected?: boolean;
  /**
   * What the consent dialog's Not now does when `selected` is defined, for example going back
   * to the previous provider. Without it, Not now is hidden in that mode. Ignored while
   * `selected` is undefined (Not now then turns the switch off).
   */
  onDecline?(): void | Promise<void>;
}

const MAX_TIMER_MS = 2_147_483_647;

const PROVIDER_ID = 'copilot';

/**
 * The model the host runs: the saved pick while it is offered, else the first offered model
 * (the hosts' default), else none.
 */
function effectiveModel(saved: string | null, models: CopilotStatus['models']): string | null {
  if (saved !== null && models.some((m) => m.id === saved)) return saved;
  return models[0]?.id ?? null;
}

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
 * and the card hides the status and the models. With `selected` defined the
 * host owns the choice: the card has no switch, is on while `selected` is true,
 * and Not now calls `onDecline`.
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
  selected,
  onDecline,
}: CopilotProviderCardProps) {
  const consented = hasCopilotConsent(settings);
  // The host offers the choice of provider: no switch, and `selected` decides whether the card is on.
  const hostSelects = selected !== undefined;
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

  const provider = {
    id: PROVIDER_ID,
    displayName: COPILOT_PROVIDER_COPY.displayName,
    // With the host offering the choice there is no switch, so the switch wording is dropped.
    description: hostSelects ? COPILOT_PROVIDER_COPY.selectedDescription : COPILOT_PROVIDER_COPY.description,
  };
  const sizeText = runtimeDownloadSize ?? COPILOT_RUNTIME_SIZE_TEXT;
  const signInUnavailable = copilotSignInUnavailableReason(status.runtime, sizeText);
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
    // The button is disabled while this is set; the guard stays as defence in depth.
    if (signInUnavailable !== null) throw new Error(signInUnavailable);
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
  }, [signInUnavailable, onSignIn, onWaitForSignIn, open]);

  const cancelSignIn = () => {
    controller.current?.abort();
    setFlow(null);
  };

  // The host chose another provider: stop any sign-in in progress.
  useEffect(() => {
    if (selected === false) {
      controller.current?.abort();
      setFlow(null);
    }
  }, [selected]);

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
        provider={provider}
        enabled={hostSelects ? selected : settings.enabled || pendingEnable}
        onEnabledChange={
          hostSelects
            ? undefined
            : async (next) => {
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
              }
        }
        consent={{
          required: true,
          acceptedAt: consented ? settings.consentedAt : null,
          title: COPILOT_CONSENT_COPY.title,
          acceptLabel: hostSelects ? COPILOT_CONSENT_COPY.acceptSelectedLabel : COPILOT_CONSENT_COPY.acceptLabel,
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
          onDecline:
            hostSelects && onDecline
              ? async () => {
                  await onDecline();
                }
              : undefined,
        }}
        status={{ signedIn: status.signedIn, login: status.login }}
        onSignIn={runSignIn}
        signInUnavailableReason={signInUnavailable ?? undefined}
        onSignOut={onSignOut}
        capabilities={buildCopilotCapabilities(status)}
        models={status.models.map((m) => ({ id: m.id, label: m.label }))}
        // A null or no-longer-offered pick shows the model the host actually runs.
        model={effectiveModel(settings.model, status.models)}
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
