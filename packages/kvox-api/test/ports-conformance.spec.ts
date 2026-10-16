import { describeKvoxPortsConformance } from '../src/testing/index.js';
import { createFakeKvoxPortsUnderTest } from '../src/testing/index.js';

// The in-memory fakes must satisfy the same rules a real binding does: this is
// the kit running against its own reference implementation.
describeKvoxPortsConformance('fakes', createFakeKvoxPortsUnderTest, { describe, it, expect });
