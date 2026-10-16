import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  JwtAuthGuard,
  PRINCIPAL_USER_INCLUDE,
  activeOrgIdOf,
  principalFactory,
  principalOf,
  toRequestUser,
  type AuthenticatedUser,
  type RequestWithPrincipal,
} from '@marinoscar/platform-api/identity';
import { Trace } from '@marinoscar/platform-api/otel-core';
import type { KvoxIdentityPort, KvoxPrincipal } from '@marinoscar/kvox-api/ports';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// PlatformKvoxIdentityAdapter: the `KVOX_IDENTITY` port over the platform
// identity slice (issue #490, epic #486)
// =============================================================================
//
// `authenticate` runs the platform `JwtAuthGuard` on the execution context (a bearer
// JWT, a `pat_` token; a `nod_` credential is refused there on a non-node route, as
// everywhere), then reads what the guard attached and NORMALISES it itself.
//
// ⚠ THE PERMISSIONLESS-ROUTE TRAP. The platform's `PermissionsGuard` is the code that
// attaches `request.requestUser`, and it returns early (attaching nothing) on a route
// that requires no permission. Reading `request.requestUser` here would therefore
// give a permissionless route a principal with no permissions, silently. This adapter
// derives roles and permissions from `request.principal` (set by `JwtAuthGuard`
// itself, the active organization's) and falls back to `toRequestUser(request.user)`,
// the same two sources `PermissionsGuard` consults, and never from `requestUser`.
//
// A request with no valid credential is `null`. A credential the platform refuses with
// a 403 (a node credential on a domain route) is not hidden: that exception propagates.
// =============================================================================

@Injectable()
export class PlatformKvoxIdentityAdapter implements KvoxIdentityPort {
  constructor(
    private readonly jwt: JwtAuthGuard,
    private readonly prisma: PrismaService,
  ) {}

  @Trace()
  async authenticate(context: ExecutionContext): Promise<KvoxPrincipal | null> {
    try {
      await this.jwt.canActivate(context);
    } catch (error) {
      if (error instanceof UnauthorizedException) return null;
      throw error;
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) return null;

    const requestUser = toRequestUser(user);
    if (!requestUser.isActive) return null;

    const principal = principalOf(request);

    return {
      userId: user.id,
      orgId: activeOrgIdOf(request) ?? null,
      roles: principal?.roles ?? requestUser.roles,
      permissions: new Set(principal?.permissions ?? requestUser.permissions),
    };
  }

  @Trace()
  async hasPermission(userId: string, permission: string): Promise<boolean> {
    const user = (await this.prisma.user.findUnique({
      where: { id: userId },
      include: PRINCIPAL_USER_INCLUDE,
    })) as unknown as AuthenticatedUser | null;
    if (!user || !user.isActive) return false;

    return principalFactory.access(user).permissions.includes(permission);
  }
}
