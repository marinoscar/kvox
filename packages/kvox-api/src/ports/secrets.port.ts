// =============================================================================
// KVOX_SECRETS: the secrets port (issue 5.4, epic 486)
// =============================================================================
//
// The provider keys the domain itself owns (the transcription provider key). The
// web edition binds it over the platform encrypted credential store; Desktop uses
// the operating-system keychain. A user's AI key is NOT here: the AI port
// resolves it on its own side.
//
// `status` NEVER RETURNS MATERIAL. It reports whether a secret is set, a short
// hint and when it changed. Only `get`, called server-side by the code that
// spends the secret, returns the value.
// =============================================================================

/**
 * Injection token of {@link KvoxSecretsPort}. The description string is
 * permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_SECRETS = Symbol.for('@marinoscar/kvox/KVOX_SECRETS');

/**
 * What is known about a stored secret without revealing it.
 *
 * @stability experimental
 */
export interface KvoxSecretStatus {
  /** True when a value is stored. */
  configured: boolean;
  /** A short non-reversible hint (for example the last four characters), or `null`. */
  hint: string | null;
  /** When the value last changed (ISO 8601), or `null`. */
  updatedAt: string | null;
}

/**
 * The secrets port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxSecretsPort {
  /**
   * Declares a purpose a secret may be stored under. A purpose is also its
   * encryption domain: never rename one.
   *
   * @param purpose - the purpose id.
   * @param label - what the secret is, for the admin screens.
   */
  registerPurpose(purpose: string, label: string): void;

  /**
   * The secret's value, or `null` when none is stored. Server-side use only.
   *
   * @param purpose - the purpose id.
   * @param name - the secret's name within the purpose.
   */
  get(purpose: string, name: string): Promise<string | null>;

  /**
   * Stores or replaces a secret.
   *
   * @param purpose - the purpose id.
   * @param name - the secret's name within the purpose.
   * @param value - the secret.
   * @param actorUserId - who changed it.
   */
  set(purpose: string, name: string, value: string, actorUserId: string): Promise<void>;

  /**
   * Removes a secret. Idempotent.
   *
   * @param purpose - the purpose id.
   * @param name - the secret's name within the purpose.
   * @param actorUserId - who removed it.
   */
  delete(purpose: string, name: string, actorUserId: string): Promise<void>;

  /**
   * Whether a secret is stored, without revealing it.
   *
   * @param purpose - the purpose id.
   * @param name - the secret's name within the purpose.
   */
  status(purpose: string, name: string): Promise<KvoxSecretStatus>;
}
