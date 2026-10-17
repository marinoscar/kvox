import type { z } from 'zod';

// =============================================================================
// KVOX_SETTINGS: the settings port (issue 5.4, epic 486)
// =============================================================================
//
// The settings namespaces the domain owns: the system `transcription` namespace
// and the per-user `graph` preferences. The web edition binds it over the
// platform settings registries (validation, versioning, audit); Desktop keeps a
// local JSON file or table.
//
// A SECRET IS NEVER A SETTING. Provider keys go through the secrets port.
// =============================================================================

/**
 * Injection token of {@link KvoxSettingsPort}. The description string is
 * permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_SETTINGS = Symbol.for('@marinoscar/kvox/KVOX_SETTINGS');

/**
 * Declares a settings namespace.
 *
 * @stability experimental
 */
export interface KvoxSettingsNamespaceDef {
  /** `system` is deployment-wide; `user` is one value per user. */
  scope: 'system' | 'user';
  /** The namespace key. Persisted; never renamed. */
  name: string;
  /** The stored shape. */
  schema: z.ZodType;
  /** The value of a namespace nobody has written. */
  defaults: unknown;
}

/**
 * A system namespace with the version it was read at.
 *
 * @stability experimental
 */
export interface KvoxVersionedSettings<T> {
  /** The stored value, merged over the defaults. */
  value: T;
  /** The version; it rises by one on every write. */
  version: number;
  /**
   * When the namespace's row last changed (ISO 8601). Present only when the
   * read asked for it ({@link KvoxReadSystemOptions.withUpdatedBy}) and the host
   * records it.
   */
  updatedAt?: string | null;
  /** Who last changed it; present under the same conditions as `updatedAt`. */
  updatedBy?: KvoxSettingsActor | null;
}

/**
 * The user who last changed a settings namespace.
 *
 * @stability experimental
 */
export interface KvoxSettingsActor {
  /** The user's id. */
  id: string;
  /** The user's email address. */
  email: string;
}

/**
 * Options of {@link KvoxSettingsPort.readSystem}.
 *
 * @stability experimental
 */
export interface KvoxReadSystemOptions {
  /**
   * Also return who last changed the namespace and when. A host that keeps no
   * such record ignores it. Off by default: it can cost a second query, and only
   * an admin screen shows the answer.
   */
  withUpdatedBy?: boolean;
}

/**
 * The settings port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxSettingsPort {
  /**
   * Declares a namespace. Idempotent for the same declaration; call it at
   * import or start-up time, before the host composes its settings schemas.
   *
   * @param def - the declaration.
   */
  registerNamespace(def: KvoxSettingsNamespaceDef): void;

  /**
   * Reads a system namespace with its version.
   *
   * @param name - the namespace key.
   * @param options - extra facts to return with the value.
   */
  readSystem<T>(name: string, options?: KvoxReadSystemOptions): Promise<KvoxVersionedSettings<T>>;

  /**
   * Merges a patch into a system namespace.
   *
   * @param name - the namespace key.
   * @param patch - the fields to change.
   * @param ctx - the acting user, and the version the caller read (a mismatch is refused).
   */
  patchSystem<T>(
    name: string,
    patch: Partial<T>,
    ctx: { actorUserId: string; ifMatchVersion?: number },
  ): Promise<KvoxVersionedSettings<T>>;

  /**
   * Reads one user's namespace.
   *
   * @param userId - the user.
   * @param name - the namespace key.
   */
  readUser<T>(userId: string, name: string): Promise<T>;

  /**
   * Merges a patch into one user's namespace.
   *
   * @param userId - the user.
   * @param name - the namespace key.
   * @param patch - the fields to change.
   */
  patchUser<T>(userId: string, name: string, patch: Partial<T>): Promise<T>;
}
