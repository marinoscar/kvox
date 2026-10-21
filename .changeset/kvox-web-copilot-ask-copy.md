---
"@marinoscar/kvox-web": minor
"@marinoscar/kvox-contract": minor
---

The GitHub Copilot copy no longer says Ask is unavailable, since Ask now runs on Copilot (#654). `@marinoscar/kvox-contract/copilot`: `COPILOT_CONSENT_VERSION` moves from `'1'` to `'2'`, so every user who accepted the old consent text is asked again; the `COPILOT_UNAVAILABLE_REASONS` comment now says `needs_embeddings` covers search by meaning and `needs_tool_calling` only a model that cannot call tools. `@marinoscar/kvox-web/copilot`: the consent point "Ask is not available with Copilot" is replaced by "What runs on GitHub Copilot" (notes, knowledge extraction, name checks and Ask; search by meaning needs embeddings, which Copilot does not offer); the card description names Ask; the `needs_tool_calling` note in `COPILOT_UNAVAILABLE_NOTES` is now the provider-neutral "Needs a model with tool calling." with no advice to add an OpenAI key. The Ask row of `buildCopilotCapabilities` is unchanged: available unless `unavailableTasks` names `ask.respond`.
