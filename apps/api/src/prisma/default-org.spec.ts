import { getDefaultOrgId, resetDefaultOrgCache } from './default-org';

// PLATFORM-ADOPTION-SHIM(#469): the default organization is resolved once and cached.

function fakePrisma(result: { id: string } | null | Error) {
  const findFirst = jest.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { prisma: { organization: { findFirst } } as never, findFirst };
}

describe('getDefaultOrgId', () => {
  beforeEach(() => resetDefaultOrgCache());

  it('looks up the organization flagged is_default', async () => {
    const { prisma, findFirst } = fakePrisma({ id: 'org-1' });

    await expect(getDefaultOrgId(prisma)).resolves.toBe('org-1');
    expect(findFirst).toHaveBeenCalledWith({ where: { isDefault: true }, select: { id: true } });
  });

  it('queries once, however many callers ask — including concurrent first callers', async () => {
    const { prisma, findFirst } = fakePrisma({ id: 'org-1' });

    const ids = await Promise.all([getDefaultOrgId(prisma), getDefaultOrgId(prisma)]);
    await getDefaultOrgId(prisma);

    expect(ids).toEqual(['org-1', 'org-1']);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('throws when there is no default organization, and does not cache the failure', async () => {
    const missing = fakePrisma(null);
    await expect(getDefaultOrgId(missing.prisma)).rejects.toThrow(/No default organization/);

    const seeded = fakePrisma({ id: 'org-2' });
    await expect(getDefaultOrgId(seeded.prisma)).resolves.toBe('org-2');
  });

  it('does not cache a failed lookup', async () => {
    const broken = fakePrisma(new Error('db down'));
    await expect(getDefaultOrgId(broken.prisma)).rejects.toThrow('db down');

    const healthy = fakePrisma({ id: 'org-3' });
    await expect(getDefaultOrgId(healthy.prisma)).resolves.toBe('org-3');
  });
});
