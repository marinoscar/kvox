// =============================================================================
// Who this process is to OpenTelemetry (issues #343 and #471)
// =============================================================================
//
// Two names, resolved in exactly one place each:
//
//   * the SERVICE NAME (`service.name`): `OTEL_SERVICE_NAME`, else
//     `${APP_SLUG}-api`. Read by `instrumentation.ts` (the resource on every
//     exported span), `config/configuration.ts` (`otel.serviceName`),
//     `common/logger/pino.config.ts` (the `service` field on every log line) and
//     the telemetry app-info binding (`platform/telemetry/telemetry-app-info.adapter.ts`).
//   * the INSTANCE ID (`app.instance.id`): the label the telemetry gate stamps on
//     every exported batch so several deployments can share one store. The
//     administrator may override it at runtime (`telemetry.instanceId`); until
//     then, and whenever it is unset, it is this app's slug.
//
// Both are thin wrappers over `@marinoscar/platform-api/otel-core/sdk`, which owns
// the resolution rules; this file only supplies this app's fallback values.
//
// SAFE TO IMPORT BEFORE THE SDK STARTS
// -----------------------------------------------------------------------------
// `instrumentation.ts` is loaded first thing by `main.ts`, before Nest exists, and
// OpenTelemetry's auto-instrumentation can only patch modules required AFTER
// `initializeOtel()`. The `otel-core/sdk` subpath imports no `@nestjs/*`, `http`,
// `pg` or `pino`, and `@app/shared` is plain CommonJS over a `require` of the
// identity file. Keep it that way: anything with real startup work does not
// belong in this file.
// =============================================================================

import { APP_SLUG } from '@app/shared';
import {
  resolveServiceName as resolvePlatformServiceName,
  resolveTelemetryInstanceId as resolvePlatformInstanceId,
} from '@marinoscar/platform-api/otel-core/sdk';

/**
 * The service name this process reports to OpenTelemetry.
 *
 * `OTEL_SERVICE_NAME` wins when set (it is set explicitly in the Compose files and
 * `.env.example`, so a deployment does not depend on the fallback). The fallback
 * exists for a bare local run and follows the app name (`${APP_SLUG}-api`), so a
 * renamed fork does not keep reporting under the template's identity.
 *
 * Resolved on every call rather than captured in a constant, so a test that sets
 * `process.env.OTEL_SERVICE_NAME` is not defeated by whichever module imported
 * this one first.
 */
export function resolveServiceName(): string {
  return resolvePlatformServiceName(`${APP_SLUG}-api`);
}

/**
 * The `app.instance.id` this process is stamped with: the administrator's
 * `telemetry.instanceId` when one is set, else this app's slug.
 *
 * @param configured - the stored setting; `null`, `undefined` or `''` means "use the slug".
 */
export function resolveTelemetryInstanceId(configured: string | null | undefined = null): string {
  return resolvePlatformInstanceId(configured, APP_SLUG);
}
