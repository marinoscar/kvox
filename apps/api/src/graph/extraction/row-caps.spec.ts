// =============================================================================
// extractionRowCaps / halveRowCaps (#435, epic #346)
// =============================================================================
//
//   usable     = max(0, maxOutputTokens − REASONING_HEADROOM_TOKENS[effort]) × 0.8
//   total rows = floor(usable / EXTRACTION_TOKENS_PER_ROW), clamped to [15, 400]
//   split      = entities 35% / relations 35% / items 30%, each at least 5
// =============================================================================

import { EXTRACTION_TOKENS_PER_ROW, extractionRowCaps, halveRowCaps } from './row-caps';

describe('extractionRowCaps', () => {
  it('sizes the split from the usable share of the output ceiling, with no reasoning headroom subtracted', () => {
    // usable = 16,000 * 0.8 = 12,800; total = floor(12,800 / 160) = 80.
    const caps = extractionRowCaps(16_000, 'none');

    expect(caps).toEqual({
      entities: Math.floor(80 * 0.35), // 28
      relations: Math.floor(80 * 0.35), // 28
      items: Math.floor(80 * 0.3), // 24
    });
  });

  it('subtracts the reasoning headroom for the given effort before sizing rows', () => {
    // usable = max(0, 32_000 - 16_384) * 0.8 = 15_616 * 0.8 = 12_492.8;
    // total = floor(12_492.8 / 160) = 78.
    const caps = extractionRowCaps(32_000, 'medium');
    const total = caps.entities + caps.relations + caps.items;

    expect(caps.entities).toBe(Math.floor(78 * 0.35));
    expect(caps.relations).toBe(Math.floor(78 * 0.35));
    expect(caps.items).toBe(Math.floor(78 * 0.3));
    expect(total).toBeLessThanOrEqual(78);
  });

  it('treats an unset (undefined/null) effort as "none" — zero headroom', () => {
    const withNone = extractionRowCaps(16_000, 'none');
    const withUndefined = extractionRowCaps(16_000, undefined);
    const withNull = extractionRowCaps(16_000, null);

    expect(withUndefined).toEqual(withNone);
    expect(withNull).toEqual(withNone);
  });

  it('never lets the headroom subtraction go negative — an output ceiling entirely eaten by headroom floors usable at 0', () => {
    // The 'xhigh' headroom (65,536) exceeds a 10,000-token ceiling.
    const caps = extractionRowCaps(10_000, 'xhigh');

    // usable = max(0, 10_000 - 65_536) * 0.8 = 0 -> total floors at MIN_TOTAL_ROWS (15).
    expect(caps.entities).toBe(5);
    expect(caps.relations).toBe(5);
    expect(caps.items).toBe(5);
  });

  it('clamps the total to a minimum of 15 rows for a tiny ceiling', () => {
    const caps = extractionRowCaps(100, 'none');
    const total = caps.entities + caps.relations + caps.items;

    // 15 * 0.35 = 5.25 -> floor 5 for entities/relations, 15 * 0.3 = 4.5 -> floor 4,
    // but each section is floored at MIN_PER_SECTION (5).
    expect(caps.entities).toBeGreaterThanOrEqual(5);
    expect(caps.relations).toBeGreaterThanOrEqual(5);
    expect(caps.items).toBeGreaterThanOrEqual(5);
    expect(total).toBeGreaterThanOrEqual(15);
  });

  it('clamps the total to a maximum of 400 rows for an enormous ceiling', () => {
    // usable = 10_000_000 * 0.8 = 8,000,000; total would be floor(8,000,000/160) = 50,000,
    // clamped down to 400.
    const caps = extractionRowCaps(10_000_000, 'none');
    const total = caps.entities + caps.relations + caps.items;

    expect(total).toBeLessThanOrEqual(400);
    expect(caps.entities).toBe(Math.floor(400 * 0.35));
    expect(caps.relations).toBe(Math.floor(400 * 0.35));
    expect(caps.items).toBe(Math.floor(400 * 0.3));
  });

  it('every section is at least MIN_PER_SECTION (5), even at the row-count floor', () => {
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh'] as const) {
      const caps = extractionRowCaps(0, effort);
      expect(caps.entities).toBeGreaterThanOrEqual(5);
      expect(caps.relations).toBeGreaterThanOrEqual(5);
      expect(caps.items).toBeGreaterThanOrEqual(5);
    }
  });

  it('splits entities/relations/items roughly 35/35/30, each an independent floor of its own share', () => {
    const caps = extractionRowCaps(160_000, 'none');
    // usable = 128,000; total = floor(128,000/160) = 800 -> clamped to 400.
    expect(caps).toEqual({
      entities: Math.floor(400 * 0.35), // 140
      relations: Math.floor(400 * 0.35), // 140
      items: Math.floor(400 * 0.3), // 120
    });
  });

  it('EXTRACTION_TOKENS_PER_ROW is the divisor used to convert usable tokens into rows', () => {
    const usableTokensForOneRow = EXTRACTION_TOKENS_PER_ROW / 0.8;
    // At exactly one row's worth of usable tokens, the total row count is 1,
    // clamped up to the MIN_TOTAL_ROWS floor (15).
    const caps = extractionRowCaps(usableTokensForOneRow, 'none');
    const total = caps.entities + caps.relations + caps.items;
    expect(total).toBeGreaterThanOrEqual(15);
  });
});

describe('halveRowCaps', () => {
  it('halves every cap, floored', () => {
    expect(halveRowCaps({ entities: 28, relations: 28, items: 24 })).toEqual({
      entities: 14,
      relations: 14,
      items: 12,
    });
  });

  it('floors an odd halved value down', () => {
    expect(halveRowCaps({ entities: 5, relations: 7, items: 9 })).toEqual({
      entities: 2,
      relations: 3,
      items: 4,
    });
  });

  it('never halves a cap below 1', () => {
    expect(halveRowCaps({ entities: 1, relations: 1, items: 1 })).toEqual({
      entities: 1,
      relations: 1,
      items: 1,
    });
  });

  it('halving twice keeps shrinking (the property the truncation retry relies on) without ever hitting 0', () => {
    let caps = extractionRowCaps(16_000, 'none');
    const first = caps.entities + caps.relations + caps.items;
    caps = halveRowCaps(caps);
    const second = caps.entities + caps.relations + caps.items;

    expect(second).toBeLessThan(first);
    expect(caps.entities).toBeGreaterThanOrEqual(1);
    expect(caps.relations).toBeGreaterThanOrEqual(1);
    expect(caps.items).toBeGreaterThanOrEqual(1);
  });
});
