import type { PrismaClient } from '@prisma/client';

import { seedNoteTemplates } from '@marinoscar/kvox-api/notes/templates';
import type { KvoxSecretsPort, KvoxSettingsPort } from '@marinoscar/kvox-api/ports';

import { FAKE_PROVIDER_ID } from './fake-provider.js';

// =============================================================================
// What the host writes before the first request
// =============================================================================
//
// THE DOMAIN REFERENCES THREE HOST TABLES BY FOREIGN KEY AND ONE MORE BY VALUE:
//
//   users          every owner column (`transcripts.owner_id`, `notes.owner_id`, ...)
//   organizations  `transcripts.org_id` and `storage_objects.org_id` are NOT NULL
//   storage_objects / jobs   written by the object-store and jobs ports
//
// so a host with one user still needs one `organizations` row, flagged
// `is_default` (the slices resolve "the default organization" for a caller whose
// principal names none). The ids are fixed so a second start finds the same rows.
// =============================================================================

/** The one local user. */
export const LOCAL_USER_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Inserts the user and the built-in note templates and answers the organization.
 * Idempotent.
 *
 * The platform's own migrations already create the default organization (the
 * partial unique index `organizations_default_uniq_idx` allows exactly one), so
 * the host adopts it instead of inserting a second one; a host whose history
 * somehow lacks it creates it.
 *
 * @returns the id of the default organization.
 */
export async function seedDatabase(prisma: PrismaClient): Promise<string> {
  const existing = await prisma.organization.findFirst({ where: { isDefault: true }, select: { id: true } });
  const orgId =
    existing?.id ?? (await prisma.organization.create({ data: { name: 'Bare host', slug: 'barehost', isDefault: true }, select: { id: true } })).id;
  await prisma.user.upsert({
    where: { id: LOCAL_USER_ID },
    update: {},
    create: { id: LOCAL_USER_ID, email: 'local@barehost.invalid', displayName: 'Local user' },
  });
  await seedNoteTemplates(prisma);
  return orgId;
}

/**
 * Turns transcription on and names the fake provider. Runs AFTER the application
 * initialised: the `transcription` namespace and the secret purpose are declared
 * by the slice's `onModuleInit`, and the settings and secrets ports refuse an
 * unknown one.
 */
export async function seedRuntime(settings: KvoxSettingsPort, secrets: KvoxSecretsPort): Promise<void> {
  await settings.patchSystem('transcription', { enabled: true, provider: FAKE_PROVIDER_ID }, { actorUserId: LOCAL_USER_ID });
  await secrets.set('transcription', FAKE_PROVIDER_ID, 'not-a-real-key', LOCAL_USER_ID, { label: 'Fake provider' });
}
