import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { resolveServiceName } from '../otel/service-name';

// Was a bare `'enterprise-app-api'` literal with no environment read at all, so
// setting `OTEL_SERVICE_NAME` moved the SDK resource, the config and the logs
// while these spans kept the template's name. `getTracer` conventionally takes
// the instrumentation-library name rather than the service name; that existing
// conflation is preserved on purpose so current dashboards keep working — see
// `common/otel/service-name.ts`.
const tracer = trace.getTracer(resolveServiceName());

/**
 * Decorator to add tracing to a method
 */
export function Trace(spanName?: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;
    const name = spanName || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: any[]) {
      return tracer.startActiveSpan(
        name,
        { kind: SpanKind.INTERNAL },
        async (span) => {
          try {
            const result = await originalMethod.apply(this, args);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (error) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : 'Unknown error',
            });
            span.recordException(error as Error);
            throw error;
          } finally {
            span.end();
          }
        },
      );
    };

    return descriptor;
  };
}
