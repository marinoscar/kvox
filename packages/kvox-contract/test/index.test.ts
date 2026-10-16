import { describe, expect, it } from 'vitest';

import { KVOX_CONTRACT_PACKAGE } from '../src/index.js';

describe('@marinoscar/kvox-contract scaffold', () => {
  it('exports its package name', () => {
    expect(KVOX_CONTRACT_PACKAGE).toBe('@marinoscar/kvox-contract');
  });
});
