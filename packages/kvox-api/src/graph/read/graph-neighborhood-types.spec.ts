import { GraphNeighborhoodService } from './graph-neighborhood.service.js';

// #764: the node type filter applies to seeds too (no seed exemption).

/** Flattens a tagged-template call (strings + nested Prisma.sql values) to its SQL text. */
function sqlText(args: unknown[]): string {
  const strings = args[0] as readonly string[];
  return strings
    .map((str, i) => {
      const v = args[i + 1];
      const nested = v as { strings?: readonly string[]; sql?: string } | undefined;
      const inner = nested && (nested.sql ?? (nested.strings ? nested.strings.join('?') : undefined));
      return str + (inner ?? '');
    })
    .join('');
}

describe('GraphNeighborhoodService type filter', () => {
  const svc = new GraphNeighborhoodService({} as never, {} as never, {} as never);

  it('loadEntities filters by type only: a seed of another type is not exempt', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    await svc.loadEntities({ $queryRaw: queryRaw } as never, 'o', ['a'], { entityTypes: ['Person'], itemKinds: [] });
    const text = sqlText(queryRaw.mock.calls[0]!);
    expect(text).toContain('e.type = ANY(');
    expect(text).not.toMatch(/OR\s+e\.id\s*=\s*ANY/);
  });

  it('loadItems filters by kind only', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    await svc.loadItems({ $queryRaw: queryRaw } as never, 'o', ['a'], { entityTypes: [], itemKinds: ['commitment'] });
    const text = sqlText(queryRaw.mock.calls[0]!);
    expect(text).toContain('i.kind::text = ANY(');
    expect(text).not.toMatch(/OR\s+i\.id\s*=\s*ANY/);
  });

  it('an empty filter matches nothing (ANY of an empty list)', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const tx = { $queryRaw: queryRaw } as never;
    await expect(svc.loadEntities(tx, 'o', ['a'], { entityTypes: [], itemKinds: [] })).resolves.toEqual([]);
  });
});
