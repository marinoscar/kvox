# copilot

The GitHub Copilot settings UI of `@marinoscar/kvox-web`: the opt-in card with its consent, runtime download and sign-in, and the headless hook behind it.

## Purpose and scope

KVox-specific Copilot text and behaviour, written once for every host (the web app and KVox Desktop): the consent text (what is sent to GitHub, GitHub's terms, opt-in, Ask unavailable, the runtime download size), the sign-in states, the model choice and the "which features run on Copilot" list. The slice holds no server mechanics (those are `@marinoscar/kvox-ai/copilot`) and no route: the host maps a port.

- `headless/copilotCopy.ts`: `COPILOT_CONSENT_COPY`, the one place the consent wording lives, the GitHub links, `COPILOT_RUNTIME_SIZE_TEXT`, `copilotRuntimeDownloadNote` and the worded `signInReason` strings (`copilotSignInReasonText`).
- `headless/copilotCapabilities.ts`: `buildCopilotCapabilities(status)` (Notes, Knowledge extraction, Name check, Ask, and Search by meaning only while unavailable) and `hasCopilotConsent(settings)`.
- `headless/useCopilotProvider.ts`: `useCopilotProvider(port)` and the `CopilotProviderPort` type.
- `ui/CopilotProviderCard.tsx`: the card, on `AccountSignInProviderCard` of `@marinoscar/platform-web/ai/ui`; `ui/CopilotConsentBody.tsx`, `ui/CopilotSignInDialog.tsx` (device code with copy, or the browser hand-off, with expiry) and `ui/CopilotRuntimeSection.tsx` (missing, downloading with Cancel, error).

Behaviour the tests pin: nothing is saved until the user accepts the consent; accepting calls `onUpdate({ enabled: true, consentedAt, consentVersion })`; a stored `consentVersion` that differs from `COPILOT_CONSENT_VERSION` asks again; turning the switch off calls `onUpdate({ enabled: false })` and hides status and models; Ask is listed unavailable with the reason from `status.unavailableTasks`; a device code that passes `expiresAt` stops the wait and offers a new code; Sign in stays disabled, with the reason from `copilotSignInUnavailableReason` shown under it, until the runtime is `ready`; Cancel is always available while the runtime downloads, even while `onDownloadRuntime` is pending; the card makes no network call and uses no hard-coded colour.

Status: experimental (issue marinoscar/kvox#631). The consent wording is for the owner's review; changing what it says means bumping `COPILOT_CONSENT_VERSION` in the same commit.

## Entry point

- `@marinoscar/kvox-web/copilot/headless`: `useCopilotProvider`, `CopilotProviderPort`, `UseCopilotProviderOptions`, `UseCopilotProviderResult`, `COPILOT_CONSENT_COPY`, `COPILOT_TERMS_LINKS`, `COPILOT_RUNTIME_SIZE_TEXT`, `copilotRuntimeDownloadNote`, `COPILOT_SIGN_IN_REASON_TEXT`, `copilotSignInReasonText`, `copilotSignInUnavailableReason`, `buildCopilotCapabilities`, `COPILOT_UNAVAILABLE_NOTES`, `hasCopilotConsent`.
- `@marinoscar/kvox-web/copilot/ui`: `CopilotProviderCard`, `CopilotConsentBody`, `CopilotSignInDialog`, `CopilotRuntimeSection` and their props types.

The slice depends on no other slice. Wire shapes come from `@marinoscar/kvox-contract/copilot`.

## Peer dependencies

`@marinoscar/kvox-contract`, `react` and `react-dom` for the headless entry. `ui` adds `@mui/material` and `@marinoscar/platform-web` (exact version, for `AccountSignInProviderCard` and `aiErrorText` from `@marinoscar/platform-web/ai/ui`), optional peers of the package. This is the one place a `kvox-web` slice imports the platform: see [the host-neutral rule](../../../../docs/PACKAGES.md#the-host-neutral-rule).

## Configuration

`CopilotProviderCard` takes `status`, `settings`, `onUpdate`, `onSignIn`, `onWaitForSignIn`, `onSignOut` and the optional `onOpenExternal` (Desktop: `shell.openExternal` over IPC; the default is `window.open` with `noopener`, and only `https` addresses are ever opened), `allowedHosts` (the footer line "Besides this device, KVox may connect only to ..."), `onDownloadRuntime`, `onCancelRuntimeDownload` and `runtimeDownloadSize` (the exact size to state; the default is the approximation `COPILOT_RUNTIME_SIZE_TEXT`). `onWaitForSignIn` must reject when its `signal` aborts and should leave the status fresh once it resolves; `useCopilotProvider` does both for the status. `useCopilotProvider(port, { pollIntervalMs })` polls the status every second (default) while `runtime.state` is `downloading`.

`selected` and `onDecline` are for a host that offers the choice of provider itself (for example one provider among several, as KVox Desktop does): with `selected` defined the card renders no enable switch and is on exactly while `selected` is true; while it is true and the consent is not current the consent dialog opens, and its Not now calls `onDecline` (hidden without one), for example to go back to the previous provider. Accepting still calls `onUpdate({ enabled: true, consentedAt, consentVersion })` and Withdraw consent still calls `onUpdate({ enabled: false, consentedAt: null, consentVersion: null })`; the host maps both onto its own choice. With `selected` undefined the card keeps its switch and Not now turns it off (issue marinoscar/kvox#652).

The `CopilotProviderPort` is `getStatus`, `getSettings`, `update(patch)` (resolves to the stored setting), `startSignIn`, `waitForSignIn(signal)`, `signOut` and `downloadRuntime(signal)` (resolves when the download has finished).

## Extension-point catalog

- `COPILOT_CONSENT_COPY`: the consent text as data. A host with another design system renders it itself; a host may not reword it in place (it would no longer match `COPILOT_CONSENT_VERSION`).
- `CopilotProviderPort`: the host's six routes.
- `CopilotProviderCardProps.onOpenExternal`, `allowedHosts`, `onDownloadRuntime`, `onCancelRuntimeDownload`, `runtimeDownloadSize`, `selected`, `onDecline`: the optional props above.

### Desktop

This slice exists for Desktop. The renderer binds the port to its IPC and renders the card; see [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#the-opt-in-setting).
