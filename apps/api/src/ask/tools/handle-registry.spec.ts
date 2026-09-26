import { HandleRegistry, handleKindOf, isHandleShaped } from './handle-registry';

// =============================================================================
// HandleRegistry (#377): stable handles, per-kind counters, strict parsing,
// and the `toJSON` record #378 persists.
// =============================================================================

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';

describe('HandleRegistry', () => {
  it('issues per-kind counters starting at 1', () => {
    const r = new HandleRegistry();
    expect(r.register({ kind: 'ent', id: A })).toBe('ent1');
    expect(r.register({ kind: 'ent', id: B })).toBe('ent2');
    expect(r.register({ kind: 'itm', id: A })).toBe('itm1');
    expect(r.register({ kind: 'rel', id: A })).toBe('rel1');
    expect(r.register({ kind: 'ev', id: A })).toBe('ev1');
    expect(r.register({ kind: 'doc', id: A, documentKind: 'note' })).toBe('doc1');
  });

  it('returns the same handle for the same (kind, id)', () => {
    const r = new HandleRegistry();
    const first = r.register({ kind: 'ent', id: A, label: 'Acme' });
    expect(r.register({ kind: 'ent', id: A, label: 'Other label' })).toBe(first);
    expect(r.resolve(first)?.label).toBe('Acme');
    expect(r.issued().size).toBe(1);
  });

  it('fills a missing label on re-registration, never replaces one', () => {
    const r = new HandleRegistry();
    const h = r.register({ kind: 'ev', id: A });
    r.register({ kind: 'ev', id: A, label: 'Weekly sync' });
    expect(r.resolve(h)?.label).toBe('Weekly sync');
  });

  it('keys documents on startMs as well', () => {
    const r = new HandleRegistry();
    const at1 = r.register({ kind: 'doc', id: A, documentKind: 'transcript', startMs: 1500 });
    const at2 = r.register({ kind: 'doc', id: A, documentKind: 'transcript', startMs: 9000 });
    const again = r.register({ kind: 'doc', id: A, documentKind: 'transcript', startMs: 1500 });
    const noStart = r.register({ kind: 'doc', id: A, documentKind: 'transcript', startMs: null });
    expect([at1, at2, again, noStart]).toEqual(['doc1', 'doc2', 'doc1', 'doc3']);
    expect(r.resolve('doc2')).toEqual({ kind: 'doc', id: A, documentKind: 'transcript', startMs: 9000 });
  });

  it('resolves only issued handles, strictly', () => {
    const r = new HandleRegistry();
    r.register({ kind: 'ent', id: A });
    expect(r.resolve('ent1')?.id).toBe(A);
    for (const bad of ['ent2', 'ENT1', ' ent1', 'ent1 ', '[^ent1]', 'ent01', 'ent0', 'entity1', A, '', 'ev']) {
      expect(r.resolve(bad)).toBeNull();
    }
  });

  it('returns copies, so callers cannot mutate the registry', () => {
    const r = new HandleRegistry();
    r.register({ kind: 'ent', id: A, label: 'Acme' });
    r.resolve('ent1')!.label = 'Changed';
    (r.issued().get('ent1') as { label?: string }).label = 'Changed';
    expect(r.resolve('ent1')?.label).toBe('Acme');
  });

  it('serialises to a plain record and round-trips, continuing the counters', () => {
    const r = new HandleRegistry();
    r.register({ kind: 'ent', id: A, label: 'Acme' });
    r.register({ kind: 'ent', id: B });
    r.register({ kind: 'doc', id: A, documentKind: 'note', startMs: null });
    const json = r.toJSON();
    expect(json).toEqual({
      ent1: { kind: 'ent', id: A, label: 'Acme' },
      ent2: { kind: 'ent', id: B },
      doc1: { kind: 'doc', id: A, documentKind: 'note', startMs: null },
    });
    expect(JSON.parse(JSON.stringify(r))).toEqual(json);

    const back = HandleRegistry.fromJSON(json);
    expect(back.resolve('ent1')?.label).toBe('Acme');
    expect(back.register({ kind: 'ent', id: A })).toBe('ent1');
    expect(back.register({ kind: 'ent', id: '00000000-0000-4000-8000-000000000003' })).toBe('ent3');
  });

  it('skips malformed entries when rebuilding', () => {
    const back = HandleRegistry.fromJSON({
      bogus: { kind: 'ent', id: A },
      ent1: { kind: 'itm', id: A },
      itm4: { kind: 'itm', id: B },
    } as never);
    expect(back.resolve('ent1')).toBeNull();
    expect(back.resolve('itm4')?.id).toBe(B);
    expect(back.register({ kind: 'itm', id: A })).toBe('itm5');
  });

  it('refuses a target without an id or with an unknown kind', () => {
    const r = new HandleRegistry();
    expect(() => r.register({ kind: 'ent', id: '' })).toThrow();
    expect(() => r.register({ kind: 'xyz' as never, id: A })).toThrow();
  });

  it('exposes the handle grammar', () => {
    expect(isHandleShaped('ev12')).toBe(true);
    expect(isHandleShaped('ev')).toBe(false);
    expect(handleKindOf('rel3')).toBe('rel');
    expect(handleKindOf('foo3')).toBeNull();
  });
});
