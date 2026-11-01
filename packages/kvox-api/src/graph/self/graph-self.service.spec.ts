import { GraphSelfService } from './graph-self.service.js';

// =============================================================================
// GraphSelfService (#778): resolve follows merges and refuses what is not a live Person of the user
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Row {
  id: string;
  ownerId: string;
  type: string;
  label: string;
  reviewStatus: string;
  mergedIntoId: string | null;
  aliases: Array<{ alias: string }>;
}

function row(partial: Partial<Row> & Pick<Row, 'id'>): Row {
  return { ownerId: USER, type: 'Person', label: 'Avery Example', reviewStatus: 'accepted', mergedIntoId: null, aliases: [], ...partial };
}

function build(rows: Row[], selfId: string | null, users: unknown[] = [], suggestIds: string[] = []) {
  const prisma = {
    kgEntity: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; ownerId: string } }) =>
        rows.find((r) => r.id === where.id && r.ownerId === where.ownerId) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => rows.filter((r) => where.id.in.includes(r.id))),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      return strings.join('?').includes('FROM users') ? users : suggestIds.map((id) => ({ id }));
    }),
  };
  const preferences = { get: jest.fn(async () => ({ self: { entityId: selfId } })) };
  return { service: new GraphSelfService(prisma as never, preferences as never), prisma };
}

describe('GraphSelfService', () => {
  it('resolves nothing when no entity is chosen', async () => {
    const { service, prisma } = build([row({ id: A })], null);
    expect(await service.resolve(USER)).toBeNull();
    expect(prisma.kgEntity.findFirst).not.toHaveBeenCalled();
  });

  it('resolves a live Person with its aliases (the label is not repeated)', async () => {
    const { service } = build([row({ id: A, aliases: [{ alias: 'Avery Example' }, { alias: 'Avery' }] })], A);
    expect(await service.resolve(USER)).toEqual({ entityId: A, label: 'Avery Example', aliases: ['Avery'] });
  });

  it('follows a merge to the survivor', async () => {
    const { service } = build(
      [row({ id: A, reviewStatus: 'merged', mergedIntoId: B }), row({ id: B, label: 'Avery E.', reviewStatus: 'edited' })],
      A,
    );
    expect((await service.resolve(USER))?.entityId).toBe(B);
  });

  it('gives up on a merge cycle, another type, another owner, a rejected row and a missing row', async () => {
    const cycle = build([row({ id: A, reviewStatus: 'merged', mergedIntoId: B }), row({ id: B, reviewStatus: 'merged', mergedIntoId: A })], A);
    expect(await cycle.service.resolve(USER)).toBeNull();
    expect(await build([row({ id: A, type: 'Organization' })], A).service.resolve(USER)).toBeNull();
    expect(await build([row({ id: A, ownerId: 'someone-else' })], A).service.resolve(USER)).toBeNull();
    expect(await build([row({ id: A, reviewStatus: 'rejected' })], A).service.resolve(USER)).toBeNull();
    expect(await build([], A).service.resolve(USER)).toBeNull();
  });

  it('suggests Persons matching the profile name, and nothing without a name', async () => {
    const { service } = build([row({ id: A })], null, [{ display_name: 'Avery Example', provider_display_name: null }], [A]);
    expect(await service.suggest(USER)).toEqual([{ entityId: A, label: 'Avery Example', aliases: [] }]);
    const none = build([row({ id: A })], null, [{ display_name: null, provider_display_name: ' ' }], [A]);
    expect(await none.service.suggest(USER)).toEqual([]);
  });

  it('describe offers suggestions only while nothing is chosen', async () => {
    const users = [{ display_name: 'Avery Example', provider_display_name: null }];
    const chosen = build([row({ id: A })], A, users, [A]);
    expect(await chosen.service.describe(USER)).toMatchObject({ self: { entityId: A }, suggestions: [] });
    const open = build([row({ id: A })], null, users, [A]);
    const answer = await open.service.describe(USER);
    expect(answer.self).toBeNull();
    expect(answer.suggestions).toHaveLength(1);
  });
});
