---
'@marinoscar/kvox-api': minor
'@marinoscar/kvox-contract': minor
---

Add `@marinoscar/kvox-api/transcription` and `/transcription/testing`: `TranscriptionModule.forRoot` (the provider registry, the AssemblyAI provider, the `transcription` settings namespace and secret purpose, and the admin settings and capability controllers) over the settings, secrets, identity and audit ports, with an open provider id vocabulary (`extraProviders`), configurable permission strings, a provider conformance kit and a scriptable fake provider. `core` gains `KvoxAuthFromOptions`, `KVOX_AUTH_PERMISSIONS` and `documentKvoxAuth` / `setKvoxAuthDocumenter`: `KvoxAuth` no longer attaches an OpenAPI marker itself, the owning module's `forRoot` does. `ports` gains optional members only (`readSystem` option `withUpdatedBy`, `set` option `label`, `updatedByUserId` on a secret's status, `KvoxRateLimitError` self-classification). The package gets a real-database test host (`npm run test:host:prepare`, `npm run test:db`).

`@marinoscar/kvox-contract/transcription`: the `provider` of the `transcription` settings is any non-empty string (`transcriptionProviderIdSchema`) and `providers` accepts other providers' blocks; the generated API document is unchanged.
