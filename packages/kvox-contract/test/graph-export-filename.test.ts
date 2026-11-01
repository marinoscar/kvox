import { describe, expect, it } from 'vitest';

import { graphExportFilename } from '../src/graph/graph-export-formats.js';

describe('graphExportFilename', () => {
  // 2026-10-27T02:30Z is still the 26th in Chicago and already the 27th in Tokyo.
  const at = new Date('2026-10-27T02:30:00.000Z');

  it('dates the file by the owner day in their zone', () => {
    expect(graphExportFilename('kvox', at, 'turtle', 'America/Chicago')).toBe('kvox-graph-2026-10-26.ttl');
    expect(graphExportFilename('kvox', at, 'jsonld', 'Asia/Tokyo')).toBe('kvox-graph-2026-10-27.jsonld');
  });

  it('keeps the UTC day without a zone, or with one the runtime does not know', () => {
    expect(graphExportFilename('kvox', at, 'nquads')).toBe('kvox-graph-2026-10-27.nq');
    expect(graphExportFilename('kvox', at, 'nquads', 'Not/AZone')).toBe('kvox-graph-2026-10-27.nq');
  });
});
