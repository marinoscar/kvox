// =============================================================================
// The managed-object delete veto (issue #469)
// =============================================================================
//
// The platform's `DELETE /api/storage/objects/:id` knows nothing of the app's
// ownership: it would delete a transcript's source audio and leave the
// transcript pointing at nothing. The platform has no seam for a veto, so the app
// installs a Fastify `onRequest` hook, from `main.ts` after `setGlobalPrefix`
// (`installManagedDeleteHook(app)`), that answers
//
//   409 { code, message, details: { reason: 'managed_by_module', module } }
//
// BEFORE the platform handler runs, when the object has a `kvox_object_ownership`
// row. The app's own deletes go through `KvoxManagedObjects.deleteManaged`, never
// through this route, so nothing legitimate is blocked.
//
// SHAPE OF THE CHECK. One indexed single-row read of the ownership table (no RLS
// on it, no network I/O to the provider), only for `DELETE <prefix>/storage/
// objects/<uuid>`. Everything else passes straight through.
//
//   * UNAUTHENTICATED CALLERS ARE NOT ANSWERED HERE. A request with neither an
//     `Authorization` header nor a cookie is passed on so the platform's guard
//     answers 401: the veto must not tell an anonymous caller which ids are
//     managed. (The hook runs before the guards.)
//   * FAILS CLOSED. When the ownership read itself fails, the delete is refused
//     with 503 rather than let through: "fail open" is only for objects known to
//     be unmanaged.
//
// The error body follows the platform's error envelope (`HttpExceptionFilter`),
// which a raw hook reply would otherwise bypass.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { defaultErrorCodeForStatus } from '@marinoscar/platform-api/core';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { PrismaService } from '../prisma/prisma.service';
import { KvoxObjectOwnershipStore, type KvoxModule } from './kvox-object-ownership.store';

/** The `details.reason` of the 409. */
export const MANAGED_BY_MODULE = 'managed_by_module';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** The object id of a `DELETE <prefix>/storage/objects/<uuid>` request, else null. */
export function managedDeleteTarget(method: string, url: string, globalPrefix = 'api'): string | null {
  if (method !== 'DELETE') return null;

  const path = url.split('?', 1)[0] ?? '';
  const prefix = globalPrefix ? `/${globalPrefix.replace(/^\/+|\/+$/g, '')}` : '';
  const match = new RegExp(`^${prefix}/storage/objects/(${UUID})/?$`).exec(path);
  return match ? (match[1] as string) : null;
}

/** The ownership lookup behind the hook: a bounded single-row read. */
@Injectable()
export class ManagedDeleteVeto {
  private readonly logger = new Logger(ManagedDeleteVeto.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: KvoxObjectOwnershipStore,
  ) {}

  /** The owning module of `objectId`, or null when it is a plain upload. */
  async ownerOf(objectId: string): Promise<KvoxModule | null> {
    const owners = await this.ownership.managedBy(this.prisma, [objectId]);
    return owners.get(objectId) ?? null;
  }

  /** Builds the Fastify `onRequest` hook for the given global prefix. */
  hook(globalPrefix = 'api') {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
      const objectId = managedDeleteTarget(request.method, request.url, globalPrefix);
      if (!objectId) return;

      // Anonymous: let the platform guard answer 401 (see the file header).
      if (!request.headers.authorization && !request.headers.cookie) return;

      let owner: KvoxModule | null;
      try {
        owner = await this.ownerOf(objectId);
      } catch (error) {
        this.logger.error(
          `Managed-object lookup failed; refusing the delete: ${error instanceof Error ? error.message : String(error)}`,
        );
        return reply.code(503).send(this.envelope(503, request, 'The delete could not be checked; try again.'));
      }

      if (!owner) return;

      // Replying early from an async hook: return the reply so Fastify stops the chain.
      return reply.code(409).send(
        this.envelope(409, request, `This object is managed by ${owner} and cannot be deleted directly.`, {
          reason: MANAGED_BY_MODULE,
          module: owner,
        }),
      );
    };
  }

  private envelope(status: number, request: FastifyRequest, message: string, details?: Record<string, unknown>) {
    return {
      statusCode: status,
      code: defaultErrorCodeForStatus(status),
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
      ...(details ? { details } : {}),
    };
  }
}

/**
 * Installs the veto on the application's Fastify instance. Call it from
 * `main.ts` after `app.setGlobalPrefix('api')` (and before `app.listen`):
 *
 *   installManagedDeleteHook(app);
 */
export function installManagedDeleteHook(app: INestApplication, globalPrefix = 'api'): void {
  const veto = app.get(ManagedDeleteVeto, { strict: false });
  const fastify = app.getHttpAdapter().getInstance() as {
    addHook(name: 'onRequest', handler: (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>): void;
  };
  fastify.addHook('onRequest', veto.hook(globalPrefix));
}
