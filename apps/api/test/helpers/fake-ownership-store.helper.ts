// =============================================================================
// Test helper: a LegacyObjectOwnershipStore for specs that mock Prisma
// =============================================================================
//
// PLATFORM-ADOPTION-SHIM(#469)
//
// `managed_by` / `part_size` are read through `LegacyObjectOwnershipStore`
// (raw SQL), which a mocked Prisma client cannot answer. This fake answers from
// the rows a spec already feeds to `storageObject.findUnique`, so fixtures keep
// carrying `managedBy` and `partSize` exactly as they did. The list queries
// (`selectObjectIds`, `countObjects`) answer from the spec's `findMany` and
// `count` mocks, and are `jest.fn`s so a spec can assert the filter it was
// given.
// =============================================================================

export function createFakeOwnershipStore(prismaMock: any) {
  const rowOf = async (id: string) => (await prismaMock.storageObject.findUnique({ where: { id } })) as any;

  return {
    getManagedBy: jest.fn(async (ids: readonly string[]) => {
      const owners = new Map<string, string | null>();
      for (const id of ids) owners.set(id, (await rowOf(id))?.managedBy ?? null);
      return owners;
    }),
    getPartSize: jest.fn(async (id: string) => (await rowOf(id))?.partSize ?? null),
    setManagedBy: jest.fn().mockResolvedValue(undefined),
    setPartSize: jest.fn().mockResolvedValue(undefined),
    unmanagedIdsAmong: jest.fn(async (ids: readonly string[]) => [...ids]),
    selectObjectIds: jest.fn(async () => {
      const rows = ((await prismaMock.storageObject.findMany({})) ?? []) as Array<{ id: string }>;
      return rows.map((row) => row.id);
    }),
    countObjects: jest.fn(async () => Number((await prismaMock.storageObject.count({})) ?? 0)),
    // Answers from the spec's `storageObject.aggregate` mock (the query the
    // `files` summary ran before the shim).
    summarizeUnmanaged: jest.fn(async () => {
      const aggregate = (await prismaMock.storageObject.aggregate({})) as any;
      return { count: aggregate?._count?._all ?? 0, bytes: aggregate?._sum?.size ?? BigInt(0) };
    }),
  };
}
