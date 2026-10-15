// =============================================================================
// KvoxObjectOwnershipStore (issue #469)
// =============================================================================
//
// The `kvox_object_ownership` side table: which domain module (`transcripts`,
// `notes`, `graph`) owns a `storage_objects` row. It replaces the
// `storage_objects.managed_by` column the platform table does not have.
//
// Every method takes the transaction it runs in. The table has a composite
// foreign key `(object_id, org_id)` into the org-scoped `storage_objects`, so a
// row is only ever written or read inside `runInOrg` / `JobScope.run`: the
// caller (`KvoxManagedObjects`) owns the scope, this class only issues the
// statements.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/** The domain modules that can own a storage object. */
export type KvoxModule = 'transcripts' | 'notes' | 'graph';

/** Every {@link KvoxModule}, for validation. */
export const KVOX_MODULES: readonly KvoxModule[] = ['transcripts', 'notes', 'graph'];

/** The transaction client an ownership statement runs on. */
export type OwnershipTx = Pick<Prisma.TransactionClient, 'kvoxObjectOwnership'>;

/** Narrow a stored string to a {@link KvoxModule}, or null for an unknown value. */
export function asKvoxModule(value: string | null | undefined): KvoxModule | null {
  return value && (KVOX_MODULES as readonly string[]).includes(value) ? (value as KvoxModule) : null;
}

@Injectable()
export class KvoxObjectOwnershipStore {
  /** Record that `module` owns an object. Idempotent for the same module. */
  async stamp(
    tx: OwnershipTx,
    input: { objectId: string; orgId: string; module: KvoxModule },
  ): Promise<void> {
    await tx.kvoxObjectOwnership.upsert({
      where: { objectId: input.objectId },
      create: { objectId: input.objectId, orgId: input.orgId, managedBy: input.module },
      update: { managedBy: input.module },
    });
  }

  /** The owning module for each id. An unmanaged or unknown id is absent from the map. */
  async managedBy(tx: OwnershipTx, ids: readonly string[]): Promise<Map<string, KvoxModule>> {
    const result = new Map<string, KvoxModule>();
    if (ids.length === 0) return result;

    const rows = await tx.kvoxObjectOwnership.findMany({
      where: { objectId: { in: [...ids] } },
      select: { objectId: true, managedBy: true },
    });
    for (const row of rows) {
      const module = asKvoxModule(row.managedBy);
      if (module) result.set(row.objectId, module);
    }
    return result;
  }

  /** The subset of `ids` that no module owns (ids that do not exist are dropped by the caller's own read). */
  async unmanagedAmong(tx: OwnershipTx, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const owned = await this.managedBy(tx, ids);
    return ids.filter((id) => !owned.has(id));
  }
}
