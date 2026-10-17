// =============================================================================
// This app's own seed rows (issue #465, epic #462)
// =============================================================================
//
// `prisma/seed.ts` runs the platform seed first (`seedPlatform`: roles,
// permissions, default grants, the `global` system settings row, the initial
// administrator's allowlist row, the default organization) and then `seedApp`
// from this file: the rows that belong to this app alone. Today that is the
// built-in note templates, which used to live in `seed-data.ts` together with
// the role and permission tables the platform seed now owns.
//
// Idempotent: every write is an upsert on a natural unique. Framework-free on
// purpose, like `seed.ts`: no Nest, no `src/` import, so it runs under
// ts-node from a production image that carries `prisma/` but not `src/`.
//
// The built-in note templates are the notes slice's data (`NOTE_BUILTIN_TEMPLATES` of
// `@marinoscar/kvox-api/notes/templates`, issue #495); a Jest test asserts it there.

import type { PrismaClient } from '@prisma/client';
import { seedNoteTemplates } from '@marinoscar/kvox-api/notes/templates';

/**
 * Upsert this app's own seed rows. Idempotent: a second run changes nothing.
 *
 * @param prisma - The seed script's client.
 */
export async function seedApp(prisma: PrismaClient): Promise<void> {
  console.log('Seeding built-in note templates...');

  // The templates and the idempotent upsert are the notes slice's (`@marinoscar/kvox-api`, issue #495).
  const notes = await seedNoteTemplates(prisma);

  console.log(`✓ Seeded built-in note templates (${notes.created} created, ${notes.updated} already present)`);
  await seedViewerAiUse(prisma);
  await seedViewerSharing(prisma);
}

/**
 * The org roles that hold `ai:use` on top of the platform's own default grants
 * (`org_admin`, `contributor`): the `viewer` role (issue #473).
 *
 * The platform's registry refuses an app grant that targets a platform role, so the
 * grant is a seed row, not a catalog entry. It is the posture this app has always had:
 * every role may use AI, with its OWN saved key (`byok`), and a Viewer is the default
 * role of a new account. A Viewer with no key still cannot call a model.
 */
export const VIEWER_AI_GRANTS = [{ role: 'viewer', permission: 'ai:use' }] as const;

/**
 * The org roles that hold `sharing:write` on top of the platform's own default grants
 * (`org_admin`, `contributor`): the `viewer` role (issue #485).
 *
 * Sharing a transcript used to need only `transcripts:write`, which every role holds
 * (a Viewer is the default role of a new account and records its own conversations).
 * A share is a platform grant now, and the grants routes (`POST /api/grants`, which the
 * share dialog calls) need `sharing:write`, so without this row a new account could no
 * longer share its own recording. What a Viewer may share is still bounded by the
 * resource type: only the owner of a transcript holds the `share` action on it. Same
 * mechanism as `ai:use` above: the platform's registry refuses an app grant on a
 * platform role, so it is a seed row.
 */
export const VIEWER_SHARING_GRANTS = [{ role: 'viewer', permission: 'sharing:write' }] as const;

async function seedViewerAiUse(prisma: PrismaClient): Promise<void> {
  console.log('Seeding AI grants...');

  for (const grant of VIEWER_AI_GRANTS) {
    const [role, permission] = await Promise.all([
      prisma.role.findUnique({ where: { name: grant.role } }),
      prisma.permission.findUnique({ where: { name: grant.permission } }),
    ]);

    // The platform seed ran first and creates both; absent means the catalog changed.
    if (!role || !permission) {
      console.log(`  skipped ${grant.role} -> ${grant.permission} (role or permission not seeded)`);
      continue;
    }

    // Idempotent: the composite key is the natural unique, and an existing grant is left alone.
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }

  console.log(`✓ Seeded ${VIEWER_AI_GRANTS.length} AI grant(s)`);
}

async function seedViewerSharing(prisma: PrismaClient): Promise<void> {
  console.log('Seeding sharing grants...');

  for (const grant of VIEWER_SHARING_GRANTS) {
    const [role, permission] = await Promise.all([
      prisma.role.findUnique({ where: { name: grant.role } }),
      prisma.permission.findUnique({ where: { name: grant.permission } }),
    ]);

    if (!role || !permission) {
      console.log(`  skipped ${grant.role} -> ${grant.permission} (role or permission not seeded)`);
      continue;
    }

    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }

  console.log(`✓ Seeded ${VIEWER_SHARING_GRANTS.length} sharing grant(s)`);
}
