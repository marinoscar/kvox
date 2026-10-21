import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadPins, savePins } from '../../../src/graph/ui/components/explorer/layout/pins.js';

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('pins', () => {
  it('round-trips per view and removes the entry when empty', () => {
    savePins('view-a', new Map([['n1', { x: 1.5, y: -2 }]]));
    savePins('view-b', new Map([['n2', { x: 3, y: 4 }]]));

    expect([...loadPins('view-a')]).toEqual([['n1', { x: 1.5, y: -2 }]]);
    expect([...loadPins('view-b')]).toEqual([['n2', { x: 3, y: 4 }]]);

    savePins('view-a', new Map());
    expect(loadPins('view-a').size).toBe(0);
    expect(loadPins('view-b').size).toBe(1);
  });

  it('ignores corrupt data', () => {
    sessionStorage.setItem('kvox.graph.pins:bad', '{not json');
    expect(loadPins('bad').size).toBe(0);
    sessionStorage.setItem('kvox.graph.pins:odd', JSON.stringify({ a: { x: 'nope', y: 1 }, b: { x: 1, y: 2 } }));
    expect([...loadPins('odd').keys()]).toEqual(['b']);
  });

  it('works without storage: reads are empty and writes do not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadPins('x').size).toBe(0);
    expect(() => savePins('x', new Map([['n', { x: 1, y: 1 }]]))).not.toThrow();
  });
});
