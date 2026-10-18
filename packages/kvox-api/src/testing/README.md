# testing

In-memory fakes of every host port, and the conformance suite that proves a binding correct.

## Purpose and scope

A slice is written against ports only, so its tests need a host. This slice is that host in memory, plus the executable definition of "correct" a Desktop author runs against their adapters.

Status: experimental.

- **Fakes**: `createFakeKvoxAi({ script })` (scripted text, a structured value, chat steps, embeddings; records every call; throws any `KvoxAiError` class), `createInMemoryKvoxObjectStore()`, `createFakeKvoxJobs()` (dedup on `type` and subject while pending or running, `skipDedup`, attempts, `runAll()`), `createFakeKvoxIdentity({ principal })` with `createFakeKvoxExecutionContext`, `createRecordingKvoxNotify()`, `createInMemoryKvoxSettings()`, `createInMemoryKvoxSecrets()`, `createRecordingKvoxAudit()`, `createInMemoryKvoxEvents()`.
- **Scenario model** (#586, moved from the bare host so no host copies prompt-reading code): `createScenarioKvoxAi({ noteText, meetings })` is `createFakeKvoxAi` with a structured-output router and a conversation-driven Ask chat over a host's `KvoxScenarioMeeting[]` (`{ title, people: { label, quote, attended }[], relations: { type, from, to, quote }[], commitments: { owner, counterparty, title, statement, status, quote }[] }`). Its two pure halves serve a host whose mock sits at the HTTP level: `scenarioStructuredAnswer(schemaName, user, meetings)` answers `kg_extraction` (from the meeting the prompt's `Title:` names, cited by the prompt's `s#` lines whatever the speaker label, known people by their `k#`, ATTENDED only for `attended: true`), `kg_adjudication`, `kg_item_adjudication` and `entity_digest`, and `undefined` for anything else; `nextAskMove(messages, toolChoice)` returns the next `{ tool, args }` or `{ answer }` of the two reference questions ("action items from <name>": search, list_commitments; "meetings with <name>'s boss": search, neighbors over `REPORTS_TO`, timeline of the boss, citing the relation — a meeting quote or a "Set by hand" manual citation — and each meeting). Its reading of the real extraction prompt is pinned by `graph-extraction/extraction/scenario-ai.spec.ts`.
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
