# direct

`createDirectRuntime`: a `KvoxAiRuntime` that calls the provider adapters directly, with a key fetched per call.

## Purpose and scope

`createDirectRuntime({ adapters, keys })` for a host with no platform AI service under it (KVox Desktop, a plain Node script, a test). Per call it asks `keys(provider)`, builds an `AiCallContext` (`apiKey`, `baseUrl`, the provider's non-secret settings, the signal, a fresh `requestId`), calls `responses.stream`, `responses.create` or `embeddings.embed`, and drops the context when the call settles. A call must name its provider and model; a missing key is `key_missing`, a provider with no adapter `not_configured`, an adapter without the port a call needs `capability`. `KvoxAiProviderKey` and `CreateDirectRuntimeOptions` are the option types.

Status: issue #579, PR 2. It records no usage and traces nothing: a host that wants either wraps it.

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

`@marinoscar/kvox-api` (`KvoxAiError`) and `@marinoscar/platform-api` (only `@marinoscar/platform-api/ai`: `AiError`, `AiProviderAdapter`, `AiCallContext`). It imports the `runtime` and `errors` slices.

## Configuration

`adapters` (provider id to `AiProviderAdapter`) and `keys` (provider id to a key, or `null`).

## Extension-point catalog

None.
