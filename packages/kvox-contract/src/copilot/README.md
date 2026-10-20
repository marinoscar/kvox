# copilot

The GitHub Copilot wire contract: the user's opt-in setting, the status a host reports and the sign-in challenge.

## Purpose and scope

The shapes any host route maps (KVox Desktop: `/api/desktop/ai/copilot/*`) and the packaged card in `@marinoscar/kvox-web/copilot/ui` renders. Plain Zod schemas, `as const` tuples and inferred types only: no Node built-in, so it loads in the browser too.

- `CopilotSettingsSchema`, `COPILOT_DEFAULT_SETTINGS`: `enabled`, `consentedAt`, `consentVersion`, `model`. Off by default.
- `CopilotSettingsPatchSchema`, `CopilotSettingsPatch`: a partial update of the setting. The same four fields with the same validation, each optional and with NO default, and strict (an unknown key is refused). Parsing returns exactly the keys sent. A host validates a PATCH body with this schema, never with `CopilotSettingsSchema.partial()`: under Zod 4 a default is still applied to an optional field, so `{ model: 'gpt-4.1' }` would parse to `{ enabled: false, consentedAt: null, consentVersion: null, model: 'gpt-4.1' }`, which switches Copilot off and erases the consent.
- `COPILOT_CONSENT_VERSION`: the consent text version. Bump it when the consent wording changes so every user is asked again.
- `CopilotStatusSchema`: `enabled`, `signedIn`, `login`, `runtime` (`missing`, `downloading`, `ready`, `error`), `models`, `unavailableTasks` (`needs_tool_calling`, `needs_embeddings`). Its fields map to the outputs of `@marinoscar/kvox-ai/copilot` (`authStatus()`, `prepareCopilotRuntime`, the catalog) and to `routeKvoxTasks`.
- `CopilotSignInChallengeSchema`: `device` (code and address) or `browser` (address), the same two kinds `signIn.start()` returns.

Status: experimental (issue marinoscar/kvox#631). Every wire shape here is permanent (add, never rename).

## Entry point

`@marinoscar/kvox-contract/copilot`. The slice depends on no other slice.

## Peer dependencies

`zod`, required. The slice imports no other package.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. `COPILOT_CONSENT_VERSION` is a constant the package owns; a host does not extend it.
