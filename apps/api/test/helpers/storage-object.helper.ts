// =============================================================================
// Test helper: create a storage_objects row the way the platform schema wants it
// =============================================================================
//
// For the real-Postgres (`*.db.spec.ts`) suites that need an object row as a
// fixture.
//
//   - `org_id` is NOT NULL on `storage_objects` (an org table, platform
//     `0025_org_scoped_rls`). A fixture that names no organization gets the
//     default one (`organizations WHERE is_default`, created by the platform
//     migrations).
//   - Which module owns an object lives in `kvox_object_ownership` (#469), not
//     on the row. A fixture keeps passing `managedBy` inside `data` as it always
//     did; this helper strips it and writes the ownership row.
//
// These fixtures write through the plain client on purpose: the suites connect
// as a superuser, which row-level security does not apply to. Application code
// never does this; it goes through `KvoxManagedObjects`.
// =============================================================================

interface FixtureClient {
  storageObject: { create: (args: any) => Promise<any> };
  kvoxObjectOwnership: {
    create: (args: any) => Promise<any>;
    findUnique: (args: any) => Promise<{ managedBy: string } | null>;
    findMany: (args: any) => Promise<Array<{ objectId: string }>>;
  };
  organization: { findFirst: (args: any) => Promise<{ id: string } | null> };
}

const orgIds = new WeakMap<object, Promise<string>>();

/** The default organization's id for this client, resolved once. */
export function defaultOrgId(client: unknown): Promise<string> {
  const db = client as FixtureClient;
  let cached = orgIds.get(db);
  if (!cached) {
    cached = db.organization.findFirst({ where: { isDefault: true }, select: { id: true } }).then((org) => {
      if (!org) throw new Error('No default organization; run the platform migrations and seed.');
      return org.id;
    });
    orgIds.set(db, cached);
  }
  return cached;
}

/** The module that owns one object (`kvox_object_ownership.managed_by`), or null. */
export async function managedByOf(client: unknown, id: string): Promise<string | null> {
  const row = await (client as FixtureClient).kvoxObjectOwnership.findUnique({ where: { objectId: id }, select: { managedBy: true } });
  return row?.managedBy ?? null;
}

/** Ids of the objects owned by `owner` (optionally within an uploader and key prefix). */
export async function idsManagedBy(
  client: unknown,
  owner: string,
  filter: { storageKeyPrefix?: string; uploadedByIds?: string[] } = {},
): Promise<string[]> {
  const rows = await (client as FixtureClient).kvoxObjectOwnership.findMany({
    where: {
      managedBy: owner,
      object: {
        ...(filter.storageKeyPrefix ? { storageKey: { startsWith: filter.storageKeyPrefix } } : {}),
        ...(filter.uploadedByIds ? { uploadedById: { in: filter.uploadedByIds } } : {}),
      },
    },
    select: { objectId: true },
  });
  return rows.map((row) => row.objectId);
}

/**
 * `prisma.storageObject.create(args)` with `orgId` defaulted; `managedBy` in
 * `data` also writes the ownership row and is handed back on the returned row.
 */
export async function createStorageObject(client: unknown, args: { data: Record<string, any>; [k: string]: any }): Promise<any> {
  const db = client as FixtureClient;
  const { managedBy, ...data } = args.data;
  const orgId = data.orgId ?? (await defaultOrgId(db));

  const row = await db.storageObject.create({ ...args, data: { ...data, orgId } });

  if (managedBy != null) {
    await db.kvoxObjectOwnership.create({ data: { objectId: row.id, orgId, managedBy } });
  }

  return { ...row, managedBy: managedBy ?? null };
}
