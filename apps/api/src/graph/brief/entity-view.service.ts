// =============================================================================
// EntityViewService (#372; spec §9.2 "since I last looked")
// =============================================================================
//
// `kg_entity_views (user_id, entity_id, last_viewed_at)` — a per-VIEWER fact,
// keyed on `user_id` rather than `owner_id` (§10). The brief reads it BEFORE
// assembling a response and upserts it AFTER, so a visit's "what changed" is
// computed against the previous visit, not against itself.
// =============================================================================

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class EntityViewService {
  constructor(private readonly prisma: PrismaService) {}

  async lastViewedAt(userId: string, entityId: string): Promise<Date | null> {
    const row = await this.prisma.kgEntityView.findUnique({
      where: { userId_entityId: { userId, entityId } },
      select: { lastViewedAt: true },
    });
    return row?.lastViewedAt ?? null;
  }

  async markViewed(userId: string, entityId: string, at: Date): Promise<void> {
    await this.prisma.kgEntityView.upsert({
      where: { userId_entityId: { userId, entityId } },
      create: { userId, entityId, lastViewedAt: at },
      update: { lastViewedAt: at },
    });
  }
}
