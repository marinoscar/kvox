import { type ExecutionContext, UnauthorizedException, createParamDecorator } from '@nestjs/common';

import type { KvoxPrincipal } from '../../ports/index.js';
import { KVOX_PRINCIPAL_REQUEST_KEY } from './kvox-auth.constants.js';

/**
 * The principal `KvoxAuthGuard` authenticated, as a handler parameter.
 *
 * @example
 * ```ts
 * @KvoxAuth()
 * @Get()
 * list(@CurrentKvoxPrincipal() who: KvoxPrincipal) { return who.userId; }
 * ```
 *
 * @throws UnauthorizedException when the route is not behind `KvoxAuth`.
 * @stability experimental
 */
export const CurrentKvoxPrincipal: (...dataOrPipes: unknown[]) => ParameterDecorator =
  createParamDecorator((_data: unknown, context: ExecutionContext): KvoxPrincipal => {
    const request = context.switchToHttp().getRequest<Record<symbol, unknown>>();
    const principal = request[KVOX_PRINCIPAL_REQUEST_KEY] as KvoxPrincipal | undefined;
    if (!principal) {
      throw new UnauthorizedException('Authentication is required');
    }
    return principal;
  });
