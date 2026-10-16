import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_SINK, type AuditEventInput, type AuditSink } from '@marinoscar/platform-api/core';
import { Trace } from '@marinoscar/platform-api/otel-core';
import type { KvoxAuditEvent, KvoxAuditPort } from '@marinoscar/kvox-api/ports';

// =============================================================================
// PlatformKvoxAuditAdapter: the `KVOX_AUDIT` port over the platform `AUDIT_SINK`
// (issue #490, epic #486)
// =============================================================================
//
// The sink (`platform/audit-sink.adapter.ts`) writes `audit_events`. Its `meta` takes
// scalars only, so a non-scalar value in a slice's `meta` is stored as its JSON text
// rather than failing the audit write. Record after the triggering write has committed.
// =============================================================================

@Injectable()
export class PlatformKvoxAuditAdapter implements KvoxAuditPort {
  constructor(@Inject(AUDIT_SINK) private readonly sink: AuditSink) {}

  @Trace()
  async record(e: KvoxAuditEvent): Promise<void> {
    await this.sink.record({
      actorUserId: e.actorUserId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      ...(e.meta !== undefined ? { meta: scalars(e.meta) } : {}),
    });
  }
}

/** The audit port's `meta` as the sink takes it: strings, numbers, booleans and null. */
function scalars(meta: Record<string, unknown>): NonNullable<AuditEventInput['meta']> {
  const out: NonNullable<AuditEventInput['meta']> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (value !== undefined) {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
}
