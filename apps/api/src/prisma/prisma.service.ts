import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  orgScopeExtension,
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
   * A client whose every operation runs in a transaction that first sets the
   * transaction-local `app.org_id` (and `app.user_id`), so row-level security
   * shows it one organization's rows and refuses an insert naming another.
   *
   * The platform's AI, storage and sharing slices call
   * `PLATFORM_PRISMA.forOrg(orgId, { userId? })` (usage recorder, limits, runs,
   * output writer, ...); without it every AI call failed with
   * `this.prisma.forOrg is not a function` (#757). Same
   * mechanism and signature as the reference app's `PrismaService.forOrg`.
   *
   * Good for single operations; a unit of work of more than one statement uses
   * {@link PrismaService.runInOrg}. Never open `$transaction(async tx => ...)`
   * on the returned client.
   *
   * @param orgId - `principal.activeOrgId`, or a job payload's `orgId`; never request input.
   * @param opts - `userId`: the acting user, becomes `app.user_id`.
   * @throws ScopedAccessError when an id is not a UUID.
   */
  forOrg(orgId: string, opts: { userId?: string } = {}) {
    return this.$extends(orgScopeExtension(this, { orgId, ...opts }));
  }

  /**
   * Runs `fn` in ONE interactive transaction scoped to an organization (and,
   * when given, a user), so row-level security confines every query on an
   * `org_id` table to the scope's organization (issue #466).
   *
   * Two call shapes, both transaction-local (`set_config(name, value, true)`
   * as the first statement, NEVER a session-level `SET`):
   *  - `runInOrg({ orgId, userId? }, fn, options)`: this app's callers, the
   *    settings and sharing adapters (`SETTINGS_DATA`, `SHARING_DATA`).
   *  - `runInOrg(orgId, fn, { userId?, maxWait?, timeout? })`: the platform's
   *    own callers (`AiRunsService`, the storage `storageRunInOrg` helper),
   *    which call `PLATFORM_PRISMA.runInOrg(orgId, fn, opts)`.
   */
  runInOrg<R>(
    scope: OrgScope,
    fn: (tx: RlsTransactionClient<PrismaService>) => Promise<R>,
    options?: RlsTransactionOptions,
  ): Promise<R>;
  runInOrg<R>(
    orgId: string,
    fn: (tx: RlsTransactionClient<PrismaService>) => Promise<R>,
    options?: { userId?: string } & RlsTransactionOptions,
  ): Promise<R>;
  runInOrg<R>(
    scopeOrOrgId: OrgScope | string,
    fn: (tx: RlsTransactionClient<PrismaService>) => Promise<R>,
    options: { userId?: string } & RlsTransactionOptions = {},
  ): Promise<R> {
    if (typeof scopeOrOrgId === 'string') {
      const { userId, ...transaction } = options;
      return runInOrg(
        this,
        { orgId: scopeOrOrgId, ...(userId !== undefined ? { userId } : {}) },
        fn,
        transaction,
      );
    }
    return runInOrg(this, scopeOrOrgId, fn, options);
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
