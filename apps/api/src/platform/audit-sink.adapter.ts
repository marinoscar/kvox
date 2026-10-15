import { Injectable } from '@nestjs/common';
import type { AuditEventInput, AuditSink } from '@marinoscar/platform-api/core';

import { PrismaService } from '../prisma/prisma.service';

/**
 * The platform's `AUDIT_SINK` over KVox's `audit_events` table.
 *
 * Packaged slices and KVox's own app routes report audit events here after the
 * triggering write has committed. `meta` carries scalars only (the port's
 * contract), so it is stored as given. `orgId` is left null: the events written
 * through this port are system events (the allowlist, settings).
 */
@Injectable()
export class PrismaAuditSink implements AuditSink {
  constructor(private readonly prisma: PrismaService) {}

  async record(event: AuditEventInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: event.actorUserId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        ...(event.meta ? { meta: event.meta } : {}),
      },
    });
  }
}
