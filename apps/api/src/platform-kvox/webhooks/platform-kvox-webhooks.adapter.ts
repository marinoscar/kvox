import { Injectable } from '@nestjs/common';
import { currentTenancyMode } from '@marinoscar/platform-api/identity';
import { Trace } from '@marinoscar/platform-api/otel-core';
import { WebhooksService } from '@marinoscar/platform-api/webhooks';
import type { KvoxWebhookContext, KvoxWebhooksPort } from '@marinoscar/kvox-api/ports';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// PlatformKvoxWebhooksAdapter: the `KVOX_WEBHOOKS` port over the platform webhooks slice
// (#795)
// =============================================================================
//
// `WebhooksService.emit` validates `data` against the event's registered schema (see
// `kvox-webhook-events.ts`), writes one delivery row per subscribed endpoint and enqueues the
// delivery jobs. It never calls a receiver, so this adapter does no network I/O inline, as the
// port requires. The package calls `emit` from its own `kvox.webhook_emit` job, after the
// triggering write committed.
//
// WHICH ORGANIZATION: every KVox event is the user's own (`audience: 'user'`), and an endpoint
// belongs to an organization. The context normally carries one (the job's). When it does not:
//
//   - single-organization mode: pass `null`; the platform resolves the default organization;
//   - multi-organization mode: use the user's most recently active membership. A user with no
//     active membership has no endpoint to notify, so the event is dropped (the platform logs and
//     counts a `null` organization it cannot resolve as `no_match`).
// =============================================================================

@Injectable()
export class PlatformKvoxWebhooksAdapter implements KvoxWebhooksPort {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly prisma: PrismaService,
  ) {}

  @Trace()
  async emit(eventKey: string, data: unknown, ctx: KvoxWebhookContext): Promise<void> {
    const orgId = ctx.orgId ?? (await this.orgOf(ctx.userId));
    await this.webhooks.emit(eventKey, data, { orgId, ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}) });
  }

  /** The organization a user's event belongs to when the caller named none; `null` leaves it to the platform. */
  private async orgOf(userId: string | undefined): Promise<string | null> {
    if (!userId || currentTenancyMode() !== 'multi') return null;
    const membership = await this.prisma.membership.findFirst({
      where: { userId, status: 'active' },
      orderBy: [{ lastActiveAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }],
      select: { orgId: true },
    });
    return membership?.orgId ?? null;
  }
}
