# testing

In-memory fakes of every host port, and the conformance suite that proves a binding correct.

## Purpose and scope

A slice is written against ports only, so its tests need a host. This slice is that host in memory, plus the executable definition of "correct" a Desktop author runs against their adapters.

Status: experimental.

- **Fakes**: `createFakeKvoxAi({ script })` (scripted text, a structured value, chat steps, embeddings; records every call; throws any `KvoxAiError` class), `createInMemoryKvoxObjectStore()`, `createFakeKvoxJobs()` (dedup on `type` and subject while pending or running, `skipDedup`, attempts, `runAll()`), `createFakeKvoxIdentity({ principal })` with `createFakeKvoxExecutionContext`, `createRecordingKvoxNotify()`, `createInMemoryKvoxSettings()`, `createInMemoryKvoxSecrets()`, `createRecordingKvoxAudit()`, `createInMemoryKvoxEvents()`.
- **A Nest module**: `createKvoxTestingModule({ overrides })` is a `KvoxPortsModule.forRoot` with a fake on every port.
- **The conformance suite**: `describeKvoxPortsConformance(name, factory, harness)`. The factory returns the ports under test plus the few hooks the suite cannot invent (how to provoke a failure, an anonymous request, a settings namespace the host knows). It runs under Jest or Vitest: pass `{ describe, it, expect }`. `createFakeKvoxPortsUnderTest` is the factory the fakes' own run uses and a worked example.

## Entry point

`@marinoscar/kvox-api/testing`. The slice depends on `ports` and `core`.

## Peer dependencies

`@marinoscar/kvox-contract`, `rxjs` and `zod`, and the peers of `core` (it uses `KvoxPortsModule`), all required.

## Configuration

`describeKvoxPortsConformance` takes `options.skip`, the ports to leave out of the run. A port the factory omits and that is not skipped fails its section. The object-store section takes an optional `uploadParts(init, size)` hook: a store that checks its parts when an upload is sealed (a filesystem store, S3) needs the kit to PUT the bytes to the signed part URLs before `completeUpload`; the fakes accept an empty upload and leave it out.

## Extension-point catalog

None. The fakes are test doubles, not points a host implements; the conformance suite is described in the package README.

### Desktop

Desktop runs `describeKvoxPortsConformance` against its real adapters, and `createFakeKvoxPortsUnderTest` is the worked example of the factory it takes. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#prove-it-conformance).
