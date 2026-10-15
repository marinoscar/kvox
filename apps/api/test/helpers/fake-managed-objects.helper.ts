// =============================================================================
// Test helper: a KvoxManagedObjects for specs that mock Prisma (issue #469)
// =============================================================================
//
// The domain modules read `storage_objects` through `KvoxManagedObjectsService`
// (`src/kvox-objects/`), which runs every statement under `runInOrg`. A spec
// that mocks Prisma has no org scope to open, so this fake answers from the
// `storageObject.*` mocks the spec already feeds, keeping fixtures as they were:
// a row may carry `managedBy` (what `kvox_object_ownership` answers) and the
// lookups go to the same `jest.fn`s as before.
//
//   get / findFirst   -> storageObject.findUnique   (the lookups were `findUnique`)
//   findByKey         -> storageObject.findFirst
//   findMany / count  -> storageObject.findMany / count
//   sumSize / summarize -> storageObject.aggregate
//   setMetadata       -> storageObject.update
//   managedBy         -> the rows' `managedBy`, read through storageObject.findUnique
//
// Every method is a `jest.fn`, so a spec can assert the arguments it was given.
// =============================================================================

export function createFakeManagedObjects(prismaMock: any) {
  const rowOf = async (id: string) => (await prismaMock.storageObject.findUnique({ where: { id } })) as any;

  return {
    resolveOrg: jest.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
    get: jest.fn(async (id: string) => prismaMock.storageObject.findUnique({ where: { id } })),
    findFirst: jest.fn(async (args: any) => prismaMock.storageObject.findUnique(args)),
    findByKey: jest.fn(async (storageKey: string) => prismaMock.storageObject.findFirst({ where: { storageKey } })),
    findMany: jest.fn(async (args: any) => prismaMock.storageObject.findMany(args)),
    count: jest.fn(async (where: any) => prismaMock.storageObject.count({ where })),
    managedBy: jest.fn(async (ids: readonly string[]) => {
      const owners = new Map<string, string>();
      for (const id of ids) {
        const owner = (await rowOf(id))?.managedBy;
        if (owner) owners.set(id, owner);
      }
      return owners;
    }),
    sumSize: jest.fn(async (where: any) => {
      const aggregate = (await prismaMock.storageObject.aggregate({ where, _sum: { size: true } })) as any;
      return (aggregate?._sum?.size ?? BigInt(0)) as bigint;
    }),
    summarize: jest.fn(async (where: any) => {
      const aggregate = (await prismaMock.storageObject.aggregate({ where })) as any;
      return { count: aggregate?._count?._all ?? 0, bytes: (aggregate?._sum?.size ?? BigInt(0)) as bigint };
    }),
    setMetadata: jest.fn(async (id: string, metadata: Record<string, unknown>) =>
      prismaMock.storageObject.update({ where: { id }, data: { metadata } }),
    ),
    setSize: jest.fn(async (id: string, size: number) =>
      prismaMock.storageObject.update({ where: { id }, data: { size: BigInt(size) } }),
    ),
    create: jest.fn(async (input: any) =>
      prismaMock.storageObject.create({ data: { storageKey: input.key, name: input.name, size: BigInt(input.size) } }),
    ),
    signedDownloadUrl: jest.fn().mockResolvedValue(null),
    openStream: jest.fn().mockResolvedValue(null),
    deleteManaged: jest.fn().mockResolvedValue(undefined),
    initManagedUpload: jest.fn(),
  };
}
