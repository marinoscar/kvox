# transcription

The speech-to-text provider framework, the AssemblyAI provider, the admin settings surface and the capability probe, as a Nest module a host configures with `TranscriptionModule.forRoot`.

## Purpose and scope

What the slice owns: the provider contract (`TranscriptionProvider`, its capabilities, keyterms and field descriptors), the open `TranscriptionProviderRegistry`, the built-in `AssemblyAiProvider` (built on `fetch` and `node:stream`, no vendor SDK), the `transcription` system settings namespace (declared through the settings port), the `transcription` secret purpose (declared through the secrets port), the error taxonomy (`ProviderAuthError`, `ProviderInputError`, `RateLimitError`, `isTerminalProviderError`), the normalised transcript shape, and the two controllers: `GET|PUT /api/transcription-settings`, `POST /api/transcription-settings/test`, `DELETE /api/transcription-settings/credentials/:provider`, and `GET /api/transcription/config`. It owns no table and uses no Prisma. What it does not own: the pipeline that submits audio (the transcripts slice), a second provider (a host registers one through `extraProviders`), and anything that needs the platform: the system-settings manifest entry, the credential purpose registration, the onboarding step and the Doctor check stay in the host application.

Status: experimental (issue #492). Every export carries `@stability experimental`.

### Quick start

```ts
import { TranscriptionModule } from '@marinoscar/kvox-api/transcription';

@Module({
  imports: [
    TranscriptionModule.forRoot({
      providers: { assemblyai: true },
      extraProviders: [],
      permissions: { settingsRead: 'system_settings:read', settingsWrite: 'system_settings:write', configRead: 'transcripts:read' },
    }),
  ],
})
export class KvoxModule {}
```

The host binds the settings, secrets and identity ports first (`KvoxPortsModule.forRoot`, optionally audit) and registers a global `ZodValidationPipe` from `nestjs-zod` (`{ provide: APP_PIPE, useClass: ZodValidationPipe }`): the settings controller takes its body as a DTO class and relies on it. Nothing else is needed. A test uses `createKvoxTestingModule` from `@marinoscar/kvox-api/testing`.

### Permissions and settings

- Settings: the `transcription` system namespace (`TRANSCRIPTION_SETTINGS_DEFAULTS` is its value on a fresh deployment). The slice declares it with `KVOX_SETTINGS.registerNamespace` on start-up; the web edition's adapter checks it is already in the platform registry, because the platform composes the namespace into `/api/system-settings` before the application exists. The stored shape never changed: `provider` is `null` or a registered id, `providers.<id>` holds each provider's block.
- Secrets: purpose `transcription`, name `<providerId>` (`transcriptionCredentialName`), declared with `KVOX_SECRETS.registerPurpose`. The purpose string is also the encryption domain: never rename it.
- Permissions: three strings, passed as `permissions` and defaulting to the web edition's (`DEFAULT_TRANSCRIPTION_PERMISSIONS`): `settingsRead` (`system_settings:read`, the GET), `settingsWrite` (`system_settings:write`, the PUT, the probe and the key erase) and `configRead` (`transcripts:read`, the capability probe every signed-in account may read). The controllers name the option with `KvoxAuthFromOptions('settingsRead')` and the module provides the map under `KVOX_AUTH_PERMISSIONS`. The slice declares no permission of its own.
- Provider ids are an open vocabulary. The wire schema (`transcriptionProviderIdSchema`) accepts any non-empty string and `TranscriptionSettingsService` checks it against `TranscriptionProviderRegistry.ids()` before it writes anything: an unknown id is a 400 naming the registered ids. A provider's own block (`providers.<id>`) is validated by that provider's `settingsSchema`. `TRANSCRIPTION_PROVIDER_IDS` stays the list of built-in ids.

### Security notes

The API key lives in the secrets port and nowhere else. It is read (`KVOX_SECRETS.get`) only at the moment of a provider call or a probe, handed to a provider context whose `toJSON` redacts it, and dropped; it is never logged, returned, audited or put in a span. The settings namespace carries a compile-time proof that no secret-named field exists (`TRANSCRIPTION_SETTINGS_CARRIES_NO_SECRET`). `GET` returns a masked `keyStatuses` entry per provider (`status`, never `get`). A blank `apiKey` on `PUT` keeps the stored key; the key is erased only by the `DELETE`. `testConnection` never throws, answers 200 with `ok: false` for a refused probe, and never echoes the key. A 429 becomes `RateLimitError` on `TRANSCRIPTION_THROTTLE_KEY`, the deployment's one shared bucket.

### Conformance suite

`describeTranscriptionProviderConformance(name, factory, { describe, it, expect }, { scenarios, settings })` from `@marinoscar/kvox-api/transcription/testing` checks identity and capabilities, that the admin form carries no secret field, that the context never serialises its key, that `testConnection` never throws and never echoes the key, and, for each failing upstream the caller supplies, that 401 maps to `ProviderAuthError`, 429 to `RateLimitError` (never a zero delay), a rejected input to `ProviderInputError`. `createFakeTranscriptionProvider` is a scriptable provider with a call log for the slices above this one. The AssemblyAI provider passes the kit (`src/transcription/providers/assemblyai.conformance.spec.ts`), and so does the fake (`test/transcription-fake-provider.spec.ts`).

## Entry point

`@marinoscar/kvox-api/transcription`, and `@marinoscar/kvox-api/transcription/testing` for tests. The slice depends on `ports` and `core` only (`packages/kvox-slices.json`), and imports `@marinoscar/kvox-contract/transcription` for the wire schemas.

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common`, `@nestjs/core` and `zod`, which every slice needs, plus `@nestjs/swagger` and `nestjs-zod` (optional for the package, required by this slice: the controllers' OpenAPI decorators and DTO classes). No vendor SDK: `providers/assemblyai.provider.ts` uses `fetch` and `node:stream`. The per-slice data is `packages/kvox-slice-peers.json`.

## Configuration

`TranscriptionModule.forRoot(options)` returns a non-global dynamic module that exports `TranscriptionProviderRegistry`, `TranscriptionSettingsService` and `TranscriptionConfigService`. The package reads no environment variable.

| Option | Default | What it does |
|---|---|---|
| `providers.assemblyai` | `true` | Registers the built-in AssemblyAI provider. |
| `extraProviders` | `[]` | `Type<TranscriptionProvider>[]`: classes the container builds, registered with the registry on start-up and selectable as the `provider` setting. |
| `permissions.settingsRead` / `settingsWrite` / `configRead` | `system_settings:read` / `system_settings:write` / `transcripts:read` | The strings the controllers enforce. |

The routes document themselves through `documentKvoxAuth` (called by `forRoot`): the host decides how an authenticated route is described with `setKvoxAuthDocumenter` from `core`.

## Extension-point catalog

| Symbol | What a host does with it |
|---|---|
| `TranscriptionModuleOptions.extraProviders` | Adds a provider class; it must satisfy `TranscriptionProvider` and the conformance kit. |
| `TranscriptionProvider` | The contract a provider implements: `id`, `label`, `capabilities`, `settingsSchema`, `fieldDescriptors`, `testConnection`, `submit`, `getStatus`, `fetchResult`, `deleteRemote` and, when `capabilities.cancel`, `cancel`. Every method but `testConnection` throws to fail. |
| `TRANSCRIPTION_EXTRA_PROVIDERS` | The token under which the module provides the instances of `extraProviders`. |
| `describeTranscriptionProviderConformance`, `TranscriptionConformanceOptions.scenarios` | The provider conformance kit and the failing upstreams a provider author wires in. |
| `createFakeTranscriptionProvider` | A scriptable provider for tests of the transcripts pipeline. |
