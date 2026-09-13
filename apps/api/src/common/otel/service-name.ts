// =============================================================================
// The OpenTelemetry service name, resolved in exactly one place (issue #343)
// =============================================================================
//
// WHY ONE SHARED EXPRESSION RATHER THAN FOUR FALLBACKS
// -----------------------------------------------------------------------------
//
// Four surfaces name this service, and before this file they each spelled the
// fallback out for themselves:
//
//   - `src/instrumentation.ts`               — the resource on every exported span
//   - `src/config/configuration.ts`          — `otel.serviceName`
//   - `src/common/logger/pino.config.ts`     — the `service` field on every log line
//   - `src/common/decorators/trace.decorator.ts` — the `@Trace()` tracer
//
// Three read `OTEL_SERVICE_NAME` with a hardcoded fallback and the fourth read
// NOTHING — it held a bare literal, so setting `OTEL_SERVICE_NAME` moved three
// of the four and left the decorator emitting the template's name into traces
// forever. That is not a spelling problem: spans from `@Trace()` and spans from
// the auto-instrumentation would land under two different services in the same
// backend, and neither half is the whole picture.
//
// A single call makes the four agree by construction, and — the reason this
// exists at all — makes the fallback follow `APP_NAME`, so a fork that renames
// itself is not still reporting as the template it was cloned from.
//
// SAFE TO IMPORT BEFORE THE SDK STARTS
// -----------------------------------------------------------------------------
//
// `instrumentation.ts` is loaded first thing by `main.ts`, before Nest exists,
// and OTEL's auto-instrumentation can only patch modules that are required
// AFTER `sdk.start()`. This module is therefore kept trivial on purpose: it
// reads `process.env` and `@app/shared` (plain CommonJS over a `require` of
// `identity.json`) and touches nothing that is instrumented — no `http`, no
// `pg`, no client library. Keep it that way; anything with real startup work
// does not belong in this file.
//
// WHY THIS IS ALSO HANDED TO `getTracer()`
// -----------------------------------------------------------------------------
//
// It should not be, strictly. By OpenTelemetry convention `getTracer()` takes
// the name of the INSTRUMENTATION LIBRARY producing the spans (here, something
// like `app-api-trace-decorator`) — not the service name, which belongs on the
// resource and is set once in `instrumentation.ts`. Conflating the two makes
// every `@Trace()` span report an instrumentation scope that is really a
// service identity.
//
// That conflation already exists in `trace.decorator.ts` and is DELIBERATELY
// PRESERVED here: the scope name is a dimension dashboards and saved queries
// filter on, so changing it is a breaking change to whatever is already built
// on it. This change only fixes the bug that the decorator ignored
// `OTEL_SERVICE_NAME` entirely. Untangling the scope name from the service name
// is a separate issue, and wants the dashboards migrated with it.
// =============================================================================

import { APP_SLUG } from '@app/shared';

/**
 * The service name this process reports to OpenTelemetry.
 *
 * `OTEL_SERVICE_NAME` wins when set — it is set explicitly in
 * `infra/compose/base.compose.yml` and `infra/compose/.env.example`, so
 * deployed behaviour does not depend on the fallback. The fallback exists for
 * a bare local run, and follows the app name (`${APP_SLUG}-api`) so a renamed
 * fork does not silently keep reporting under the template's identity.
 *
 * Resolved on every call rather than captured in a module-level constant, so a
 * test that sets `process.env.OTEL_SERVICE_NAME` is not defeated by whichever
 * module happened to be imported first.
 */
export function resolveServiceName(): string {
  return process.env.OTEL_SERVICE_NAME || `${APP_SLUG}-api`;
}
