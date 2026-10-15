// =============================================================================
// Test helper: create a storage_objects row the way the platform schema wants it
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(#469)
//
// Two things changed under every fixture that inserts into `storage_objects`:
//
//   - `org_id` is NOT NULL (platform `0025_org_scoped_rls`). A fixture that
//     names no organization gets the default one (`organizations WHERE
//     is_default`, created by the platform migrations).
//   - `managed_by` and `part_size` are no longer on the Prisma client (they are
//     declared deviations). They are written with raw SQL right after the
//     insert, and handed back on the returned row so `object.managedBy` reads
//     keep working.
//
// Fixtures keep passing `managedBy` / `partSize` inside `data` exactly as they
// did; this helper strips them out. #469 deletes it with the legacy store.
// =============================================================================

interface RawCapableClient {
  storageObject: { create: (args: any) => Promise<any> };
  organization: { findFirst: (args: any) => Promise<{ id: string } | null> };
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;
}

const orgIds = new WeakMap<object, Promise<string>>();

/** The default organization's id for this client, resolved once. */
export function defaultOrgId(client: unknown): Promise<string> {
  const db = client as RawCapableClient;
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

/** `managed_by` of one object, read with raw SQL. */
export async function managedByOf(client: unknown, id: string): Promise<string | null> {
  const rows = await (client as RawCapableClient).$queryRaw`SELECT managed_by FROM storage_objects WHERE id = ${id}::uuid`;
  return rows[0]?.managed_by ?? null;
}

/** Ids of the objects stamped `managed_by = <owner>` (optionally within an uploader and key prefix). */
export async function idsManagedBy(
  client: unknown,
  owner: string,
  filter: { storageKeyPrefix?: string; uploadedByIds?: string[] } = {},
): Promise<string[]> {
  const rows: Array<{ id: string }> = await (client as RawCapableClient).$queryRaw`
    SELECT id::text AS id FROM storage_objects
    WHERE managed_by = ${owner}
      AND (${filter.storageKeyPrefix ?? null}::text IS NULL OR storage_key LIKE ${(filter.storageKeyPrefix ?? '') + '%'})
      AND (${filter.uploadedByIds ?? null}::uuid[] IS NULL OR uploaded_by_id = ANY(${filter.uploadedByIds ?? null}::uuid[]))
  `;
  return rows.map((row) => row.id);
}

/** `prisma.storageObject.create(args)` with `orgId` defaulted and `managedBy` / `partSize` written in SQL. */
export async function createStorageObject(client: unknown, args: { data: Record<string, any>; [k: string]: any }): Promise<any> {
  const db = client as RawCapableClient;
  const { managedBy, partSize, ...data } = args.data;
  const orgId = data.orgId ?? (await defaultOrgId(db));

  const row = await db.storageObject.create({ ...args, data: { ...data, orgId } });

  if (managedBy != null) {
    await db.$executeRaw`UPDATE storage_objects SET managed_by = ${managedBy} WHERE id = ${row.id}::uuid`;
  }
  if (partSize != null) {
    await db.$executeRaw`UPDATE storage_objects SET part_size = ${partSize} WHERE id = ${row.id}::uuid`;
  }

  return { ...row, managedBy: managedBy ?? null, partSize: partSize ?? null };
}
