import { UnauthorizedException, createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { KVOX_PRINCIPAL_REQUEST_KEY } from '../core/index.js';
import type { KvoxPrincipal } from '../ports/index.js';

// =============================================================================
// The caller, as the graph services see them (issue #496, epic #491)
// =============================================================================
//
// The controllers authenticate with `KvoxAuth` and receive a `KvoxPrincipal`. The
// services were written against a request user that carried an `id` and a LIST of
// permissions, and every one of them passes exactly those two things around, so the
// controllers convert once, with {@link graphActorOf}, and the services keep their
// signatures.
// =============================================================================

/**
 * The authenticated caller of a graph operation.
 *
 * @stability experimental
 */
export interface GraphActor {
  /** The caller's user id. */
  id: string;
  /** The permissions the caller holds. */
  permissions: readonly string[];
}

/**
 * The actor behind a principal.
 *
 * @param principal - what `KvoxAuth` authenticated.
 * @returns the same caller, in the shape the services take.
 * @stability experimental
 */
export function graphActorOf(principal: KvoxPrincipal): GraphActor {
  return { id: principal.userId, permissions: [...principal.permissions] };
}

/**
 * The caller of a route behind `KvoxAuth`, as a {@link GraphActor}
 * (`@CurrentGraphActor()`), or just their id (`@CurrentGraphActor('id')`).
 *
 * @throws UnauthorizedException when the route is not behind `KvoxAuth`.
 * @stability experimental
 */
export const CurrentGraphActor: (data?: 'id') => ParameterDecorator = createParamDecorator(
  (data: 'id' | undefined, context: ExecutionContext): GraphActor | string => {
    const request = context.switchToHttp().getRequest<Record<symbol, unknown>>();
    const principal = request[KVOX_PRINCIPAL_REQUEST_KEY] as KvoxPrincipal | undefined;

    if (!principal) throw new UnauthorizedException('Authentication is required');

    const actor = graphActorOf(principal);

    return data === 'id' ? actor.id : actor;
  },
) as (data?: 'id') => ParameterDecorator;
