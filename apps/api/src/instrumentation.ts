// =============================================================================
// OpenTelemetry bootstrap (issues #343 and #471)
// =============================================================================
//
// `main.ts` imports this file FIRST, before Nest exists: auto-instrumentation can
// only patch modules required after the SDK starts. Since #471 the SDK is the
// platform's (`@marinoscar/platform-api/otel-core/sdk`): OTLP/HTTP trace, metric
// and log exporters to the collector (`OTEL_EXPORTER_OTLP_ENDPOINT`), each behind
// the runtime telemetry gate that the `telemetry` settings open and close, the
// Node auto-instrumentations (health probes ignored, fs off, Pino log sending on)
// and a SIGTERM shutdown. Nothing is exported unless `OTEL_ENABLED=true`, and
// nothing leaves the process until an administrator enables telemetry.
//
// Import the `sdk` subpath only, never the Nest-facing `otel-core` index.
// =============================================================================

import { initializeOtel } from '@marinoscar/platform-api/otel-core/sdk';

import { resolveServiceName, resolveTelemetryInstanceId } from './common/otel/telemetry-identity';

export const sdk = initializeOtel({
  serviceName: resolveServiceName(),
  instanceId: resolveTelemetryInstanceId(null),
});
