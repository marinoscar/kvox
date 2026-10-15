// =============================================================================
// "Does this user hold permission X" outside a request (issue #465, epic #462)
// =============================================================================
//
// A background job or an `@OnEvent` listener has no `request.user`, so it asks
// the database. It used to ask `user_roles -> role_permissions`, which is the
// SYSTEM-role graph only. Since the platform split roles into system roles
// (`user_roles`) and org roles (`memberships.role_id`), a Contributor or Viewer
// holds the domain permissions (`graph:write`, ...) through their MEMBERSHIP,
// and a query over `user_roles` alone answers "no" for every non-admin.
//
// So this loads the user with the platform's principal graph
// (`PRINCIPAL_USER_INCLUDE`) and converts it with `toPrincipal`, the SAME
// function the request guards use. There is exactly one definition of "what
// permissions does this user hold", and a job and a request cannot disagree.
//
// The credential kind is `session`: a job acts for its owner, not through a
// token. No active organization is passed, so the sign-in rule picks it (single
// mode: the default organization).
// =============================================================================

import type { Prisma } from '@prisma/client';
import {
  PRINCIPAL_USER_INCLUDE,
  toPrincipal,
  type AuthenticatedUser,
} from '@marinoscar/platform-api/identity';

/** A Prisma client or a transaction client: anything with `user`. */
export type PrincipalDb = Pick<Prisma.TransactionClient, 'user'>;

/**
 * Whether the ACTIVE user `userId` holds `permission` (system grants plus the
 * grants of their current organization's membership role).
 *
 * @param db - the client, or the transaction client the caller is inside.
 * @param userId - the user whose permission is checked.
 * @param permission - the exact permission string (`graph:write`).
 * @returns `false` for an unknown or deactivated user.
 */
export async function activeUserHoldsPermission(
  db: PrincipalDb,
  userId: string,
  permission: string,
): Promise<boolean> {
  const user = await db.user.findFirst({
    where: { id: userId, isActive: true },
    include: PRINCIPAL_USER_INCLUDE,
  });

  if (!user) return false;

  return toPrincipal(user as unknown as AuthenticatedUser, 'session').permissions.includes(
    permission,
  );
}
