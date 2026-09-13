import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ROLES } from '../constants/roles.constants';
import { ALLOW_DURING_MAINTENANCE_KEY } from './allow-during-maintenance.decorator';
import { MaintenanceModeService } from './maintenance-mode.service';

// =============================================================================
// MaintenanceGuard — the repository's first APP_GUARD (#257, epic #254)
// =============================================================================
//
// Registered globally in `app.module.ts`, so it runs on EVERY Nest route before
// any route-level `UseGuards`. Two consequences follow from that, and both
// shape this file:
//
//   1. `request.user` DOES NOT EXIST YET. `JwtAuthGuard` has not run — it
//      cannot have, it is a route-level guard — so honouring `allowAdmins`
//      means verifying the bearer token here, on our own. See
//      `resolveAdminBearer`.
//
//   2. IT IS NOT THE ONLY THING IN FRONT OF THE APPLICATION.
//      `openapi/register-docs-routes.ts` mounts `/api/docs` and
//      `/api/openapi.json` DIRECTLY ON THE FASTIFY INSTANCE, outside Nest's
//      router, so those two routes never reach this guard and stay readable
//      while a window is open. That is intentional — a maintenance window is
//      exactly when an operator wants the reference — and it is documented in
//      docs/specs/maintenance-mode.md so nobody has to discover it by finding a
//      hole in the enumeration test.
// =============================================================================

/**
 * The stable marker on a maintenance 503's body, under `details.reason`.
 *
 * WHY A MARKER AT ALL. A 503 is the same status a crashed upstream, a full
 * connection pool or a load balancer with no healthy backends produces, and a
 * client that cannot tell those apart cannot do the one useful thing available
 * to it — show the operator's message and retry — without also showing it when
 * the deployment is simply broken. This string is the difference.
 *
 * WHY IT LIVES UNDER `details`. `common/filters/http-exception.filter.ts`
 * rebuilds every error body from a FIXED KEY ALLOWLIST (`statusCode`, `code`,
 * `message`, `details`, `timestamp`, `path`); `code` is always derived from the
 * status and a `code` on the thrown payload is deliberately ignored. A custom
 * top-level field would therefore be silently stripped on the way out — which
 * is why `test/maintenance/maintenance-response.integration.spec.ts` asserts
 * this through the REAL filter and not against the guard in isolation.
 *
 * The web client mirrors this constant in #258. Changing it is a wire-contract
 * change.
 */
export const MAINTENANCE_ERROR_MARKER = 'MAINTENANCE_MODE';

/**
 * `Retry-After`, in seconds, on every maintenance 503.
 *
 * Deliberately a fixed, short value rather than an estimate of when the window
 * will close: nobody knows that, and a confident wrong answer is worse than a
 * conservative one. It exists so well-behaved clients (and the CLI, and any
 * unattended `pat_` holder that just got blocked) back off on a timer instead
 * of hammering a deployment that is mid-upgrade.
 */
export const MAINTENANCE_RETRY_AFTER_SECONDS = 30;

/**
 * Bearer prefixes this guard treats as "definitely not an admin", without
 * looking any further.
 *
 * `pat_` (personal access tokens) and `nod_` (worker-node credentials) are
 * OPAQUE: they carry no claims, and deciding whether one belongs to an admin
 * would take a database round trip per request — on a guard that runs on every
 * request, and during a window in which the database may be exactly what is
 * being worked on. They also belong to UNATTENDED clients, which are the
 * callers that most need to back off during a window and the least likely to
 * be the human trying to fix it. So they are blocked regardless of
 * `allowAdmins`, and that is a feature rather than an omission.
 */
export const OPAQUE_BEARER_PREFIXES = ['pat_', 'nod_'] as const;

/** The claim set this guard reads. Matches `auth/strategies/jwt.strategy.ts`. */
interface MaintenanceJwtClaims {
  sub?: string;
  email?: string;
  roles?: unknown;
}

@Injectable()
export class MaintenanceGuard implements CanActivate {
  private readonly logger = new Logger(MaintenanceGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly maintenance: MaintenanceModeService,
    private readonly jwtService: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Non-HTTP contexts (there are none today) have no request to block and no
    // reply to put a header on. Letting them through is the honest answer
    // rather than pretending this guard understands them.
    if (context.getType() !== 'http') {
      return true;
    }

    const exempt = this.reflector.getAllAndOverride<boolean>(
      ALLOW_DURING_MAINTENANCE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (exempt) {
      return true;
    }

    const state = await this.maintenance.resolve();
    if (!state.enabled) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    if (state.allowAdmins && this.isAdminBearer(request)) {
      return true;
    }

    // Fastify keeps headers set before `send()`, and the exception filter is
    // what sends. Setting it here rather than in the filter keeps the header
    // and the body that explains it in one place.
    context
      .switchToHttp()
      .getResponse()
      .header('Retry-After', String(MAINTENANCE_RETRY_AFTER_SECONDS));

    throw new ServiceUnavailableException({
      message: state.message,
      details: {
        reason: MAINTENANCE_ERROR_MARKER,
        retryAfterSeconds: MAINTENANCE_RETRY_AFTER_SECONDS,
        // Told to the blocked caller because it is not a secret and it is the
        // difference between "come back later" and "sign in as an admin and
        // carry on", which is what #258's banner needs to decide what to
        // render.
        allowAdmins: state.allowAdmins,
      },
    });
  }

  /**
   * Whether the request carries a VERIFIED session JWT with the admin role.
   *
   * THREE RULES, all deliberate:
   *
   *   * `request.user` IS NEVER POPULATED. This guard authenticates nobody; it
   *     answers one yes/no question and gets out of the way. Writing a user
   *     onto the request here would mean every downstream guard, interceptor
   *     and handler in the application now has an authentication path that did
   *     not go through Passport, `JwtAuthGuard`, the disabled-user check or the
   *     PAT lookup — a second front door, opened by the one component that runs
   *     in front of every route. `JwtAuthGuard` still runs afterwards and still
   *     does the real work.
   *
   *   * A TOKEN THAT FAILS VERIFICATION IS SIMPLY "NOT AN ADMIN", never a
   *     rejection. Rejecting here would change the status an unauthenticated
   *     caller sees on every route in the application the moment a window
   *     opens (401 instead of the 503 that is actually true), and would let a
   *     malformed header override a deliberate operational decision.
   *
   *   * OPAQUE BEARERS SHORT-CIRCUIT. See {@link OPAQUE_BEARER_PREFIXES}.
   */
  private isAdminBearer(request: {
    headers?: Record<string, unknown>;
  }): boolean {
    const header = request.headers?.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return false;
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      return false;
    }

    if (OPAQUE_BEARER_PREFIXES.some((prefix) => token.startsWith(prefix))) {
      return false;
    }

    try {
      const claims = this.jwtService.verify<MaintenanceJwtClaims>(token);
      return (
        Array.isArray(claims?.roles) && claims.roles.includes(ROLES.ADMIN)
      );
    } catch {
      // Expired, wrong signature, not a JWT at all. All of them mean the same
      // thing here, and none of them is worth a log line on a path that runs
      // for every blocked request of a window.
      return false;
    }
  }
}
