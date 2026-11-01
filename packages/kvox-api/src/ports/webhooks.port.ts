// =============================================================================
// KVOX_WEBHOOKS: the outbound-webhook port (issue marinoscar/kvox#795)
// =============================================================================
//
// Lets a host publish a small, content-free fact ("a proposal was drafted", "an
// import batch settled") to the webhooks a user or an organization configured.
// The web edition binds it over the platform webhooks slice; Desktop binds
// nothing, and an unbound port is a no-op (`NOOP_KVOX_WEBHOOKS`).
//
// WHAT CROSSES THIS PORT: identifiers and counts, never document, note or
// transcript content and never a `sensitive` PersonFact (that data never leaves
// the deployment). The catalog in `@marinoscar/kvox-api/webhooks`
// (`KVOX_WEBHOOK_EVENTS`) pins each event's payload with a strict schema.
//
// A BINDING MUST NOT DO NETWORK I/O INLINE. `emit` is allowed one database write
// (record the delivery rows, enqueue the delivery job) and nothing slower; the
// HTTP call to the subscriber belongs to a queue job. The package itself calls
// `emit` only from the `kvox.webhook_emit` job, never from an event listener.
// =============================================================================

/**
 * Injection token of {@link KvoxWebhooksPort}. The description string is
 * permanent. Optional in `KvoxPortsModule.forRoot`: the default does nothing.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_WEBHOOKS = Symbol.for('@marinoscar/kvox/KVOX_WEBHOOKS');

/**
 * Who a webhook event belongs to.
 *
 * @stability experimental
 */
export interface KvoxWebhookContext {
  /** The organization the event belongs to, or `null` when the host should resolve the user's own. */
  orgId: string | null;
  /** The user the event is about; present for every `user` audience event. */
  userId?: string;
}

/**
 * The webhook port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxWebhooksPort {
  /**
   * Publishes an event to the matching webhooks. A binding records the work and
   * returns; it does no network I/O inline.
   *
   * @param eventKey - a key of `KVOX_WEBHOOK_EVENTS` (`kvox.graph.committed`).
   * @param data - the event data: ids and counts only, validated against the catalog schema.
   * @param ctx - whose event it is.
   */
  emit(eventKey: string, data: unknown, ctx: KvoxWebhookContext): Promise<void>;
}
