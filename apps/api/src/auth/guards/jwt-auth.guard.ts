import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PatService } from '../../pat/pat.service';
import { NodeCredentialService } from '../../nodes/node-credential.service';

// =============================================================================
// The `nod_` route allowlist (issue #267, epic #254)
// =============================================================================
//
// A worker-node credential authenticates AS ITS OWNING USER — `validateToken`
// returns the same `AuthenticatedUser` the JWT strategy would, carrying that
// user's real roles and permissions, because `RolesGuard` and
// `PermissionsGuard` downstream need something they can actually evaluate.
// And the owner of a node credential is an admin: `nodes:write` is granted to
// Admin only in `prisma/seed-data.ts`.
//
// So without this allowlist, a `nod_` token WOULD BE AN ADMIN TOKEN. That is
// not a hypothetical — it is the direct consequence of resolving it to a real
// user, and it is exactly the property that makes a leaked worker credential
// catastrophic rather than merely bad. A node credential lives in a config
// file on a machine nobody is watching; it must not be able to call
// `PATCH /api/users/:id`.
//
// -----------------------------------------------------------------------------
// WHY THE ALLOWLIST LIVES HERE AND NOT IN `NodeCredentialService`
// -----------------------------------------------------------------------------
// Because THIS is where route identity exists. `validateToken` answers "is
// this string a live credential, and whose" and has more than one caller by
// design; it has no request, no URL, and no business making an authorization
// decision about a route it cannot see. Pushing the check into the service
// would mean either passing a URL into a function whose job is credential
// liveness, or duplicating the rule at each caller — and a security rule that
// exists in two places is a security rule that will disagree with itself.
// Recorded as a rejected alternative in docs/specs/worker-nodes.md.
//
// -----------------------------------------------------------------------------
// WHY THE PREFIX MATCH IS EXACT AND NOT `startsWith('/api/nodes')`
// -----------------------------------------------------------------------------
// A bare `startsWith` would also admit `/api/nodesX`, `/api/nodes-other` and —
// the one that actually matters — any future `/api/nodes…`-shaped route
// somebody adds without thinking about this file. The rule is therefore
// "exactly the collection, or something UNDER it": `/api/nodes` itself, or a
// path beginning `/api/nodes/`. `/api/node-credentials` is not under it and
// is not admitted, which is deliberate and is the subject of its own comment
// in `nodes/node-credential.controller.ts`.
// =============================================================================

/** The one route prefix a `nod_` credential may reach. No trailing slash. */
export const NODE_ROUTE_PREFIX = '/api/nodes';

/** The `Authorization` value prefixes each token family is recognized by. */
const PAT_BEARER_PREFIX = 'Bearer pat_';
const NODE_BEARER_PREFIX = 'Bearer nod_';

/** Length of `'Bearer '`, i.e. where the raw token starts in the header. */
const BEARER_OFFSET = 'Bearer '.length;

/**
 * JWT authentication guard.
 *
 * Validates JWT tokens on protected routes. Routes marked `@Public()` are
 * skipped. Two opaque bearer families are recognized before Passport is ever
 * reached:
 *
 *   * `Bearer pat_…` — a personal access token, accepted on EVERY
 *     authenticated route with the owner's full authority. That universality
 *     is a documented promise of this API (`openapi/description.ts`) and is
 *     proven by `test/auth/pat-universality.integration.spec.ts`.
 *
 *   * `Bearer nod_…` — a worker-node credential, confined to
 *     {@link NODE_ROUTE_PREFIX}. Everything else is a 403. See the block
 *     comment above and docs/specs/worker-nodes.md.
 *
 * The two branches are intentionally asymmetric, and the asymmetry IS the
 * security model: a PAT is a human deliberately delegating their own
 * authority to a script they control, while a node credential is authority
 * handed to an unattended process on a machine the deployment may not own.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private patService: PatService,
    private nodeCredentialService: NodeCredentialService,
  ) {
    super();
  }

  /**
   * Determines if the route requires authentication.
   *
   * Order: `@Public()` first, then the two opaque bearer families, then
   * Passport. Note that a `@Public()` route short-circuits BEFORE either
   * opaque branch, so a public endpoint never pays for a credential lookup
   * and a `nod_` token is never 403'd on a route that needs no
   * authentication at all.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers?.authorization;

    if (authHeader?.startsWith(PAT_BEARER_PREFIX)) {
      const token = authHeader.slice(BEARER_OFFSET);
      const user = await this.patService.validateToken(token);
      if (!user) {
        throw new UnauthorizedException('Invalid or expired personal access token');
      }
      // Set the full AuthenticatedUser on request.user so RolesGuard/PermissionsGuard
      // can call toRequestUser() on it (same format as JWT strategy validate() returns)
      request.user = user;
      return true;
    }

    if (authHeader?.startsWith(NODE_BEARER_PREFIX)) {
      // -----------------------------------------------------------------
      // THE ROUTE ALLOWLIST RUNS FIRST. THIS ORDER IS NOT NEGOTIABLE.
      // -----------------------------------------------------------------
      // Validating first and checking the route second would produce the
      // same status code and be wrong in two ways at once:
      //
      //   1. `validateToken` stamps `lastUsedAt` fire-and-forget on every
      //      success. A stolen credential probed against `/api/users` would
      //      therefore leave a fresh `lastUsedAt` in the operator's own
      //      listing — a LIVENESS ORACLE handed to the attacker (the
      //      request was refused, so they learn nothing from the response;
      //      but a confederate who can read the list learns the token is
      //      still good) and, worse, a corrupted signal for the operator,
      //      whose "is this node still alive?" column now reflects an
      //      attacker's probes rather than a working node.
      //
      //   2. It spends a database round trip — an indexed lookup plus the
      //      `include` of roles and permissions, plus a write — on a request
      //      that was never going to be allowed. That turns a refused
      //      request into a cheap way to generate load, on the
      //      authentication path, for an unauthenticated caller.
      //
      // Rejecting on route identity alone needs no I/O and leaks nothing:
      // the answer is the same for a real credential, a revoked one and a
      // string somebody made up.
      // -----------------------------------------------------------------
      if (!this.isNodeRoute(request)) {
        throw new ForbiddenException(
          'Worker node credentials may only be used on node endpoints',
        );
      }

      const token = authHeader.slice(BEARER_OFFSET);
      const user = await this.nodeCredentialService.validateToken(token);
      if (!user) {
        // Deliberately one message for unknown, revoked, expired and
        // inactive-owner alike — see `NodeCredentialService.validateToken`.
        throw new UnauthorizedException('Invalid or expired node credential');
      }
      request.user = user;
      return true;
    }

    return super.canActivate(context) as Promise<boolean>;
  }

  /**
   * Whether this request targets a route a `nod_` credential may reach.
   *
   * READS THE RAW URL, NOT NEST'S ROUTE METADATA. `context.getHandler()` /
   * `getClass()` would tell us which controller Nest matched, and gating on
   * "is this the nodes controller" is the tempting version. It is the wrong
   * version: the answer would then depend on decorators #268 has not written
   * yet, and any new controller that forgot the marker would silently be
   * either open or closed depending on which default we picked. A path is a
   * fact about the request that exists before routing and cannot be
   * accidentally omitted.
   *
   * `originalUrl ?? url` covers both adapters: Fastify (this application's)
   * exposes the full path on `url`, Express rewrites `url` when a router is
   * mounted and preserves the real path on `originalUrl`. Taking
   * `originalUrl` first means a future adapter change cannot quietly narrow
   * what this function is looking at.
   *
   * The query string is stripped because it is not part of route identity:
   * `/api/nodes?x=1` is the nodes collection and must match, while nothing
   * after `?` may be allowed to influence the decision — a caller who could
   * append `?/api/nodes` to a forbidden path and pass would have found a
   * complete bypass.
   */
  private isNodeRoute(request: { originalUrl?: unknown; url?: unknown }): boolean {
    const raw = request.originalUrl ?? request.url;
    if (typeof raw !== 'string') {
      // No URL to reason about. Refuse rather than assume: this function's
      // `false` is a 403, and failing closed on a request we cannot classify
      // is the only safe default for an allowlist.
      return false;
    }

    const path = raw.split('?')[0];

    // Exactly the collection, or something beneath it. NOT `startsWith` on
    // the bare prefix — see the block comment at the top of this file for the
    // paths that would wrongly admit.
    return path === NODE_ROUTE_PREFIX || path.startsWith(`${NODE_ROUTE_PREFIX}/`);
  }
}
