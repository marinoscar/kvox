import { describe, expect, it } from 'vitest';

import { KVOX_WEB_CORE } from '../src/core/index.js';

describe('@marinoscar/kvox-web scaffold', () => {
  it('exposes the core slice marker', () => {
    expect(KVOX_WEB_CORE).toBe('kvox-web/core');
  });

  it('runs in a DOM environment, like the slices that arrive in Epic 7', () => {
    expect(typeof document).toBe('object');
    expect(document.createElement('div').tagName).toBe('DIV');
  });
});
