import type { ExecutionContext } from '@nestjs/common';

import type { KvoxIdentityPort, KvoxPrincipal } from '@marinoscar/kvox-api/ports';

// =============================================================================
// LocalSingleUserIdentity: KVOX_IDENTITY for a host with exactly one user
// =============================================================================
//
// What KVox Desktop takes as a starting point. There is no sign-in: the one local
// user is whoever talks to the local server. A request is that user when it
// carries `x-local-user: 1` and nobody otherwise, so the 401 path of every
// guarded route stays tested (`@KvoxAuth` answers 401 when `authenticate`
// returns `null`).
//
// THE PRINCIPAL CARRIES EVERY PERMISSION, ALWAYS. The domain routes name the
// permission they need (`transcripts:read`, `notes:write`, ...); a single-user
// host grants them all and never evaluates a role. `userId` must be a row of
// `users` and `orgId` a row of `organizations`: the domain tables reference both.
// Desktop would not rely on a header at all (a loopback server with a per-launch
// token the shell hands to its own window is the usual shape).
// =============================================================================

/** The header that makes a request the local user's. */
export const LOCAL_USER_HEADER = 'x-local-user';

/** Options of {@link LocalSingleUserIdentity}. */
export interface LocalSingleUserIdentityOptions {
  /** The seeded `users.id`. */
  userId: string;
  /** The seeded `organizations.id`. */
  orgId: string;
  /** Every permission string the user holds. */
  permissions: readonly string[];
}

/** KVOX_IDENTITY for one local user. */
export class LocalSingleUserIdentity implements KvoxIdentityPort {
  private readonly principal: KvoxPrincipal;

  constructor(options: LocalSingleUserIdentityOptions) {
    this.principal = {
      userId: options.userId,
      orgId: options.orgId,
      roles: ['local'],
      permissions: new Set(options.permissions),
    };
  }

  async authenticate(context: ExecutionContext): Promise<KvoxPrincipal | null> {
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    return request?.headers?.[LOCAL_USER_HEADER] === '1' ? this.principal : null;
  }

  async hasPermission(userId: string, permission: string): Promise<boolean> {
    return userId === this.principal.userId && this.principal.permissions.has(permission);
  }
}
