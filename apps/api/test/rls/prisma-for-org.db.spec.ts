// =============================================================================
// Real-Postgres test: `PrismaService.forOrg` / `runInOrg(orgId, ...)` work under
// row-level security for the application role (#757)
// =============================================================================
//
// The platform's AI slice reads and writes `ai_usage_events` through
// `PLATFORM_PRISMA.forOrg(orgId, { userId })` (the usage recorder on every AI
// call, `GET /api/ai/usage/me`). This runs KVox's own `PrismaService` methods
// against a client connected as the ORDINARY application role, so FORCEd
// policies apply: an org sees its own usage rows, never another's, and cannot
// insert a row naming another org.
//
// A `*.db.spec.ts`: excluded from `npm test`, run by `npm run test:db`, skipped
// when no superuser Postgres is reachable. It creates and drops its own database.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import { PrismaService } from '../../src/prisma/prisma.service';
import {
  findAdminCredentials,
  provisionAppRoleDatabase,
  type AppRoleDatabase,
} from '../helpers/app-role-database.helper';

const admin = findAdminCredentials();

if (!admin) {
  // eslint-disable-next-line no-console
  console.warn('\n[prisma-for-org.db.spec] SKIPPED: no superuser Postgres reachable to bootstrap the application role.\n');
}

const describeWithDb = admin ? describe : describe.skip;

describeWithDb('PrismaService.forOrg as the application role (real Postgres)', () => {
  let deployment: AppRoleDatabase;
  let client: PrismaClient;
  let service: PrismaService;

  let orgA: string;
  const orgB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();

  const usage = (orgId: string, userId: string) => ({
    orgId,
    userId,
    provider: 'openai',
    modelId: 'test-model',
    operation: 'responses',
    keySource: 'user',
    latencyMs: 5,
    status: 'succeeded',
  });

  beforeAll(async () => {
    deployment = await provisionAppRoleDatabase(admin!);
    client = deployment.prismaClient();
    // PrismaService extends PrismaClient; its methods only need `$extends` and
    // `$transaction`, so they run unchanged on the role's client.
    service = client as unknown as PrismaService;

    const bootstrap = deployment.adminClient();
    await bootstrap.connect();
    try {
      orgA = (await bootstrap.query(`SELECT id FROM organizations WHERE is_default`)).rows[0].id;
      await bootstrap.query(
        `INSERT INTO organizations (id, name, slug, is_default, updated_at) VALUES ($1, 'B', $2, false, now())`,
        [orgB, `for-org-${orgB.slice(0, 8)}`],
      );
      for (const id of [userA, userB]) {
        await bootstrap.query(
          `INSERT INTO users (id, email, updated_at) VALUES ($1, $2, now())`,
          [id, `${id}@example.test`],
        );
      }
    } finally {
      await bootstrap.end();
    }
  }, 180_000);

  afterAll(async () => {
    await client?.$disconnect().catch(() => undefined);
    await deployment?.drop();
  });

  const forOrg = (orgId: string, opts?: { userId?: string }) =>
    PrismaService.prototype.forOrg.call(service, orgId, opts) as unknown as PrismaClient;
  const runInOrg = PrismaService.prototype.runInOrg as (this: unknown, ...a: unknown[]) => Promise<unknown>;

  it('forOrg(org, { userId }).aiUsageEvent writes and reads only that org', async () => {
    await forOrg(orgA, { userId: userA }).aiUsageEvent.create({ data: usage(orgA, userA) as never });
    await forOrg(orgB, { userId: userB }).aiUsageEvent.create({ data: usage(orgB, userB) as never });

    const a = await forOrg(orgA).aiUsageEvent.findMany();
    const b = await forOrg(orgB).aiUsageEvent.findMany();
    expect(a.map((r) => r.orgId)).toEqual([orgA]);
    expect(b.map((r) => r.orgId)).toEqual([orgB]);
    expect(await forOrg(orgA).aiUsageEvent.count()).toBe(1);
  });

  it('refuses an insert that names another organization', async () => {
    await expect(
      forOrg(orgA, { userId: userA }).aiUsageEvent.create({ data: usage(orgB, userA) as never }),
    ).rejects.toThrow();
  });

  it('runInOrg(orgId, fn, { userId }) (the platform shape) is scoped the same way', async () => {
    const seen = (await runInOrg.call(service, orgB, (tx: PrismaClient) => tx.aiUsageEvent.findMany(), {
      userId: userB,
    })) as Array<{ orgId: string }>;
    expect(seen.map((r) => r.orgId)).toEqual([orgB]);
  });

  it('runInOrg({ orgId }, fn) (the app shape) still works', async () => {
    const seen = (await runInOrg.call(service, { orgId: orgA }, (tx: PrismaClient) =>
      tx.aiUsageEvent.findMany(),
    )) as Array<{ orgId: string }>;
    expect(seen.map((r) => r.orgId)).toEqual([orgA]);
  });
});
