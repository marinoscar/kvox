---
"@marinoscar/kvox-api": minor
---

Add the optional `KVOX_WEBHOOKS` port (`emit(eventKey, data, { orgId, userId })`, a no-op when unbound; `KvoxPortBindings.webhooks`, `NOOP_KVOX_WEBHOOKS`, `createRecordingKvoxWebhooks`) and `@marinoscar/kvox-api/webhooks` (marinoscar/kvox#795): `KVOX_WEBHOOK_EVENTS` (`kvox.graph.proposal_drafted`, `kvox.graph.committed`, `kvox.notes.import_batch_settled`, `kvox.transcripts.speakers_identified`, ids and counts only, strict zod payloads) and `KvoxWebhooksModule.forRoot`, whose listeners only enqueue the server-only `kvox.webhook_emit` job that publishes through the port. `graph.changed` for a proposal commit now also carries `proposalId` and `counts` (additive).
