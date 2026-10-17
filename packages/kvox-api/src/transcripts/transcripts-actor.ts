import { UnauthorizedException, createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { KVOX_PRINCIPAL_REQUEST_KEY } from '../core/index.js';
import type { KvoxPrincipal } from '../ports/index.js';
import type { KvoxTranscriptsDb } from './data/transcripts-db.js';

// =============================================================================
// The caller, as the transcript services see them (issue #493, epic #491)
// =============================================================================
//
// The controllers authenticate with `KvoxAuth` and receive a `KvoxPrincipal`
// (a user id, an organization and a SET of permissions). The services were written
// against a request user that carried an `id`, a LIST of permissions and the active
// organization, and every one of them passes exactly those three things around. So
// the controllers convert once, with {@link actorOf}, and the services keep their
// signatures.
// =============================================================================

/**
 * The authenticated caller of a transcript operation.
 *
 * @stability experimental
 */
export interface TranscriptsActor {
  /** The caller's user id. */
  id: string;
  /** The permissions the caller holds. */
  permissions: readonly string[];
  /** The caller's active organization, when the host has one. */
  activeOrgId?: string | null;
}

/**
 * The actor behind a principal.
 *
 * @param principal - what `KvoxAuth` authenticated.
 * @returns the same caller, in the shape the services take.
 * @stability experimental
 */
export function actorOf(principal: KvoxPrincipal): TranscriptsActor {
  return { id: principal.userId, permissions: [...principal.permissions], activeOrgId: principal.orgId };
}

/**
 * The organization a new transcript belongs to: the caller's active one, else
 * the host's default organization (a deployment with one organization and a caller
 * whose request carries none).
 *
 * @param db - the narrowed client.
 * @param activeOrgId - the caller's active organization, when it has one.
 * @param context - names the operation, for the error.
 * @returns the organization id.
 * @throws Error when the caller has none and the host has no default organization.
 * @stability experimental
 */
export async function resolveOrgId(
  db: Pick<KvoxTranscriptsDb, 'organization'>,
  activeOrgId: string | null | undefined,
  context: string,
): Promise<string> {
  if (typeof activeOrgId === 'string' && activeOrgId.length > 0) return activeOrgId;

  const org = await db.organization.findFirst({ where: { isDefault: true }, select: { id: true } });

  if (!org) {
    throw new Error(`${context} carries no organization and the host has no default organization to use.`);
  }

  return org.id;
}

/**
 * The caller of a route behind `KvoxAuth`, as a {@link TranscriptsActor}
 * (`@CurrentActor()`), or just their id (`@CurrentActor('id')`).
 *
 * @throws UnauthorizedException when the route is not behind `KvoxAuth`.
 * @stability experimental
 */
export const CurrentActor: (data?: 'id') => ParameterDecorator = createParamDecorator(
  (data: 'id' | undefined, context: ExecutionContext): TranscriptsActor | string => {
    const request = context.switchToHttp().getRequest<Record<symbol, unknown>>();
    const principal = request[KVOX_PRINCIPAL_REQUEST_KEY] as KvoxPrincipal | undefined;

    if (!principal) throw new UnauthorizedException('Authentication is required');

    const actor = actorOf(principal);

    return data === 'id' ? actor.id : actor;
  },
) as (data?: 'id') => ParameterDecorator;
