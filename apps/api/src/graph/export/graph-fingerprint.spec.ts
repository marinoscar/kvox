import { FINGERPRINT_TABLES, graphFingerprint, type GraphFingerprintInput } from './graph-fingerprint';

// =============================================================================
// graphFingerprint (#386) — the content address `POST /api/graph/exports`
// reuses an export on. Every input must move it; nothing else may.
// =============================================================================

function input(overrides: Partial<GraphFingerprintInput> = {}): GraphFingerprintInput {
  const tables = Object.fromEntries(
    FINGERPRINT_TABLES.map((t) => [t, { count: 3, lastChangedAt: '2026-09-01T10:00:00.000Z' }]),
  ) as GraphFingerprintInput['tables'];
  return { ontologyVersion: '1.2.0', format: 'turtle', namespace: 'https://fixture.app/ns#', tables, ...overrides };
}

describe('graphFingerprint', () => {
  it('is a stable lowercase hex SHA-256', () => {
    const fp = graphFingerprint(input());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(graphFingerprint(input())).toBe(fp);
  });

  it('does not depend on the order the tables are given in', () => {
    const base = input();
    const reversed = Object.fromEntries(Object.entries(base.tables).reverse()) as GraphFingerprintInput['tables'];
    expect(graphFingerprint({ ...base, tables: reversed })).toBe(graphFingerprint(base));
  });

  it('moves with the format, the ontology version and the namespace', () => {
    const fp = graphFingerprint(input());
    expect(graphFingerprint(input({ format: 'jsonld' }))).not.toBe(fp);
    expect(graphFingerprint(input({ ontologyVersion: '1.3.0' }))).not.toBe(fp);
    expect(graphFingerprint(input({ namespace: 'https://other.app/ns#' }))).not.toBe(fp);
  });

  it.each(FINGERPRINT_TABLES)('moves when %s gains or loses a row, or changes', (table) => {
    const base = input();
    const fp = graphFingerprint(base);
    const withCount = { ...base.tables, [table]: { ...base.tables[table], count: 4 } };
    const withTime = { ...base.tables, [table]: { ...base.tables[table], lastChangedAt: '2026-09-01T10:00:01.000Z' } };
    const emptied = { ...base.tables, [table]: { count: 0, lastChangedAt: null } };
    expect(graphFingerprint({ ...base, tables: withCount })).not.toBe(fp);
    expect(graphFingerprint({ ...base, tables: withTime })).not.toBe(fp);
    expect(graphFingerprint({ ...base, tables: emptied })).not.toBe(fp);
  });
});
