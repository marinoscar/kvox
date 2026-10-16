import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { KVOX_IDENTITY, type KvoxIdentityPort } from '../../ports/index.js';
import { KVOX_PERMISSIONS_KEY, KVOX_PRINCIPAL_REQUEST_KEY } from './kvox-auth.constants.js';

/**
 * Authenticates a request through the identity port and checks the permissions
 * `KvoxAuth` declared on the route.
 *
 * - No principal: 401.
 * - A listed permission missing from `principal.permissions`: 403.
 * - Otherwise the principal is stored on the request for `CurrentKvoxPrincipal`.
 *
 * ⚠ PERMISSIONS COME ONLY FROM THE NORMALISED PRINCIPAL. This guard never reads
 * them off a raw user object: on a route that declares no permission the host's
 * own guards attach no normalised user, and a guard that read one would see none
 * (the permissionless-route trap). The identity port normalises on its side and
 * returns a principal or `null`.
 *
 * Per-resource access (this note, that transcript) is not decided here: services
 * keep their own 404-not-403 rules.
 *
 * @stability experimental
 */
@Injectable()
export class KvoxAuthGuard implements CanActivate {
  /**
   * @param identity - the bound identity port.
   * @param reflector - reads the permissions `KvoxAuth` set.
   */
  constructor(
    @Inject(KVOX_IDENTITY) private readonly identity: KvoxIdentityPort,
    private readonly reflector: Reflector,
  ) {}

  /**
   * Admits the request or throws 401 / 403.
   *
   * @param context - the execution context of the request.
   * @returns true when the request is authenticated and holds every permission.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<string[] | undefined>(KVOX_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const principal = await this.identity.authenticate(context);
    if (principal === null) {
      throw new UnauthorizedException('Authentication is required');
    }

    const missing = required.filter((permission) => !principal.permissions.has(permission));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing permissions: ${missing.join(', ')}`);
    }

    const request = context.switchToHttp().getRequest<Record<symbol, unknown>>();
    request[KVOX_PRINCIPAL_REQUEST_KEY] = principal;

    return true;
  }
}
