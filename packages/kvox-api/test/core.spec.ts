import { KVOX_API_CORE } from '../src/core/index.js';
import { KVOX_API_PORTS } from '../src/ports/index.js';
import { KVOX_API_TESTING } from '../src/testing/index.js';

describe('@marinoscar/kvox-api scaffold', () => {
  it('exposes one marker per slice entry point', () => {
    expect(KVOX_API_CORE).toBe('kvox-api/core');
    expect(KVOX_API_PORTS).toBe('kvox-api/ports');
    expect(KVOX_API_TESTING).toBe('kvox-api/testing');
  });
});
