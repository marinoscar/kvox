// =============================================================================
// KVOX_AUDIT: the audit port (issue 5.4, epic 486)
// =============================================================================
//
// Audit rows for settings changes and destructive actions. Optional: a host that
// binds nothing gets a no-op. The web edition binds the platform audit sink;
// Desktop writes a local log. Record after the triggering write has committed.
// `meta` carries scalars only and never a secret.
// =============================================================================

/**
 * Injection token of {@link KvoxAuditPort}. The description string is
 * permanent. Optional in `KvoxPortsModule.forRoot`: the default does nothing.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_AUDIT = Symbol.for('@marinoscar/kvox/KVOX_AUDIT');

/**
 * One audit row.
 *
 * @stability experimental
 */
export interface KvoxAuditEvent {
  /** Who did it, or `null` for the system. */
  actorUserId: string | null;
  /** What happened (`transcript.deleted`). */
  action: string;
  /** The kind of thing it happened to. */
  targetType: string;
  /** Which one. */
  targetId: string;
  /** Scalar details. Never a secret. */
  meta?: Record<string, unknown>;
}

/**
 * The audit port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxAuditPort {
  /**
   * Records an event.
   *
   * @param e - the event.
   */
  record(e: KvoxAuditEvent): Promise<void>;
}
