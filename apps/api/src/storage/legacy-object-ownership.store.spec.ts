import type { Prisma } from '@prisma/client';

import { LegacyObjectOwnershipStore } from './legacy-object-ownership.store';

// PLATFORM-ADOPTION-SHIM(#469): raw SQL over storage_objects.managed_by / part_size.

function makeStore(rows: unknown[] = []) {
  const queryRaw = jest.fn().mockResolvedValue(rows);
  const executeRaw = jest.fn().mockResolvedValue(1);
  const store = new LegacyObjectOwnershipStore({ $queryRaw: queryRaw, $executeRaw: executeRaw } as never);
  const query = () => queryRaw.mock.calls[0][0] as Prisma.Sql;
  return { store, queryRaw, executeRaw, query };
}

describe('LegacyObjectOwnershipStore', () => {
  it('getManagedBy maps ids to their owner, null for unmanaged, absent for unknown', async () => {
    const { store } = makeStore([
      { id: 'a', managed_by: 'notes' },
      { id: 'b', managed_by: null },
    ]);

    const owners = await store.getManagedBy(['a', 'b', 'c']);

    expect(owners.get('a')).toBe('notes');
    expect(owners.get('b')).toBeNull();
    expect(owners.has('c')).toBe(false);
  });

  it('getManagedBy and unmanagedIdsAmong skip the query for no ids', async () => {
    const { store, queryRaw } = makeStore();

    expect((await store.getManagedBy([])).size).toBe(0);
    expect(await store.unmanagedIdsAmong([])).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('unmanagedIdsAmong asks for managed_by IS NULL', async () => {
    const { store, query } = makeStore([{ id: 'b' }]);

    await expect(store.unmanagedIdsAmong(['a', 'b'])).resolves.toEqual(['b']);
    expect(query().sql).toContain('managed_by IS NULL');
  });

  it('setManagedBy and setPartSize write through the transaction when one is given', async () => {
    const { store, executeRaw } = makeStore();
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };

    await store.setManagedBy('a', 'graph', tx as never);
    await store.setPartSize('a', 10485760, tx as never);
    await store.setManagedBy('b', 'notes');

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = tx.$executeRaw.mock.calls[0];
    expect(sql.join('?')).toContain('SET managed_by =');
    expect(values).toEqual(['graph', 'a']);
  });

  it('getPartSize returns null for a row without one, and for no row', async () => {
    expect(await makeStore([{ part_size: 5242880 }]).store.getPartSize('a')).toBe(5242880);
    expect(await makeStore([{ part_size: null }]).store.getPartSize('a')).toBeNull();
    expect(await makeStore([]).store.getPartSize('a')).toBeNull();
  });

  describe('selectObjectIds', () => {
    it('filters unmanaged rows, with the status cast and the update window', async () => {
      const before = new Date('2026-09-14T00:00:00Z');
      const { store, query } = makeStore([{ id: 'a' }, { id: 'b' }]);

      const ids = await store.selectObjectIds(
        { managed: 'unmanaged', uploadedById: 'u', statuses: ['pending'], updatedBefore: before, excludeIds: ['x'] },
        { orderBy: 'created_at', order: 'desc', skip: 20, take: 10 },
      );

      expect(ids).toEqual(['a', 'b']);
      const { sql, values } = query();
      expect(sql).toContain('managed_by IS NULL');
      expect(sql).toContain('uploaded_by_id = ?::uuid');
      expect(sql).toContain('::"StorageObjectStatus"');
      expect(sql).toContain('updated_at <');
      expect(sql).toContain('id NOT IN (');
      expect(sql).toContain('ORDER BY created_at DESC, id ASC');
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(values).toEqual(['u', 'pending', before, 'x', 10, 20]);
    });

    it('filters by owner and escapes LIKE wildcards in the key prefix', async () => {
      const { store, query } = makeStore([]);

      await store.selectObjectIds({ managed: { by: 'graph' }, storageKeyPrefix: 'graph/u_1/%/' });

      const { sql, values } = query();
      expect(sql).toContain('managed_by = ?');
      expect(sql).toContain('storage_key LIKE');
      expect(values).toEqual(['graph', 'graph/u\\_1/\\%/%']);
    });
  });

  it('countObjects and summarizeUnmanaged convert bigint results', async () => {
    expect(await makeStore([{ count: BigInt(7) }]).store.countObjects({ managed: 'unmanaged' })).toBe(7);

    const summary = await makeStore([{ count: BigInt(2), bytes: BigInt('9007199254740993') }]).store.summarizeUnmanaged('u');
    expect(summary).toEqual({ count: 2, bytes: BigInt('9007199254740993') });
  });
});
