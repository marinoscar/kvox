import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  runInOrg,
  type OrgScope,
  type RlsTransactionClient,
  type RlsTransactionOptions,
} from '@marinoscar/platform-api/core';

// One shared builder rather than a third private copy of the formula; the
// header of that module explains what the three copies did to each other.
import { buildDatabaseUrl } from '../common/database-url';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const adapter = new PrismaPg(buildDatabaseUrl());
    super({
      adapter,
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');

    // Log queries in development
    if (process.env.NODE_ENV === 'development') {
      // @ts-ignore - Prisma event typing
      this.$on('query', (e: any) => {
        this.logger.debug(`Query: ${e.query}`);
        this.logger.debug(`Duration: ${e.duration}ms`);
      });
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }

  /**
   * Runs `fn` in ONE interactive transaction scoped to an organization (and,
   * when given, a user), so row-level security confines every query on an
   * `org_id` table to `scope.orgId` (issue #466; copied from the reference
   * app's `PrismaService`).
   *
   * The scope is set with `set_config(name, value, true)` as the transaction's
   * first statement (`runInOrg` from `@marinoscar/platform-api/core`), NEVER a
   * session-level `SET`: a pooled connection would carry the scope into the next
   * request. Bound to the settings slice's `SETTINGS_DATA` port by
   * `platform/settings/settings-data.adapter.ts`.
   */
  runInOrg<R>(
    scope: OrgScope,
    fn: (tx: RlsTransactionClient<PrismaService>) => Promise<R>,
    options?: RlsTransactionOptions,
  ): Promise<R> {
    return runInOrg(this, scope, fn, options);
  }

  /**
   * Clean database for testing
   */
  async cleanDatabase() {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('cleanDatabase only allowed in test environment');
    }

    const tablenames = await this.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname='public'
    `;

    for (const { tablename } of tablenames) {
      if (tablename !== '_prisma_migrations') {
        await this.$executeRawUnsafe(
          `TRUNCATE TABLE "public"."${tablename}" CASCADE;`,
        );
      }
    }
  }
}
