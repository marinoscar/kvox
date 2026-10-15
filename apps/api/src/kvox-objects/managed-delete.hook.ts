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
// ABORT. `DELETE .../storage/objects/<uuid>/upload/abort` is forwarded, for a
// managed object only, to KVox's own `DELETE .../upload/abort-managed` route
// (`KvoxMultipartController.abortManaged`) with the caller's credentials, and its
// answer is relayed. The platform abort DELETES the object row, and the owning
// record's `source_object_id` is `onDelete: Restrict`, so it would abort the
// provider upload and then fail on the foreign key. The KVox route keeps the row
// (status `failed`) and fails the transcript. The forward is an in-process
// `inject` through the full route, so authentication, permissions and the error
// envelope are the real ones; an unmanaged object still reaches the platform
// handler untouched.
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

/** The object id of a `DELETE <prefix>/storage/objects/<uuid>/upload/abort` request, else null. */
export function managedAbortTarget(method: string, url: string, globalPrefix = 'api'): string | null {
  if (method !== 'DELETE') return null;

  const path = url.split('?', 1)[0] ?? '';
  const prefix = globalPrefix ? `/${globalPrefix.replace(/^\/+|\/+$/g, '')}` : '';
  const match = new RegExp(`^${prefix}/storage/objects/(${UUID})/upload/abort/?$`).exec(path);
  return match ? (match[1] as string) : null;
}

/** Request headers forwarded to the in-process abort route. */
const FORWARDED_HEADERS = [
  'authorization',
  'cookie',
  'accept',
  'user-agent',
  'x-request-id',
  'x-forwarded-for',
  'x-forwarded-proto',
] as const;

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
      const deleteId = managedDeleteTarget(request.method, request.url, globalPrefix);
      const abortId = deleteId ? null : managedAbortTarget(request.method, request.url, globalPrefix);
      const objectId = deleteId ?? abortId;
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

      if (abortId) return this.forwardAbort(request, reply, abortId, globalPrefix);

      // Replying early from an async hook: return the reply so Fastify stops the chain.
      return reply.code(409).send(
        this.envelope(409, request, `This object is managed by ${owner} and cannot be deleted directly.`, {
          reason: MANAGED_BY_MODULE,
          module: owner,
        }),
      );
    };
  }

  /** Relays the answer of the in-process KVox abort route. */
  private async forwardAbort(
    request: FastifyRequest,
    reply: FastifyReply,
    objectId: string,
    globalPrefix: string,
  ): Promise<FastifyReply> {
    const prefix = globalPrefix ? `/${globalPrefix.replace(/^\/+|\/+$/g, '')}` : '';
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }

    try {
      const response = await request.server.inject({
        method: 'DELETE',
        url: `${prefix}/storage/objects/${objectId}/upload/abort-managed`,
        headers,
      });

      const contentType = response.headers['content-type'];
      if (typeof contentType === 'string') void reply.header('content-type', contentType);
      void reply.code(response.statusCode);
      return reply.send(response.statusCode === 204 ? undefined : response.rawPayload);
    } catch (error) {
      this.logger.error(`Managed abort forward failed: ${error instanceof Error ? error.message : String(error)}`);
      return reply.code(503).send(this.envelope(503, request, 'The abort could not be completed; try again.'));
    }
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
