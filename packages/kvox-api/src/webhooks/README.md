# webhooks

Publishes four KVox events to a host's outbound webhooks, through the optional `KVOX_WEBHOOKS` port.

## Purpose and scope

`KVOX_WEBHOOK_EVENTS` is pure data: key, label, description, group, audience (`user`) and a strict zod payload schema per event. `KvoxWebhooksModule.forRoot()` adds a listener that turns domain events into `kvox.webhook_emit` jobs, and the handler of that job, which makes the one `KVOX_WEBHOOKS.emit` call. No platform import. Unbound port (KVox Desktop): `emit` is a no-op.

| Event key | Source domain event | `data` |
|---|---|---|
| `kvox.graph.proposal_drafted` | `kvox.graph.proposal_drafted` | `proposalId`, `noteId`, `noteVersion`, `itemCount` |
| `kvox.graph.committed` | `graph.changed` with reason `commit` | `proposalId`, `entitiesCreated`, `relationsCreated`, `entitiesLinked` |
| `kvox.notes.import_batch_settled` | `kvox.notes.import_batch_settled` | `batchId`, `libraryId`, `counts` by outcome |
| `kvox.transcripts.speakers_identified` | `transcript.speakers_identified` | `transcriptId`, `speakerCount` |

### Rules

- Ids and counts only. Every schema is `.strict()`; a content-bearing field is rejected. A `sensitive` PersonFact never leaves the deployment.
- The listener only enqueues (`on-event-no-io`). The job reads the counts it needs (`kg_proposal_items`, `note_import_batch_items`), validates `data` against the catalog schema and calls the port. It is server-only: no `nodeResultSchema`, no `persistNodeResult`. Profile `{ maxRuntimeMs: 30000, maxAttempts: 3 }`. Job type `kvox.webhook_emit` is permanent.
- The events are raised after the triggering write committed (the producers already emit post-commit).
- A host's `emit` binding must not do network I/O inline: record the delivery and enqueue the sending job. The event keys are persisted in subscriptions; never rename one.

### Host wiring

Bind `ports.webhooks` in `KvoxPortsModule.forRoot`, import `KvoxWebhooksModule.forRoot()`, and register each `KVOX_WEBHOOK_EVENTS` entry with the host's webhook registry (adding `permission` if wanted).

## Entry point

`@marinoscar/kvox-api/webhooks`.

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common` and `zod`, all required. The slice depends on `ports`, `core`, `graph` and `transcripts` (event names only).

## Configuration

`KvoxWebhooksModule.forRoot()` takes no options and the package reads no environment variable. The host decides by binding `ports.webhooks` (`KvoxPortBindings`); with none bound the port is `NOOP_KVOX_WEBHOOKS`.

## Extension-point catalog

| Symbol | What a host does with it |
|---|---|
| `KVOX_WEBHOOKS`, `KvoxWebhooksPort` | Bind `emit` to the host's webhook service (record and enqueue; no network I/O inline). |
| `KVOX_WEBHOOK_EVENTS`, `KvoxWebhookEventDef` | Register each entry with the host's webhook event registry. |
| `KvoxWebhooksModule` | Import `forRoot()` to start the listeners and the `kvox.webhook_emit` handler. |
| `createRecordingKvoxWebhooks` | A recording port for tests (`@marinoscar/kvox-api/testing`). |
