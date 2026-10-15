import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/** The part of a Prisma client a store call can run on: the service or a transaction. */
type SqlClient = Pick<PrismaService, '$queryRaw' | '$executeRaw'>;

/** How `selectObjectIds` narrows `storage_objects` by ownership. */
export interface ObjectIdFilter {
  /** `'unmanaged'` is `managed_by IS NULL`; a module name is `managed_by = <name>`. */
  managed: 'unmanaged' | { by: string };
  uploadedById?: string;
  /** Matches any of these `StorageObjectStatus` values. */
  statuses?: readonly string[];
  updatedBefore?: Date;
  storageKeyPrefix?: string;
  excludeIds?: readonly string[];
}

export interface ObjectIdPage {
  orderBy?: 'created_at' | 'name' | 'size' | 'id';
  order?: 'asc' | 'desc';
  skip?: number;
  take?: number;
}

/**
 * PLATFORM-ADOPTION-SHIM(#469)
 *
 * `storage_objects.managed_by` and `part_size` are declared deviations from the
 * platform table (migration `20260914120000_add_storage_part_size_and_managed_by`),
 * so the composed Prisma client has neither field. Everything this app does with
 * them goes through this store, with raw SQL. #469 re-points it at
 * `kvox_object_ownership` and deletes it.
 *
 * Every write takes an optional `tx` so a caller can keep the row insert and
 * its ownership stamp in one transaction.
 */
@Injectable()
export class LegacyObjectOwnershipStore {
  constructor(private readonly prisma: PrismaService) {}

  /** `managed_by` for each id. An id with no row is absent from the map. */
  async getManagedBy(ids: readonly string[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    if (ids.length === 0) return result;

    const rows = await this.prisma.$queryRaw<Array<{ id: string; managed_by: string | null }>>(
      Prisma.sql`SELECT id::text AS id, managed_by FROM storage_objects WHERE id IN (${uuidList(ids)})`,
    );
    for (const row of rows) result.set(row.id, row.managed_by);
    return result;
  }

  /** Stamp the module that owns an object. */
  async setManagedBy(id: string, module: string, tx?: SqlClient): Promise<void> {
    await (tx ?? this.prisma).$executeRaw`
      UPDATE storage_objects SET managed_by = ${module} WHERE id = ${id}::uuid
    `;
  }

  /** The subset of `ids` whose `managed_by` is NULL (rows that do not exist are dropped). */
  async unmanagedIdsAmong(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id::text AS id FROM storage_objects WHERE managed_by IS NULL AND id IN (${uuidList(ids)})`,
    );
    return rows.map((row) => row.id);
  }

  /** The multipart part size recorded for an upload, or null for a row that predates it. */
  async getPartSize(id: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ part_size: number | null }>>`
      SELECT part_size FROM storage_objects WHERE id = ${id}::uuid
    `;
    return rows[0]?.part_size ?? null;
  }

  async setPartSize(id: string, partSize: number, tx?: SqlClient): Promise<void> {
    await (tx ?? this.prisma).$executeRaw`
      UPDATE storage_objects SET part_size = ${partSize} WHERE id = ${id}::uuid
    `;
  }

  /**
   * Ids of the objects matching `filter`, in `page.orderBy` order.
   *
   * The replacement for the Prisma `where: { managedBy: ... }` filters the
   * composed client can no longer express. A caller loads the rows with
   * `findMany({ where: { id: { in: ids } } })` and restores this order.
   */
  async selectObjectIds(filter: ObjectIdFilter, page: ObjectIdPage = {}): Promise<string[]> {
    const orderBy = Prisma.raw(
      { created_at: 'created_at', name: 'name', size: 'size', id: 'id' }[page.orderBy ?? 'id'],
    );
    const order = page.order === 'desc' ? Prisma.raw('DESC') : Prisma.raw('ASC');
    // A stable page: ties on the sort column fall back to the id.
    const tiebreak = page.orderBy && page.orderBy !== 'id' ? Prisma.raw(', id ASC') : Prisma.empty;
    const limit = page.take === undefined ? Prisma.empty : Prisma.sql`LIMIT ${page.take}`;
    const offset = page.skip ? Prisma.sql`OFFSET ${page.skip}` : Prisma.empty;

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id::text AS id FROM storage_objects
      WHERE ${objectFilterSql(filter)}
      ORDER BY ${orderBy} ${order}${tiebreak}
      ${limit} ${offset}
    `);
    return rows.map((row) => row.id);
  }

  /** How many objects match `filter`. */
  async countObjects(filter: ObjectIdFilter): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`SELECT count(*) AS count FROM storage_objects WHERE ${objectFilterSql(filter)}`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Count and total bytes of one user's unmanaged objects (the Danger Zone "files" summary). */
  async summarizeUnmanaged(uploadedById: string): Promise<{ count: number; bytes: bigint }> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint; bytes: bigint | null }>>`
      SELECT count(*) AS count, COALESCE(sum(size), 0)::bigint AS bytes
      FROM storage_objects
      WHERE uploaded_by_id = ${uploadedById}::uuid AND managed_by IS NULL
    `;
    return { count: Number(rows[0]?.count ?? 0), bytes: rows[0]?.bytes ?? BigInt(0) };
  }
}

function uuidList(ids: readonly string[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
}

function objectFilterSql(filter: ObjectIdFilter): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    filter.managed === 'unmanaged'
      ? Prisma.sql`managed_by IS NULL`
      : Prisma.sql`managed_by = ${filter.managed.by}`,
  ];

  if (filter.uploadedById) clauses.push(Prisma.sql`uploaded_by_id = ${filter.uploadedById}::uuid`);
  if (filter.statuses && filter.statuses.length > 0) {
    clauses.push(
      Prisma.sql`status IN (${Prisma.join(
        filter.statuses.map((status) => Prisma.sql`${status}::"StorageObjectStatus"`),
      )})`,
    );
  }
  if (filter.updatedBefore) clauses.push(Prisma.sql`updated_at < ${filter.updatedBefore}`);
  if (filter.storageKeyPrefix !== undefined) {
    // LIKE with the prefix's own wildcards escaped.
    const escaped = filter.storageKeyPrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    clauses.push(Prisma.sql`storage_key LIKE ${escaped + '%'}`);
  }
  if (filter.excludeIds && filter.excludeIds.length > 0) {
    clauses.push(Prisma.sql`id NOT IN (${uuidList(filter.excludeIds)})`);
  }

  return Prisma.join(clauses, ' AND ');
}
