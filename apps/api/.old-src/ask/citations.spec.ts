import {
  citationSourceRequest,
  loadCitationSources,
  mapCitations,
  parseCitationMarkers,
  type CitationSources,
  type EvidenceSource,
} from './citations';
import { askCitationSchema } from './dto/ask.dto';
import { HandleRegistry } from './tools/handle-registry';

const ENT = '11111111-1111-4111-8111-111111111111';
const EV = '22222222-2222-4222-8222-222222222222';
const ITM = '33333333-3333-4333-8333-333333333333';
const REL = '44444444-4444-4444-8444-444444444444';
const DOC = '55555555-5555-4555-8555-555555555555';
const EV_OF_ITEM = '66666666-6666-4666-8666-666666666666';

function registry() {
  const r = new HandleRegistry();
  r.register({ kind: 'ent', id: ENT, label: 'Acme' }); // ent1
  r.register({ kind: 'ev', id: EV }); // ev1
  r.register({ kind: 'itm', id: ITM, label: 'Send the deck' }); // itm1
  r.register({ kind: 'rel', id: REL, label: 'WORKS_AT' }); // rel1
  r.register({ kind: 'doc', id: DOC, label: 'Weekly sync', documentKind: 'transcript', startMs: 61_000 }); // doc1
  return r;
}

const source = (evidenceId: string, over: Partial<EvidenceSource> = {}): EvidenceSource => ({
  evidenceId,
  label: 'Weekly sync',
  documentKind: 'transcript',
  startMs: 12_000,
  ...over,
});

describe('parseCitationMarkers (#378)', () => {
  it('returns distinct markers in first-appearance order', () => {
    expect(parseCitationMarkers('A[^ev1] b[^ent1]. C[^ev1][^doc2] [^itm10] [^rel3]')).toEqual([
      'ev1',
      'ent1',
      'doc2',
      'itm10',
      'rel3',
    ]);
  });

  it('ignores text that only looks like a marker', () => {
    expect(parseCitationMarkers('[^foo1] [ev1] [^ev] ^ev2 [^EV1]')).toEqual([]);
  });

  it('parses a malformed counter (it is then invalid, not dropped)', () => {
    expect(parseCitationMarkers('x[^ev0]')).toEqual(['ev0']);
  });
});

describe('citationSourceRequest', () => {
  it('asks only for issued ev/itm/rel handles', () => {
    expect(citationSourceRequest(['ev1', 'itm1', 'rel1', 'ent1', 'doc1', 'ev9'], registry())).toEqual({
      evidenceIds: [EV],
      itemIds: [ITM],
      relationIds: [REL],
    });
  });
});

describe('mapCitations', () => {
  const sources: CitationSources = {
    evidence: new Map([[EV, source(EV)]]),
    firstEvidence: new Map([[`item:${ITM}`, source(EV_OF_ITEM, { documentKind: 'note', startMs: null, label: 'Notes' })]]),
  };

  it('maps every kind, validates against the turn registry, and matches the wire schema', () => {
    const out = mapCitations(['ent1', 'ev1', 'doc1', 'itm1', 'rel1', 'ev7', 'ent0'], registry(), sources);
    for (const c of out) expect(askCitationSchema.safeParse(c).success).toBe(true);

    expect(out[0]).toEqual({
      marker: 'ent1',
      kind: 'entity',
      id: ENT,
      via: null,
      valid: true,
      label: 'Acme',
      documentKind: null,
      startMs: null,
    });
    expect(out[1]).toMatchObject({ marker: 'ev1', kind: 'evidence', id: EV, valid: true, startMs: 12_000, via: null });
    expect(out[2]).toMatchObject({
      marker: 'doc1',
      kind: 'document',
      id: DOC,
      valid: true,
      label: 'Weekly sync',
      documentKind: 'transcript',
      startMs: 61_000,
    });
    // itm → its first evidence, with `via`.
    expect(out[3]).toMatchObject({
      marker: 'itm1',
      kind: 'evidence',
      id: EV_OF_ITEM,
      valid: true,
      via: { kind: 'item', id: ITM },
      documentKind: 'note',
    });
    // rel with no evidence row → invalid.
    expect(out[4]).toMatchObject({ marker: 'rel1', kind: 'evidence', id: null, valid: false, via: null });
    // Never issued this turn → invalid, id null.
    expect(out[5]).toEqual({
      marker: 'ev7',
      kind: 'evidence',
      id: null,
      via: null,
      valid: false,
      label: null,
      documentKind: null,
      startMs: null,
    });
    expect(out[6]).toMatchObject({ marker: 'ent0', kind: 'entity', valid: false, id: null });
  });

  it('marks an issued evidence handle invalid once its row is gone', () => {
    const [c] = mapCitations(['ev1'], registry(), { evidence: new Map(), firstEvidence: new Map() });
    expect(c).toMatchObject({ valid: false, id: null });
  });
});

describe('loadCitationSources', () => {
  it('reads nothing when nothing needs reading', async () => {
    const prisma = { $queryRaw: jest.fn() };
    const out = await loadCitationSources(prisma, ENT, { evidenceIds: [], itemIds: [], relationIds: [] });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(out.evidence.size + out.firstEvidence.size).toBe(0);
  });

  it('splits rows by key into evidence and first-evidence maps, owner-scoped in the statement', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        { key: EV, evidenceId: EV, transcriptId: DOC, noteId: null, startMs: 5, transcriptTitle: 'Sync', noteTitle: null },
        {
          key: `relation:${REL}`,
          evidenceId: EV_OF_ITEM,
          transcriptId: null,
          noteId: DOC,
          startMs: null,
          transcriptTitle: null,
          noteTitle: 'Notes',
        },
      ]),
    };
    const out = await loadCitationSources(prisma, ENT, { evidenceIds: [EV], itemIds: [], relationIds: [REL] });
    expect(out.evidence.get(EV)).toEqual({ evidenceId: EV, label: 'Sync', documentKind: 'transcript', startMs: 5 });
    expect(out.firstEvidence.get(`relation:${REL}`)).toEqual({
      evidenceId: EV_OF_ITEM,
      label: 'Notes',
      documentKind: 'note',
      startMs: null,
    });
    const sql = prisma.$queryRaw.mock.calls[0][0] as { sql: string; values: unknown[] };
    expect(sql.sql).toContain('ev.owner_id =');
    expect(sql.values).toContain(ENT);
  });
});
