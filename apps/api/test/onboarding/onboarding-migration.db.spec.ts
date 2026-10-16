// =============================================================================
// Real-Postgres test: the onboarding intent migration (issue #481, epic #478)
// =============================================================================
//
// `20261016120000_onboarding_checklist_dismissed_at` renames the stored
// `onboarding.dismissedAt` to `onboarding.checklistDismissedAt` so the platform's STRICT
// `onboarding` namespace parses every row that exists today. What is pinned, against
// fixture rows in a real jsonb column, by running the migration's own SQL:
//
//   * a user who dismissed the checklist before the upgrade still has it dismissed
//   * a user who skipped `admin.smoke_test` still has it skipped (and nothing else changes)
//   * the other onboarding fields and the other namespaces are untouched
//   * a row that already carries the new key keeps its value and loses only the stale one
//   * rows with no onboarding, no `dismissedAt`, or a non-object `onboarding` are untouched
//   * the migration is idempotent
//   * after it, the platform's `UserSettingsService` reads the migrated row (the strict
//     schema would have refused the old key)
//
// THIS IS A `*.db.spec.ts` FILE: see `test/jobs/db-test-support.ts` for the run/skip mechanics.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { UserSettingsService, type SettingsProfileImages } from '@marinoscar/platform-api/settings';
import type { PrincipalCache } from '@marinoscar/platform-api/identity';
import { normalizeProfileSettings } from '@marinoscar/platform-api/storage';

import '../../src/kvox.manifest';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('onboarding-migration.db.spec');

const EMAIL_PREFIX = 'onboarding-migration-481';
const MIGRATION_SQL = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '20261016120000_onboarding_checklist_dismissed_at', 'migration.sql'),
  'utf8',
);

const BASE = { theme: 'dark', profile: { imageSource: 'provider', imageObjectId: null } };
const SEEN = '2026-02-03T04:05:06.000Z';
const DISMISSED = '2026-02-04T04:05:06.000Z';
const ADMIN_DISMISSED = '2026-02-05T04:05:06.000Z';

describeWithDb('onboarding intent migration (db)', () => {
  let prisma: PrismaClient;
  let users: UserSettingsService;
  const createdUserIds: string[] = [];

  async function seed(label: string, value: Record<string, unknown>): Promise<string> {
    const user = await prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
    });
    createdUserIds.push(user.id);
    await prisma.userSettings.create({
      data: { userId: user.id, value: value as Prisma.InputJsonValue, version: 1 },
    });
    return user.id;
  }

  async function stored(userId: string): Promise<Record<string, unknown>> {
    const row = await prisma.userSettings.findUniqueOrThrow({ where: { userId } });
    return row.value as Record<string, unknown>;
  }

  /** Runs the migration's own statement(s), as `prisma migrate deploy` would. */
  async function migrate(): Promise<void> {
    await prisma.$executeRawUnsafe(MIGRATION_SQL);
  }

  beforeAll(() => {
    prisma = createDbClient();
    const profileImages: SettingsProfileImages = {
      normalize: normalizeProfileSettings,
      isUploadedAvatar: async () => false,
    };
    users = new UserSettingsService(
      prisma as never,
      { invalidate: () => undefined } as unknown as PrincipalCache,
      profileImages,
    );
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it('keeps a dismissed checklist dismissed, and every other onboarding field and namespace as stored', async () => {
    const id = await seed('dismissed', {
      ...BASE,
      onboarding: { welcomeSeenAt: SEEN, dismissedAt: DISMISSED, adminDismissedAt: ADMIN_DISMISSED, skipped: ['admin.smoke_test', 'user.first_note'] },
    });

    await migrate();

    expect(await stored(id)).toEqual({
      ...BASE,
      onboarding: {
        welcomeSeenAt: SEEN,
        checklistDismissedAt: DISMISSED,
        adminDismissedAt: ADMIN_DISMISSED,
        skipped: ['admin.smoke_test', 'user.first_note'],
      },
    });
  });

  it('keeps a skipped admin.smoke_test skipped when nothing was dismissed', async () => {
    const id = await seed('skipped-only', { ...BASE, onboarding: { skipped: ['admin.smoke_test'] } });

    await migrate();

    expect(await stored(id)).toEqual({ ...BASE, onboarding: { skipped: ['admin.smoke_test'] } });
  });

  it('lets the new key win when a row already has both, and drops only the stale one', async () => {
    const id = await seed('both', {
      ...BASE,
      onboarding: { dismissedAt: DISMISSED, checklistDismissedAt: ADMIN_DISMISSED },
    });

    await migrate();

    expect(await stored(id)).toEqual({ ...BASE, onboarding: { checklistDismissedAt: ADMIN_DISMISSED } });
  });

  it('leaves rows without the old key alone: no onboarding, a new-shape one, and a non-object one', async () => {
    const none = await seed('none', { ...BASE });
    const modern = await seed('modern', { ...BASE, onboarding: { checklistDismissedAt: DISMISSED } });
    // Not a shape the application writes, but `? 'dismissedAt'` on a jsonb string would match it.
    const weird = await seed('weird', { ...BASE, onboarding: 'dismissedAt' });

    await migrate();

    expect(await stored(none)).toEqual({ ...BASE });
    expect(await stored(modern)).toEqual({ ...BASE, onboarding: { checklistDismissedAt: DISMISSED } });
    expect(await stored(weird)).toEqual({ ...BASE, onboarding: 'dismissedAt' });
  });

  it('is idempotent', async () => {
    const id = await seed('twice', { ...BASE, onboarding: { dismissedAt: DISMISSED } });

    await migrate();
    const once = await stored(id);
    await migrate();

    expect(await stored(id)).toEqual(once);
    expect(once).toEqual({ ...BASE, onboarding: { checklistDismissedAt: DISMISSED } });
  });

  it('produces a row the platform user-settings service reads, with the dismissal intact', async () => {
    const id = await seed('read-back', {
      ...BASE,
      onboarding: { welcomeSeenAt: SEEN, dismissedAt: DISMISSED, skipped: ['admin.smoke_test'] },
    });

    await migrate();
    const settings = (await users.getSettings(id)) as unknown as { onboarding?: Record<string, unknown> };

    expect(settings.onboarding).toEqual({
      welcomeSeenAt: SEEN,
      checklistDismissedAt: DISMISSED,
      skipped: ['admin.smoke_test'],
    });
  });
});
