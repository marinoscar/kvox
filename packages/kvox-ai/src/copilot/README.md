# copilot

`@marinoscar/kvox-ai/copilot`: the GitHub Copilot provider adapter, so KVox Desktop can run its AI features on the user's own Copilot subscription through `createDirectRuntime`.

## Purpose and scope

`createCopilotAdapter({ optIn, transport, logger?, catalog? })` returns an `AiProviderAdapter` (`id: 'copilot'`, `displayName: 'GitHub Copilot'`) with a `responses` port, plus `kvox` (what kvox-ai reads: `toolCalling: false`, `embeddings: false`, and a `KvoxModelCatalog`-shaped `catalog`) and `authStatus()`. It is a translator and nothing more: one `responses.create` or `responses.stream` call is ONE Copilot session with ONE user message, deleted when the call settles. It holds no prompt text, no retry loop, no tool loop and no KVox rule.

- **Request.** The system prompt is `instructions` then any `system`/`developer` messages, joined by a blank line, and it REPLACES the SDK's own (`systemMessage.mode: 'replace'`). The user prompt is the `input` string, or the text of exactly one `user` message. Tools, `previousResponseId`, assistant or tool items, reasoning items, more than one user message and image or file parts are refused with `AI_CAPABILITY_UNSUPPORTED` before a session is created. `maxOutputTokens` and `temperature` are not sent (the SDK has no per-call setting for either on Copilot-hosted models); `providerOptions` is ignored. Effort `minimal` is sent as `low`.
- **Structured output.** For a `native` model (`copilotStructuredOutputMode`: the catalog's mode, else `native` for `gpt-*`/`o<n>*`, else `prompted`) the schema is sent as `responseSchema` and the answer is parsed and validated with the platform's `parseStructured` (`AI_STRUCTURED_OUTPUT_INVALID` with `details.issues`). A `length` or `content_filter` finish is returned as such, unparsed, so kvox-ai reports `truncated` or a refusal. A structured request for a `prompted` model is refused: kvox-ai never sends one, because for those models it takes its own prompted path (the schema in the prompt, one repair; see the `structured` slice).
- **Events.** `assistant.message_delta` becomes `output_text.delta`; `assistant.usage` gives the usage (`cacheReadTokens` as `cachedInputTokens`) and the finish reason; `session.idle` ends the turn with `output_item.done` and `response.completed`. `model.call_failure` and `session.error` become an `AiError` (`copilot-errors.ts`).
- **Suppressions** of SDK behaviour (not policy): the runtime's `<current_datetime>` prompt prefix (an `onUserPromptTransformed` hook hands the prompt back as written), its "please continue" turn after `length` (the session is aborted at once), and its own retries after a `model.call_failure` (aborted; kvox-ai owns retries).
- **Zero tools, enforced.** `availableTools: []`, client `mode: 'empty'`, every permission request rejected, skills, custom instructions, embedding retrieval, config discovery, the session store, extensions, canvases and MCP apps off. After `createSession` the adapter reads the session's live tool list; any tool there, or a tool event during the call (`external_tool.requested`, `permission.requested`, `tool.execution_start`, an assistant message with tool requests), aborts the call with `AI_CAPABILITY_UNSUPPORTED`.
- **Sign-in.** Every call first asks `getAuthStatus()`; not signed in is `AI_KEY_REQUIRED` ("Sign in to GitHub Copilot to use it in KVox."). `verifyKey` answers the same question without throwing; `listModels` drops models whose policy is `disabled`.

`createSdkCopilotTransport({ baseDirectory, workingDirectory, logLevel? })` is the real transport: on its first call it `require`s `@github/copilot-sdk` and builds one `CopilotClient` (`mode: 'empty'`, `useLoggedInUser: true`, `logLevel: 'none'` by default). `createCopilotMockTransport()` is a transport for tests (asynchronous SDK-shaped events, abort, model-request counting, the datetime hook, live tools for the tripwire). `redactTokens`, `copilotErrorFromData` and `copilotErrorFromThrown` are the error half; `COPILOT_CATALOG` (version `COPILOT_CATALOG_VERSION`) is a small fallback list whose numbers the live listing overrides.

Status: issue #581, Phase 2 (Ask is not offered on Copilot: `toolCalling` is `false`). Opt-in only: `createCopilotAdapter` throws unless `optIn === true`. The host passes the user's own opt-in setting, which defaults to OFF.

## Entry point

`@marinoscar/kvox-ai/copilot`. Deliberately NOT re-exported by the package root, so a host that never imports this entry never loads (or needs) the SDK.

## Peer dependencies

`@github/copilot-sdk` `^1.0.22`, an OPTIONAL peer (`peerDependenciesMeta`): only `createSdkCopilotTransport` loads it, lazily, and the adapter, the catalog, the error mapping and the mock run without it. `@marinoscar/platform-ai-providers` (`AiError`, the adapter types, `toJsonSchema`, `parseStructured`) and `zod` (types). It imports no other slice. The web edition never installs the SDK.

## Configuration

No environment variable and no settings key of its own. The host passes:

- `optIn`: the user's own opt-in to GitHub Copilot (a host setting, default off). Anything but `true` refuses to build the adapter.
- `transport`: `createSdkCopilotTransport` with `baseDirectory` (an app-private Copilot data directory, so KVox's sessions never mix with the user's Copilot CLI) and `workingDirectory` (an EMPTY directory, so no AGENTS.md, CLAUDE.md, skill or MCP configuration is discovered).
- `logger` (optional): one `info` per call (`provider`, `model`, `durationMs`, token counts, `finishReason`) and a `warn` when a cleanup step fails. Never a prompt, an answer, a schema or a token.
- `catalog` (optional): a replacement fallback catalog.

There is no key: the Copilot runtime uses the user's own sign-in. `createDirectRuntime` still asks `keys('copilot')`; answer `{ apiKey: AI_KEYLESS_API_KEY }`, which the adapter ignores. No GitHub token ever crosses this code (`gitHubToken` is never set), and every message that leaves is passed through `redactTokens` (`gh[opusr]_`, `github_pat_`, `sk-`, `Bearer`).

## Extension-point catalog

- `CopilotTransport`: the adapter's whole view of the Copilot runtime (sign-in status, model listing, session create and delete, and on a session `on`, `send`, `abort`, `disconnect`, `currentToolNames`). Typed here structurally, so TypeScript never needs the SDK's types; the real SDK satisfies it through `createSdkCopilotTransport`, and a test passes `createCopilotMockTransport`.
- `CopilotAdapterLogger`: where the per-call `info` and the cleanup `warn` go.
