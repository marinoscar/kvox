---
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-web": minor
---

The GitHub Copilot settings UI, shared by every host (#631). `@marinoscar/kvox-contract/copilot`: `CopilotSettingsSchema`, `CopilotStatusSchema`, `CopilotSignInChallengeSchema`, `COPILOT_CONSENT_VERSION` and `COPILOT_DEFAULT_SETTINGS`. `@marinoscar/kvox-web/copilot/headless`: `useCopilotProvider` over a `CopilotProviderPort`, the consent text as data (`COPILOT_CONSENT_COPY`) and the capability rows. `@marinoscar/kvox-web/copilot/ui`: `CopilotProviderCard`, built on `AccountSignInProviderCard` of `@marinoscar/platform-web/ai/ui` (now an optional peer of that one entry): a versioned consent dialog that saves nothing until accepted, runtime download with progress and Cancel, device-code or browser sign-in with expiry, the model choice and the list of features that run on Copilot (Ask shown unavailable). The card makes no network call.
