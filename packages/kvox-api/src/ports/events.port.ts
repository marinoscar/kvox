// =============================================================================
// KVOX_EVENTS: the domain-event port (issue 5.4, epic 486)
// =============================================================================
//
// In-process domain events emitted after a write commits (`graph.changed`, a
// transcript's speakers were identified). Listeners are bystanders: they decide
// whether work is due and enqueue it, they never compute inline.
//
// Names are lower-case and dotted (`graph.changed`). A payload is plain data.
// =============================================================================

/**
 * Injection token of {@link KvoxEventsPort}. The description string is
 * permanent. Optional in `KvoxPortsModule.forRoot`: the default is an
 * in-process emitter.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_EVENTS = Symbol.for('@marinoscar/kvox/KVOX_EVENTS');

/**
 * The event port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxEventsPort {
  /**
   * Publishes an event. Never throws and never waits for listeners.
   *
   * @param name - the event name.
   * @param payload - plain data.
   */
  emit(name: string, payload: unknown): void;

  /**
   * Listens for an event.
   *
   * @param name - the event name.
   * @param handler - called for each event; a throw is logged, not propagated.
   * @returns a function that removes the listener.
   */
  subscribe(name: string, handler: (payload: unknown) => Promise<void> | void): () => void;
}
