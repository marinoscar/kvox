// The webhooks slice of @marinoscar/kvox-api (marinoscar/kvox#795).
//
// Depends on `ports`, `graph` and `transcripts` (event names only). A host that binds
// `KVOX_WEBHOOKS` and imports `KvoxWebhooksModule.forRoot()` publishes the four events of
// `KVOX_WEBHOOK_EVENTS`; one that binds nothing publishes nothing.

export { KvoxWebhooksModule } from './webhooks.module.js';
export { KVOX_WEBHOOK_EMIT_JOB_TYPE } from './job-types.js';
export { webhookEmitPayloadSchema, type WebhookEmitPayload } from './webhook-emit.payload.js';
export { WebhookEmitHandler, KVOX_WEBHOOK_EMIT_PROFILE } from './webhook-emit.handler.js';
export { WebhookEventsListener } from './webhook-events.listener.js';
export {
  KVOX_WEBHOOK_EVENTS,
  KVOX_WEBHOOK_GRAPH_COMMITTED,
  KVOX_WEBHOOK_GRAPH_PROPOSAL_DRAFTED,
  KVOX_WEBHOOK_NOTES_IMPORT_BATCH_SETTLED,
  KVOX_WEBHOOK_TRANSCRIPTS_SPEAKERS_IDENTIFIED,
  findKvoxWebhookEvent,
  graphCommittedWebhookSchema,
  graphProposalDraftedWebhookSchema,
  notesImportBatchSettledWebhookSchema,
  transcriptsSpeakersIdentifiedWebhookSchema,
  type KvoxWebhookEventDef,
} from './webhook-events.js';
