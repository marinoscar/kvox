import type { ExecutionContext } from '@nestjs/common';

// =============================================================================
// KVOX_IDENTITY: the request-identity port (issue 5.4, epic 486)
// =============================================================================
//
// Who is calling, and what may they do. The web edition authenticates a request
// with the platform guards; Desktop has one local user.
//
// THE PORT RETURNS A NORMALISED PRINCIPAL OR `null`. A slice never reads
// permissions from a raw user object: on a route with no declared permission the
// platform guards attach no normalised user, and a slice that read one would
// silently see none (the permissionless-route trap). Only the adapter reads the
// host's own request shape.
// =============================================================================

/**
 * Injection token of {@link KvoxIdentityPort}. The description string is
 * permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_IDENTITY = Symbol.for('@marinoscar/kvox/KVOX_IDENTITY');

/**
 * The caller, as the port normalises it.
 *
 * @stability experimental
 */
export interface KvoxPrincipal {
  /** The user id. */
  userId: string;
  /** The active organization, or `null` when the credential has none. */
  orgId: string | null;
  /** The role names the caller holds. */
  roles: readonly string[];
  /** Every permission string the caller holds in the active organization. */
  permissions: ReadonlySet<string>;
}

/**
 * The identity port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxIdentityPort {
  /**
   * Authenticates the request behind a Nest execution context.
   *
   * @param context - the execution context of the request.
   * @returns the principal, or `null` when the request carries no valid credential.
   */
  authenticate(context: ExecutionContext): Promise<KvoxPrincipal | null>;

  /**
   * Whether a user holds a permission, read fresh from the host.
   *
   * @param userId - the user.
   * @param permission - a permission string.
   */
  hasPermission(userId: string, permission: string): Promise<boolean>;
}
