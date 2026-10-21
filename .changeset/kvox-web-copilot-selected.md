---
"@marinoscar/kvox-web": minor
---

`CopilotProviderCard` takes the optional `selected` and `onDecline` props (#652), for a host that offers the choice of provider itself: with `selected` defined the card renders no enable switch, is on exactly while `selected` is true, shows the consent dialog while the consent is not current, and the dialog's Not now calls `onDecline` (hidden without one). Accepting and withdrawing the consent still call `onUpdate` as before. Without `selected` the card behaves as before.
