import { SetMetadata } from '@nestjs/common';

/** Reflector key stamped by {@link AllowDuringMaintenance}. */
export const ALLOW_DURING_MAINTENANCE_KEY = 'allowDuringMaintenance';

/**
 * Exempt a route (or a whole controller) from the maintenance window (#257).
 *
 * WHAT THIS IS NOT: `@Public()`. That decorator answers "does this route need a
 * token?"; this one answers "may this route be served while the application is
 * deliberately out of service?". They are independent, and conflating them
 * would be a real defect in both directions — `GET /api/auth/me` needs a token
 * and must still answer during a window, while every public read endpoint a
 * fork adds later must NOT be reachable merely because it is public.
 *
 * The exempt set is deliberately tiny and is asserted as a whole, by
 * enumerating every route the router knows about, in
 * `test/maintenance/maintenance-reachable-set.integration.spec.ts`. A missing
 * exemption on a sign-in route locks every user out permanently — including the
 * admin who would have turned the window off — so the safeguard is a test that
 * fails when the set changes, not a reviewer noticing.
 *
 * Read with `getAllAndOverride([handler, class])`, so a controller-level
 * exemption covers its routes and a handler may not be un-exempted piecemeal.
 *
 * @example
 * ```typescript
 * @AllowDuringMaintenance()
 * @Controller('health')
 * export class HealthController {}
 * ```
 */
export const AllowDuringMaintenance = () =>
  SetMetadata(ALLOW_DURING_MAINTENANCE_KEY, true);
