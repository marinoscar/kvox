---
"@marinoscar/kvox-web": minor
---

`CopilotProviderCard` takes the optional `selected` and `onDecline` props (#652), for a host that offers the choice of provider itself: with `selected` defined the card renders no enable switch, is on exactly while `selected` is true, shows the consent dialog while the consent is not current, and the dialog's Not now calls `onDecline` (hidden without one). Accepting and withdrawing the consent still call `onUpdate` as before. Without `selected` the card behaves as before. In `selected` mode the card drops the switch wording (the description is `COPILOT_PROVIDER_COPY.selectedDescription`, the accept button reads `COPILOT_CONSENT_COPY.acceptSelectedLabel`, "Agree and use GitHub Copilot", with the consent points and `COPILOT_CONSENT_VERSION` unchanged), and in both modes the model picker shows the model the host runs, the first of `status.models`, when `settings.model` is null or no longer offered.
