import { readKgPurgePayload } from './kg-purge.payload';

// The two `kg.purge` payload shapes (#357), and `null` for everything else.

const USER = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';

describe('readKgPurgePayload', () => {
  it('reads scope "all"', () => {
    expect(readKgPurgePayload({ userId: USER, scope: 'all' })).toEqual({ userId: USER, scope: 'all' });
  });

  it('reads scope "person" with its entity', () => {
    expect(readKgPurgePayload({ userId: USER, scope: 'person', entityId: ENTITY })).toEqual({
      userId: USER,
      scope: 'person',
      entityId: ENTITY,
    });
  });

  it('drops keys it does not know rather than carrying them through', () => {
    expect(readKgPurgePayload({ userId: USER, scope: 'all', entityId: ENTITY, extra: 1 })).toEqual({
      userId: USER,
      scope: 'all',
    });
  });

  it.each([
    ['null', null],
    ['a string', 'all'],
    ['an array', [USER]],
    ['no userId', { scope: 'all' }],
    ['a non-uuid userId', { userId: 'user-1', scope: 'all' }],
    ['an unknown scope', { userId: USER, scope: 'everything' }],
    ['no scope', { userId: USER }],
    ['person without entityId', { userId: USER, scope: 'person' }],
    ['person with a non-uuid entityId', { userId: USER, scope: 'person', entityId: 'x' }],
  ])('is null for %s', (_label, value) => {
    expect(readKgPurgePayload(value)).toBeNull();
  });
});
