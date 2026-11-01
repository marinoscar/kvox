import { z } from 'zod';

/**
 * The payload of a `kvox.webhook_emit` job: which catalog event, whose it is, and the ids the
 * listener saw. The handler adds counts it reads itself, then validates the result against the
 * event's strict schema before it reaches the port.
 *
 * @stability experimental
 */
export const webhookEmitPayloadSchema = z
  .object({
    eventKey: z.string().min(1),
    userId: z.string().min(1),
    /** Identifiers and counts the event already carried. */
    refs: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  })
  .strict();

/**
 * The parsed shape of {@link webhookEmitPayloadSchema}.
 *
 * @stability experimental
 */
export type WebhookEmitPayload = z.infer<typeof webhookEmitPayloadSchema>;
