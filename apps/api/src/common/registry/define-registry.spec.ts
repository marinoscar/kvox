import {
  DEFAULT_REGISTRY_ID_PATTERN,
  Registry,
  RegistryError,
  defineRegistry,
  freezeAllRegistries,
  listDefinedRegistries,
} from './define-registry';
import { RegistryFreezeService } from './registry-freeze.service';
import { resetRegistryForTests, withTemporaryEntries } from './testing';

interface Item {
  id: string;
  value?: number;
}

function make(overrides: Partial<ConstructorParameters<typeof Registry<Item>>[0]> = {}): Registry<Item> {
  return new Registry<Item>({ name: 'items', idOf: (i) => i.id, ...overrides });
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof RegistryError ? err.code : `non-registry:${String(err)}`;
  }
  return undefined;
}

describe('Registry', () => {
  describe('ids', () => {
    it('accepts the default id shapes', () => {
      const r = make();
      r.registerAll([{ id: 'db.connection' }, { id: 'jobs:read' }, { id: 'a-b_c/d@e' }]);
      expect(r.ids()).toEqual(['db.connection', 'jobs:read', 'a-b_c/d@e']);
    });

    it.each(['', ' x', '.x', 'a b', 'x'.repeat(129)])('rejects invalid id %p', (id) => {
      expect(codeOf(() => make().register({ id }))).toBe('INVALID_ID');
    });

    it('rejects a non-string id', () => {
      const r = new Registry<{ id: unknown }>({ name: 'x', idOf: (e) => e.id as string });
      expect(codeOf(() => r.register({ id: 5 }))).toBe('INVALID_ID');
    });

    it('honours a custom idPattern and ignores the g flag', () => {
      const r = make({ idPattern: /^[a-z][A-Za-z0-9]*$/g });
      r.register({ id: 'abc' });
      r.register({ id: 'def' });
      expect(codeOf(() => r.register({ id: 'Abc' }))).toBe('INVALID_ID');
      expect(DEFAULT_REGISTRY_ID_PATTERN.test('ok')).toBe(true);
    });

    it('rejects an empty registry name', () => {
      expect(codeOf(() => new Registry<Item>({ name: ' ', idOf: (i) => i.id }))).toBe('INVALID_ID');
    });
  });

  describe('duplicates', () => {
    it('throws DUPLICATE_ID by default and leaves the registry unchanged', () => {
      const r = make();
      r.register({ id: 'a', value: 1 });
      expect(codeOf(() => r.register({ id: 'a', value: 2 }))).toBe('DUPLICATE_ID');
      expect(r.get('a')?.value).toBe(1);
    });

    it('uses describeDuplicate for the message', () => {
      const r = make({ describeDuplicate: (_e, i) => `dup ${i.id}` });
      r.register({ id: 'a' });
      expect(() => r.register({ id: 'a' })).toThrow('dup a');
    });

    it('replace keeps the old position and calls onReplace', () => {
      const onReplace = jest.fn();
      const r = make({ onDuplicate: 'replace', onReplace });
      r.registerAll([{ id: 'a', value: 1 }, { id: 'b' }]);
      r.register({ id: 'a', value: 2 });
      expect(r.list().map((i) => `${i.id}:${i.value ?? '-'}`)).toEqual(['a:2', 'b:-']);
      expect(onReplace).toHaveBeenCalledWith({ id: 'a', value: 1 }, { id: 'a', value: 2 });
    });
  });

  describe('registerAll', () => {
    it('is all or nothing when a later entry is invalid', () => {
      const r = make();
      r.register({ id: 'keep' });
      expect(codeOf(() => r.registerAll([{ id: 'a' }, { id: 'b' }, { id: ' bad' }]))).toBe('INVALID_ID');
      expect(r.ids()).toEqual(['keep']);
    });

    it('detects duplicates inside one batch', () => {
      const r = make();
      expect(codeOf(() => r.registerAll([{ id: 'a' }, { id: 'a' }]))).toBe('DUPLICATE_ID');
      expect(r.size).toBe(0);
    });

    it('wraps a validate throw as INVALID_ENTRY with the cause', () => {
      const cause = new Error('nope');
      const r = make({
        validate: () => {
          throw cause;
        },
      });
      try {
        r.register({ id: 'a' });
        throw new Error('expected a throw');
      } catch (err) {
        expect(err).toBeInstanceOf(RegistryError);
        expect((err as RegistryError).code).toBe('INVALID_ENTRY');
        expect((err as RegistryError).message).toContain('nope');
        expect((err as Error).cause).toBe(cause);
      }
      expect(r.size).toBe(0);
    });
  });

  describe('order', () => {
    it('defaults to registration order', () => {
      const r = make();
      r.registerAll([{ id: 'b' }, { id: 'a' }]);
      expect(r.ids()).toEqual(['b', 'a']);
    });

    it("'id' sorts by code unit", () => {
      const r = make({ order: 'id' });
      r.registerAll([{ id: 'a' }, { id: 'B' }]);
      expect(r.ids()).toEqual(['B', 'a']);
    });

    it('a comparator sorts entries', () => {
      const r = make({ order: (a, b) => (b.value ?? 0) - (a.value ?? 0) });
      r.registerAll([{ id: 'a', value: 1 }, { id: 'b', value: 3 }]);
      expect(r.ids()).toEqual(['b', 'a']);
    });

    it('list() returns a fresh array', () => {
      const r = make();
      r.register({ id: 'a' });
      r.list().pop();
      expect(r.size).toBe(1);
    });
  });

  describe('reads', () => {
    it('get/has/require', () => {
      const r = make();
      r.register({ id: 'a' });
      expect(r.has('a')).toBe(true);
      expect(r.get('zz')).toBeUndefined();
      expect(r.require('a').id).toBe('a');
      expect(codeOf(() => r.require('zz'))).toBe('UNKNOWN_ID');
    });
  });

  describe('freeze', () => {
    it('refuses writes with FROZEN, keeps reads, and is idempotent', () => {
      const r = make();
      r.register({ id: 'a' });
      expect(r.isFrozen()).toBe(false);
      r.freeze();
      r.freeze();
      expect(r.isFrozen()).toBe(true);
      expect(r.frozen).toBe(true);
      expect(codeOf(() => r.register({ id: 'b' }))).toBe('FROZEN');
      expect(codeOf(() => r.registerAll([]))).toBe('FROZEN');
      expect(r.ids()).toEqual(['a']);
      expect(r.snapshot()).toEqual({ name: 'items', frozen: true, ids: ['a'] });
    });
  });
});

describe('defineRegistry catalogue', () => {
  it('rejects a second registry with the same name (DUPLICATE_REGISTRY)', () => {
    defineRegistry<Item>({ name: 'spec-catalogue-dup', idOf: (i) => i.id });
    expect(codeOf(() => defineRegistry<Item>({ name: 'spec-catalogue-dup', idOf: (i) => i.id }))).toBe(
      'DUPLICATE_REGISTRY',
    );
  });

  it('lists defined registries, and freezeAllRegistries / RegistryFreezeService freeze them', () => {
    const r = defineRegistry<Item>({ name: 'spec-catalogue-freeze', idOf: (i) => i.id });
    expect(listDefinedRegistries()).toContain(r);
    expect(r.isFrozen()).toBe(false);
    freezeAllRegistries();
    expect(r.isFrozen()).toBe(true);

    const r2 = defineRegistry<Item>({ name: 'spec-catalogue-freeze-2', idOf: (i) => i.id });
    new RegistryFreezeService().onApplicationBootstrap();
    expect(r2.isFrozen()).toBe(true);
  });
});

describe('testing kit', () => {
  it('resetRegistryForTests empties and unfreezes', () => {
    const r = make();
    r.register({ id: 'a' });
    r.freeze();
    resetRegistryForTests(r);
    expect(r.size).toBe(0);
    expect(r.isFrozen()).toBe(false);
  });

  it('withTemporaryEntries restores entries and frozen state', async () => {
    const r = make();
    r.register({ id: 'a' });
    r.freeze();
    await withTemporaryEntries(r, [{ id: 'tmp' }], () => {
      expect(r.has('tmp')).toBe(true);
    });
    expect(r.ids()).toEqual(['a']);
    expect(r.isFrozen()).toBe(true);
  });
});
