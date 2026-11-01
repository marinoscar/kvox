import { mergeChunkResults, type ChunkOutcome } from './merge-chunks.js';
import type { EvidenceDraft, ProposedRow } from './validate.js';

const note = (start: number, quote = 'q'): EvidenceDraft => ({
  source: 'note',
  noteId: 'n1',
  noteVersion: 1,
  charStart: start,
  charEnd: start + quote.length,
  quote,
});

const entity = (ref: string, type: string, label: string, ev: EvidenceDraft[], aliases: string[] = []): ProposedRow => ({
  kind: 'entity',
  payload: { ref, type, label, aliases, props: {}, occurredAt: null },
  resolution: null,
  flags: [],
  evidence: ev,
});

const relation = (type: string, from: string, to: string, ev: EvidenceDraft[]): ProposedRow => ({
  kind: 'relation',
  payload: { ref: 'r1', type, from: { ref: from }, to: { ref: to }, props: {}, validFrom: null, validTo: null, precision: 'unknown' },
  resolution: null,
  flags: [],
  evidence: ev,
});

const item = (statement: string, hash: string, subject: string, ev: EvidenceDraft[]): ProposedRow =>
  ({
    kind: 'item',
    payload: {
      ref: 'i1', kind: 'decision', title: 't', statement, subject: { ref: subject }, owner: null, counterparty: null,
      meeting: { ref: 'meeting' }, status: null, occurredAt: null, dueAt: null, sensitivity: null, statementHash: hash,
      props: {}, validFrom: null, validTo: null, precision: 'unknown',
    },
    resolution: null,
    flags: [],
    evidence: ev,
  }) as unknown as ProposedRow;

const stats = (over: Partial<ChunkOutcome['stats']['dropped']> = {}) => ({
  proposed: { entities: 0, relations: 0, items: 0 },
  dropped: { uncited: 0, invalid: 0, unknownType: 0, dangling: 0, ...over },
  quoteNotLocated: 0,
});

describe('mergeChunkResults (#777)', () => {
  const a: ChunkOutcome = {
    rows: [
      entity('e1', 'Organization', 'Org Alpha', [note(10)]),
      entity('e2', 'Person', 'Person A', [note(20)], ['PA']),
      relation('WORKS_FOR', 'e2', 'e1', [note(30)]),
      item('Use plan one.', 'h1', 'e1', [note(40)]),
    ],
    topics: ['alpha'],
    stats: stats({ uncited: 1 }),
  };
  const b: ChunkOutcome = {
    rows: [
      entity('e1', 'Person', 'pa', [note(500)]), // alias match of Person A under a different local ref
      entity('e2', 'Organization', 'ORG ALPHA', [note(510)]),
      entity('e3', 'Project', 'Project P1', [note(520)]),
      relation('WORKS_FOR', 'e1', 'e2', [note(530)]),
      relation('INVOLVED_IN', 'e1', 'e3', [note(540)]),
      item('Use plan one.', 'h1', 'e2', [note(550)]),
    ],
    topics: ['alpha', 'beta'],
    stats: stats({ dangling: 2 }),
  };

  it('dedupes entities by type + normalized label/alias, unions evidence and aliases', () => {
    const out = mergeChunkResults([a, b]);
    const entities = out.rows.filter((r) => r.kind === 'entity');
    expect(entities.map((e) => (e.payload as { label: string }).label)).toEqual(['Org Alpha', 'Person A', 'Project P1']);
    expect(entities[0].evidence.map((e) => (e as { charStart: number }).charStart)).toEqual([10, 510]);
    expect((entities[1].payload as { aliases: string[] }).aliases).toEqual(['PA', 'pa']);
  });

  it('does not merge the same label across different types', () => {
    const out = mergeChunkResults([
      { rows: [entity('e1', 'Project', 'Product X', [note(1)])], topics: [], stats: stats() },
      { rows: [entity('e1', 'Product', 'Product X', [note(2)])], topics: [], stats: stats() },
    ]);
    expect(out.rows).toHaveLength(2);
  });

  it('renumbers refs and re-points relations and items to the merged refs', () => {
    const out = mergeChunkResults([a, b]);
    const relations = out.rows.filter((r) => r.kind === 'relation');
    // WORKS_FOR is identical in both chunks after re-pointing: one row, two pieces of evidence.
    expect(relations).toHaveLength(2);
    expect(relations[0].payload).toEqual(expect.objectContaining({ ref: 'r1', from: { ref: 'e2' }, to: { ref: 'e1' } }));
    expect(relations[0].evidence).toHaveLength(2);
    expect(relations[1].payload).toEqual(expect.objectContaining({ ref: 'r2', type: 'INVOLVED_IN', from: { ref: 'e2' }, to: { ref: 'e3' } }));
    const items = out.rows.filter((r) => r.kind === 'item');
    expect(items).toHaveLength(1);
    expect(items[0].evidence).toHaveLength(2);
    expect((items[0].payload as { subject: unknown }).subject).toEqual({ ref: 'e1' });
  });

  it('merges a re-stated known entity by its k# ref and leaves entityId endpoints alone', () => {
    const k = (start: number) => entity('k1', 'Person', 'Person A', [note(start)]);
    const withId: ProposedRow = {
      ...(relation('WORKS_FOR', 'e1', 'e1', [note(9)]) as Extract<ProposedRow, { kind: 'relation' }>),
    };
    (withId as Extract<ProposedRow, { kind: 'relation' }>).payload = {
      ...(withId.payload as object),
      from: { entityId: 'id-1' },
      to: { ref: 'e1' },
    } as never;
    const out = mergeChunkResults([
      { rows: [k(1), entity('e1', 'Organization', 'Org Alpha', [note(2)]), withId], topics: [], stats: stats() },
      { rows: [k(100)], topics: [], stats: stats() },
    ]);
    const known = out.rows.filter((r) => r.kind === 'entity' && r.payload.ref === 'k1');
    expect(known).toHaveLength(1);
    expect(known[0].evidence).toHaveLength(2);
    const rel = out.rows.find((r) => r.kind === 'relation')!;
    expect((rel.payload as { from: unknown }).from).toEqual({ entityId: 'id-1' });
  });

  it('drops a relation whose endpoints merged into one entity', () => {
    const out = mergeChunkResults([
      {
        rows: [entity('e1', 'Person', 'Person A', [note(1)]), entity('e2', 'Person', 'pa', [note(2)], ['Person A']), relation('KNOWS', 'e1', 'e2', [note(3)])],
        topics: [],
        stats: stats(),
      },
    ]);
    expect(out.rows.filter((r) => r.kind === 'relation')).toHaveLength(0);
    expect(out.stats.dropped.invalid).toBe(1);
  });

  it('sums dropped counts, unions topics and recounts proposed rows', () => {
    const out = mergeChunkResults([a, b]);
    expect(out.stats.dropped).toEqual({ uncited: 1, invalid: 0, unknownType: 0, dangling: 2 });
    expect(out.topics).toEqual(['alpha', 'beta']);
    expect(out.stats.proposed).toEqual({ entities: 3, relations: 2, items: 1 });
  });
});
