# transcription

The transcription wire contract: the system settings blob and its patch, the provider ids, the playback and audio-delivery options and the keyterm limits.

## Purpose and scope

The transcription wire contract: the system settings blob and its patch, the provider ids, the playback and audio-delivery options and the keyterm limits. Plain Zod schemas, `as const` tuples and inferred types only: no Nest, no `nestjs-zod`, no Node built-in, so it loads in the browser too.

- `transcription-settings.ts` and `transcription-settings.schema.ts`: the `transcription` settings namespace (system value, patch, response, the no-secret compile-time checks).
- `keyterms.ts`: the keyterm limits and the pure normalisation helpers (`MAX_TRANSCRIPT_KEYTERMS`, `keytermWordCount`, `normalizeKeyterms`).

Server-only helpers stay in the API: `readKeyterms`, `clampKeytermsToCapability` and `maxKeytermsFor` read the provider capability and live in `apps/api/src/transcription/keyterms.ts`.

Status: experimental. Moved out of the API DTO files by issue 5.2 (marinoscar/kvox#488) with no change to a field name or a value; every wire shape here is permanent (add, never rename).

## Entry point

`@marinoscar/kvox-contract/transcription`. The slice depends on `errors`. Other slices are imported only through their `index.ts`.

## Peer dependencies

`zod`, required. The slice imports no other package.

## Configuration

None. The slice reads no environment variable and takes no option.

## Extension-point catalog

None. The slice exposes data shapes, not extension points.
