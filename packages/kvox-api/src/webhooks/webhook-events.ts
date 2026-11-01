import { z } from 'zod';

// =============================================================================
// The KVox webhook event catalog (marinoscar/kvox#795)
// =============================================================================
//
// Pure data and zod schemas: no platform import, no Nest. The host registers
// each entry with the platform's webhook registry (`registerWebhookEvent`) and
// binds `KVOX_WEBHOOKS`; the package emits through the port.
//
// ⚠ PAYLOADS CARRY IDENTIFIERS AND COUNTS ONLY. Never document, note or
// transcript content, never a name, label, alias or quote, never PersonFact
// data (a `sensitive` PersonFact never leaves the deployment). Every schema is
// `.strict()`, so a content-bearing field is rejected, not silently dropped.
//
// ⚠ APPEND, NEVER RENAME. An event key is persisted in every webhook
// subscription.
// =============================================================================

const id = z.string().min(1).max(128);
const count = z.number().int().min(0);

/**
 * The key of the `kvox.graph.proposal_drafted` webhook event.
 *
 * @stability experimental
 */
export const KVOX_WEBHOOK_GRAPH_PROPOSAL_DRAFTED = 'kvox.graph.proposal_drafted';
/**
 * The key of the `kvox.graph.committed` webhook event.
 *
 * @stability experimental
 */
export const KVOX_WEBHOOK_GRAPH_COMMITTED = 'kvox.graph.committed';
/**
 * The key of the `kvox.notes.import_batch_settled` webhook event.
 *
 * @stability experimental
 */
export const KVOX_WEBHOOK_NOTES_IMPORT_BATCH_SETTLED = 'kvox.notes.import_batch_settled';
/**
 * The key of the `kvox.transcripts.speakers_identified` webhook event.
 *
 * @stability experimental
 */
export const KVOX_WEBHOOK_TRANSCRIPTS_SPEAKERS_IDENTIFIED = 'kvox.transcripts.speakers_identified';

/**
 * Payload of `kvox.graph.proposal_drafted`: refs and a count.
 *
 * @stability experimental
 */
export const graphProposalDraftedWebhookSchema = z
  .object({
    proposalId: id,
    noteId: id,
    noteVersion: z.number().int().min(0),
    itemCount: count.describe('How many items the draft holds.'),
  })
  .strict();

/**
 * Payload of `kvox.graph.committed`: the proposal and what it changed, as counts.
 *
 * @stability experimental
 */
export const graphCommittedWebhookSchema = z
  .object({
    proposalId: id,
    entitiesCreated: count,
    relationsCreated: count,
    entitiesLinked: count,
  })
  .strict();

/**
 * Payload of `kvox.notes.import_batch_settled`: the batch and its item counts by outcome.
 *
 * @stability experimental
 */
export const notesImportBatchSettledWebhookSchema = z
  .object({
    batchId: id,
    libraryId: id.nullable(),
    counts: z
      .object({
        imported: count,
        failed: count,
        missing: count,
        skipped: count,
        other: count.describe('Items still queued or importing (zero for a settled batch).'),
      })
      .strict(),
  })
  .strict();

/**
 * Payload of `kvox.transcripts.speakers_identified`: the transcript and how many speakers changed.
 *
 * @stability experimental
 */
export const transcriptsSpeakersIdentifiedWebhookSchema = z
  .object({
    transcriptId: id,
    speakerCount: count,
  })
  .strict();

/**
 * One event of the catalog. Same shape as the platform's `registerWebhookEvent` input minus
 * `permission`, which the host adds if it wants one.
 *
 * @stability experimental
 */
export interface KvoxWebhookEventDef {
  /** The event key. Persisted; never renamed. */
  key: string;
  /** The name shown when a user picks events. */
  label: string;
  /** What triggers it. */
  description: string;
  /** The group it is listed under. */
  group: string;
  /** Whose event it is; every KVox event is the user's own. */
  audience: 'user' | 'org' | 'system';
  /** The strict schema of `data`. */
  payloadSchema: z.ZodType;
  /** A sample payload (invented ids). */
  example: unknown;
}

const ID_A = '0b6f1c1e-7a52-4b53-9f1a-2c1d8e9a0001';
const ID_B = '0b6f1c1e-7a52-4b53-9f1a-2c1d8e9a0002';
const ID_C = '0b6f1c1e-7a52-4b53-9f1a-2c1d8e9a0003';

/**
 * Every webhook event KVox publishes, in registration order.
 *
 * @stability experimental
 */
export const KVOX_WEBHOOK_EVENTS: readonly KvoxWebhookEventDef[] = Object.freeze([
  {
    key: KVOX_WEBHOOK_GRAPH_PROPOSAL_DRAFTED,
    label: 'Graph proposal drafted',
    description: 'An extraction from a note became a draft proposal awaiting review.',
    group: 'Graph',
    audience: 'user',
    payloadSchema: graphProposalDraftedWebhookSchema,
    example: { proposalId: ID_A, noteId: ID_B, noteVersion: 3, itemCount: 12 },
  },
  {
    key: KVOX_WEBHOOK_GRAPH_COMMITTED,
    label: 'Graph proposal committed',
    description: 'A proposal was committed to the knowledge graph.',
    group: 'Graph',
    audience: 'user',
    payloadSchema: graphCommittedWebhookSchema,
    example: { proposalId: ID_A, entitiesCreated: 4, relationsCreated: 6, entitiesLinked: 2 },
  },
  {
    key: KVOX_WEBHOOK_NOTES_IMPORT_BATCH_SETTLED,
    label: 'Note import batch settled',
    description: 'A batch of imported notes finished, with the count of items by outcome.',
    group: 'Notes',
    audience: 'user',
    payloadSchema: notesImportBatchSettledWebhookSchema,
    example: {
      batchId: ID_A,
      libraryId: ID_C,
      counts: { imported: 18, failed: 1, missing: 0, skipped: 3, other: 0 },
    },
  },
  {
    key: KVOX_WEBHOOK_TRANSCRIPTS_SPEAKERS_IDENTIFIED,
    label: 'Transcript speakers identified',
    description: 'Speakers of a transcript were named or renamed.',
    group: 'Transcripts',
    audience: 'user',
    payloadSchema: transcriptsSpeakersIdentifiedWebhookSchema,
    example: { transcriptId: ID_A, speakerCount: 2 },
  },
] satisfies KvoxWebhookEventDef[]);

/**
 * The catalog entry for a key, or `undefined`.
 *
 * @param key - an event key.
 */
export function findKvoxWebhookEvent(key: string): KvoxWebhookEventDef | undefined {
  return KVOX_WEBHOOK_EVENTS.find((def) => def.key === key);
}
