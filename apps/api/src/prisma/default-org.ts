import type { PrismaClient } from '@prisma/client';

// PLATFORM-ADOPTION-SHIM(#469)
//
// The platform made `storage_objects.org_id` NOT NULL (`0025_org_scoped_rls`),
// so every `storageObject.create` has to name an organization. This app is
// single-org until the storage slice lands (#469), so the organization is
// always the default one: `organizations WHERE is_default` (exactly one row,
// `organizations_default_uniq_idx`).
//
// Resolved once per process and cached. The cache holds the PROMISE, so
// concurrent first callers share one query; a failed lookup is dropped so the
// next caller retries instead of caching the failure.

type OrgLookup = Pick<PrismaClient, 'organization'>;

let cached: Promise<string> | null = null;

/** The default organization's id. Throws when the platform seed has not run. */
export function getDefaultOrgId(prisma: OrgLookup): Promise<string> {
  if (!cached) {
    cached = (async () => {
      const org = await prisma.organization.findFirst({ where: { isDefault: true }, select: { id: true } });
      if (!org) {
        throw new Error('No default organization (organizations.is_default). Run `npm run prisma:seed`.');
      }
      return org.id;
    })().catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

/** Test seam: forget the cached id. */
export function resetDefaultOrgCache(): void {
  cached = null;
}
