import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { forSystem, type SystemAccessReason } from '@marinoscar/platform-api/core';

import { buildDatabaseUrl } from '../common/database-url';

/**
 * The platform's SYSTEM database client: a SEPARATE `PrismaClient` with its own
 * connection pool, used to read or write across organizations under a
 * registered access reason (`forSystem(reason)` sets the transaction-local
 * `app.rls_bypass` flag that the row-level-security policies honour).
 *
 * WHY A SECOND CLIENT. The bypass flag must never ride on the tenant pool, so
 * the app's ordinary `PrismaService` (which can only be scoped to an
 * organization) and this one never share a connection. Only code on the
 * platform's injection allowlist may inject it.
 *
 * It connects lazily (Prisma opens the pool on first use) so a process that
 * never asks for system access opens no second pool.
 */
@Injectable()
export class PrismaSystemService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaSystemService.name);

  constructor() {
    // A small pool: system access is rare (backups, purges, aggregates).
    super({ adapter: new PrismaPg({ connectionString: buildDatabaseUrl(), max: 5 }) });
  }

  /**
   * A client whose every operation runs with row-level security bypassed.
   *
   * @param reason - a registered system access reason (`backup`, `restore`,
   *   `purge`, `doctor`, `retention`, ...); an unregistered one throws.
   */
  forSystem(reason: SystemAccessReason) {
    return forSystem(this, reason);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('System database client disconnected');
  }
}
