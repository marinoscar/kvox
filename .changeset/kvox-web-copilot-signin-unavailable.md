---
"@marinoscar/kvox-web": minor
---

`CopilotProviderCard` disables Sign in, with the reason under it, until the Copilot runtime is ready, through `AccountSignInProviderCard`'s `signInUnavailableReason` (`@marinoscar/platform-web` 0.1.0-next.8); the reason is the new `copilotSignInUnavailableReason(runtime, sizeText)` of `copilot/headless`, which the sign-in guard throws too. Cancel stays enabled while the runtime downloads, even while `onDownloadRuntime` is pending (#641).
